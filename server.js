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
  res.json({ status: "SEO Map API is running", version: "0.3.0" });
});

// Cache discovery results in memory to avoid repeatedly querying public data services.
const businessCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

app.get("/api/businesses", async (req, res) => {
  const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
  if (!city || city.length > 100) {
    return res.status(400).json({ error: "Indtast en by på højst 100 tegn, fx Aarhus." });
  }

  const cacheKey = city.toLowerCase();
  const cached = businessCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return res.json(cached.payload);
  }

  try {
    const geocodeUrl = new URL("https://nominatim.openstreetmap.org/search");
    geocodeUrl.searchParams.set("q", city);
    geocodeUrl.searchParams.set("format", "jsonv2");
    geocodeUrl.searchParams.set("addressdetails", "1");
    geocodeUrl.searchParams.set("limit", "1");

    const geocodeResponse = await fetch(geocodeUrl, {
      headers: { "User-Agent": "SEOMapPrototype/0.3 (business discovery)" },
      signal: AbortSignal.timeout(15000)
    });
    if (!geocodeResponse.ok) {
      return res.status(502).json({ error: "Korttjenesten kunne ikke finde byen lige nu. Prøv igen senere." });
    }

    const geocodeData = await geocodeResponse.json();
    if (!geocodeData.length) {
      return res.status(404).json({ error: "Vi kunne ikke finde byen. Prøv fx Aarhus, København eller London." });
    }

    const place = geocodeData[0];
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    const searchedCity = place.name || city;

    // Limit each search to a 3 km radius and businesses with a listed website.
    const query = `[out:json][timeout:25];(nwr(around:3000,${lat},${lon})["name"]["website"];nwr(around:3000,${lat},${lon})["name"]["contact:website"];);out center tags 80;`;
    const overpassResponse = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "User-Agent": "SEOMapPrototype/0.3 (business discovery)"
      },
      body: query,
      signal: AbortSignal.timeout(35000)
    });

    if (!overpassResponse.ok) {
      console.error("Overpass response:", overpassResponse.status);
      return res.status(502).json({
        error: "Virksomhedsdatabasen er midlertidigt belastet. Vent lidt, og prøv igen."
      });
    }

    const overpassData = await overpassResponse.json();
    const seen = new Set();
    const businesses = [];

    for (const element of (overpassData.elements || [])) {
      const tags = element.tags || {};
      const name = tags.name;
      let website = tags.website || tags["contact:website"];
      if (!name || !website) continue;

      website = String(website).trim();
      if (!/^https?:\/\//i.test(website)) website = "https://" + website;
      try {
        const parsed = new URL(website);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
        website = parsed.href;
      } catch {
        continue;
      }

      const key = website.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const latitude = Number(element.lat ?? element.center?.lat);
      const longitude = Number(element.lon ?? element.center?.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

      const industry =
        tags.shop || tags.office || tags.craft || tags.amenity ||
        tags.tourism || tags.industrial || tags.leisure || "Virksomhed";

      businesses.push({
        id: `${element.type}-${element.id}`,
        name,
        city: tags["addr:city"] || searchedCity,
        country: place.address?.country || "",
        lat: latitude,
        lng: longitude,
        website,
        phone: tags.phone || tags["contact:phone"] || "",
        email: tags.email || tags["contact:email"] || "",
        industry: String(industry).replace(/_/g, " ")
      });

      if (businesses.length >= 80) break;
    }

    const payload = { searchedCity, count: businesses.length, businesses };
    businessCache.set(cacheKey, { savedAt: Date.now(), payload });
    return res.json(payload);
  } catch (error) {
    console.error("Business discovery failed:", error.message);
    return res.status(502).json({
      error: error.name === "TimeoutError"
        ? "Søgningen tog for lang tid. Prøv igen om lidt."
        : "Der opstod en fejl under søgningen efter virksomheder."
    });
  }
});

app.get("/api/seo", async (req, res) => {
  const inputUrl = req.query.url;
  if (typeof inputUrl !== "string" || !inputUrl.trim()) {
    return res.status(400).json({ error: "Angiv en URL, fx ?url=https://example.com" });
  }

  let website;
  try {
    website = new URL(inputUrl);
    if (!["http:", "https:"].includes(website.protocol) ||
        !website.hostname || website.username || website.password) {
      throw new Error("Invalid URL");
    }
  } catch {
    return res.status(400).json({ error: "Ugyldig hjemmesideadresse. Brug en HTTP- eller HTTPS-URL." });
  }

  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "PAGESPEED_API_KEY mangler i Render Environment." });
  }

  try {
    const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    endpoint.searchParams.set("url", website.href);
    endpoint.searchParams.set("key", apiKey);
    endpoint.searchParams.append("category", "SEO");
    endpoint.searchParams.append("category", "PERFORMANCE");
    endpoint.searchParams.set("strategy", "mobile");

    const response = await fetch(endpoint, { signal: AbortSignal.timeout(60000) });
    const data = await response.json();

    if (!response.ok) {
      console.error("PageSpeed API error:", response.status, data.error?.message || "Unknown error");
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
      performanceScore: typeof performanceScore === "number" ? Math.round(performanceScore * 100) : null,
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
