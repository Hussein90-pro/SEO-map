const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "10kb" }));

const businessCache = new Map();
const seoCache = new Map();
const googleVisibilityCache = new Map();

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

let databaseReady = false;

async function initDatabase() {
  if (!pool) throw new Error("DATABASE_URL mangler i Render Environment.");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitored_sites (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMPTZ,
      latest JSONB,
      history JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);

  databaseReady = true;
  console.log("SEO Map PostgreSQL database ready");
}

function ensureDatabase(res) {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_URL mangler i Render Environment." });
    return false;
  }
  if (!databaseReady) {
    res.status(503).json({ error: "Databasen klargøres stadig. Prøv igen om lidt." });
    return false;
  }
  return true;
}

function rowToSite(row) {
  return {
    id: row.id,
    url: row.url,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    latest: row.latest || null,
    history: Array.isArray(row.history) ? row.history : []
  };
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const LIVE_CHECK_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.LIVE_CHECK_INTERVAL_MS) || 60 * 60 * 1000
);

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

function getDomain(value) {
  const normalized = normalizeWebsite(value);
  if (!normalized) return "";

  const hostname = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "localhost" || hostname.endsWith(".local") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
      !hostname.includes(".") || !/^[a-z0-9.-]+$/.test(hostname) ||
      hostname.includes("..")) return "";
  return hostname;
}

function getDataForSeoAuth() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return "";
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

// Virksomhedssøgning
app.get("/api/businesses", async (req, res) => {
  const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
  if (!city || city.length > 100) {
    return res.status(400).json({ error: "Indtast en by på højst 100 tegn, fx Aarhus." });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEOAPIFY_API_KEY mangler i Render Environment." });
  }

  const cacheKey = city.toLowerCase();
  const cached = businessCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return res.json(cached.payload);

  try {
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
        error: "Vi kunne ikke finde byen. Prøv Aarhus, København eller London."
      });
    }

    const lat = Number(place.lat);
    const lon = Number(place.lon);
    const searchedCity = place.city || place.name || city;

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
      const website = normalizeWebsite(
        props.website || props.datasource?.raw?.website || props.datasource?.raw?.contact_website
      );
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
      const industry = category.find(item => typeof item === "string") || "Virksomhed";

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
        ? "Ingen virksomheder med hjemmeside blev fundet. Prøv en større by."
        : undefined
    };

    businessCache.set(cacheKey, { savedAt: Date.now(), payload });
    return res.json(payload);
  } catch (error) {
    console.error("Geoapify business discovery failed:", error.message);
    return res.status(502).json({
      error: error.status === 401 || error.status === 403
        ? "Geoapify afviste API-nøglen. Kontrollér GEOAPIFY_API_KEY."
        : error.name === "TimeoutError"
          ? "Søgningen tog for lang tid. Prøv igen."
          : "Fejl under søgningen efter virksomheder."
    });
  }
});
