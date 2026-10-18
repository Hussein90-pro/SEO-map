const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "SEO Map API is running", version: "0.3.1" });
});

const businessCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function normalizeWebsite(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let website = value.trim();
  if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
  try {
    const parsed = new URL(website);
    if (!["http:", "https:"].includes(parsed.protocol) ||
        !parsed.hostname || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

app.get("/api/businesses", async (req, res) => {
  const city = typeof req.query.city === "string" ? req.query.city.trim() : "";

  if (!city || city.length > 100) {
    return res.status(400).json({
      error: "Indtast en by på højst 100 tegn, fx Aarhus."
    });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "GEOAPIFY_API_KEY mangler i Render Environment."
    });
  }

  const cacheKey = city.toLowerCase();
  const cached = businessCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return res.json(cached.payload);
  }

  try {
    // Find byens centrum using Geoapify's Geocoding API.
    const geocodeUrl = new URL("https://api.geoapify.com/v1/geocode/search");
    geocodeUrl.searchParams.set("text", city);
    geocodeUrl.searchParams.set("type", "city");
    geocodeUrl.searchParams.set("limit", "1");
    geocodeUrl.searchParams.set("format", "json");
    geocodeUrl.searchParams.set("apiKey", apiKey);

    const geocodeData = await fetchJson(geocodeUrl, {}, 15000);
    const place = geocodeData.results?.[0];
    if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) {
      return res.status(404).json({
        error: "Vi kunne ikke finde byen. Prøv fx Aarhus, København eller London."
      });
    }

    const lat = Number(place.lat);
    const lon = Number(place.lon);
    const searchedCity = place.city || place.name || city;

    // Search a manageable area around the city centre. Geoapify returns GeoJSON.
    const placesUrl = new URL("https://api.geoapify.com/v2/places");
    placesUrl.searchParams.set("categories", "commercial,office,catering,service,accommodation,activity");
    placesUrl.searchParams.set("filter", `circle:${lon},${lat},5000`);
    placesUrl.searchParams.set("bias", `proximity:${lon},${lat}`);
    placesUrl.searchParams.set("limit", "100");
    placesUrl.searchParams.set("lang", "en");
    placesUrl.searchParams.set("apiKey", apiKey);

    const placesData = await fetchJson(placesUrl, {}, 20000);
    const features = Array.isArray(placesData.features) ? placesData.features : [];
    const seen = new Set();
    const businesses = [];

    for (const feature of features) {
      const props = feature.properties || {};
      const name = props.name || props.address_line1;
      const website = normalizeWebsite(props.website || props.datasource?.raw?.website || props.datasource?.raw?.contact_website);
      if (!name || !website) continue;

      const websiteKey = website.toLowerCase();
      if (seen.has(websiteKey)) continue;
      seen.add(websiteKey);

      const coords = feature.geometry?.coordinates || [];
      const longitude = Number(coords[0] ?? props.lon);
      const latitude = Number(coords[1] ?? props.lat);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

      const raw = props.datasource?.raw || {};
      const category = Array.isArray(props.categories) ? props.categories : [];
      const industry = category.find((item) => typeof item === "string") || "Virksomhed";

      businesses.push({
        id: String(props.place_id || `${name}-${latitude}-${longitude}`),
        name: String(name),
        city: props.city || searchedCity,
        country: props.country || place.country || "",
        lat: latitude,
        lng: longitude,
        website,
        phone: props.contact?.phone || props.phone || raw.phone || raw.contact_phone || "",
        email: props.contact?.email || props.email || raw.email || raw.contact_email || "",
        industry: String(industry).replace(/_/g, " ").replace(/\./g, " · ")
      });

      if (businesses.length >= 40) break;
    }

    const payload = {
      searchedCity,
      count: businesses.length,
      businesses,
      source: "Geoapify Places API",
      note: businesses.length === 0
        ? "Geoapify fandt steder i området, men ingen med en tilgængelig hjemmeside. Prøv en større by."
        : undefined
    };

    businessCache.set(cacheKey, { savedAt: Date.now(), payload });
    return res.json(payload);
  } catch (error) {
    console.error("Geoapify business discovery failed:", error.message);
    return res.status(502).json({
      error: error.status === 401 || error.status === 403
        ? "Geoapify afviste API-nøglen. Kontrollér GEOAPIFY_API_KEY i Render Environment."
        : error.name === "TimeoutError"
          ? "Søgningen tog for lang tid. Prøv igen om lidt."
          : "Der opstod en fejl under søgningen efter virksomheder via Geoapify."
    });
  }
});

app.get("/api/seo", async (req, res) => {
  const inputUrl = req.query.url;

  if (typeof inputUrl !== "string" || !inputUrl.trim()) {
    return res.status(400).json({
      error: "Angiv en URL, fx ?url=https://example.com"
    });
  }

  let website;

  try {
    website = new URL(inputUrl);
    if (!["http:", "https:"].includes(website.protocol) ||
        !website.hostname || website.username || website.password) {
      throw new Error("Invalid URL");
    }
  } catch {
    return res.status(400).json({
      error: "Ugyldig hjemmesideadresse. Brug en HTTP- eller HTTPS-URL."
    });
  }

  const apiKey = process.env.PAGESPEED_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "PAGESPEED_API_KEY mangler i Render Environment."
    });
  }

  try {
    const endpoint = new URL(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    );
    endpoint.searchParams.set("url", website.href);
    endpoint.searchParams.set("key", apiKey);
    endpoint.searchParams.append("category", "SEO");
    endpoint.searchParams.append("category", "PERFORMANCE");
    endpoint.searchParams.set("strategy", "mobile");

    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(60000)
    });
    const data = await response.json();

    if (!response.ok) {
      console.error(
        "PageSpeed API error:",
        response.status,
        data.error?.message || "Unknown error"
      );
      return res.status(502).json({
        error: "Google kunne ikke analysere hjemmesiden.",
        googleStatus: response.status,
        details: data.error?.message || "Ukendt Google API-fejl"
      });
    }

    const categories = data.lighthouseResult?.categories || {};
    const seoScore = categories.seo?.score;
    const performanceScore = categories.performance?.score;

    return res.json({
      url: website.href,
      seoScore: typeof seoScore === "number" ? Math.round(seoScore * 100) : null,
      performanceScore: typeof performanceScore === "number"
        ? Math.round(performanceScore * 100)
        : null,
      availableCategories: Object.keys(categories),
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("SEO analysis failed:", error.message);
    return res.status(500).json({
      error: error.name === "TimeoutError"
        ? "Google-analysen tog for lang tid. Prøv igen."
        : "Der opstod en fejl under SEO-analysen."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SEO Map API listening on port ${PORT}`);
});
