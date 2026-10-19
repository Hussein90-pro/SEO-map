"use strict";

const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const VERSION = "0.8.0";

app.use(express.json({ limit: "20kb" }));

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    process.env.FRONTEND_ORIGIN || "*"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,DELETE,OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : undefined
    })
  : null;

let databaseReady = false;
let scheduledCheckRunning = false;

const businessCache = new Map();
const seoCache = new Map();
const visibilityCache = new Map();

const BUSINESS_CACHE_MS = 10 * 60 * 1000;
const SEO_CACHE_MS = 60 * 60 * 1000;
const VISIBILITY_CACHE_MS = 24 * 60 * 60 * 1000;

const CHECK_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.LIVE_CHECK_INTERVAL_MS) || 60 * 60 * 1000
);

// --------------------------------------------------
// DATABASE
// --------------------------------------------------

async function initDatabase() {
  if (!pool) {
    throw new Error("DATABASE_URL mangler i Render Environment.");
  }

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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS monitored_sites_last_checked_idx
    ON monitored_sites (last_checked_at)
  `);

  databaseReady = true;
  console.log("SEO Map PostgreSQL database ready");
}

function requireDatabase(res) {
  if (!pool) {
    res.status(503).json({
      error: "DATABASE_URL mangler i Render Environment."
    });
    return false;
  }

  if (!databaseReady) {
    res.status(503).json({
      error: "Databasen klargøres. Prøv igen om lidt."
    });
    return false;
  }

  return true;
}

function rowToSite(row) {
  return {
    id: row.id,
    url: row.url,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    latest: row.latest || null,
    history: Array.isArray(row.history) ? row.history : []
  };
}

// --------------------------------------------------
// COMMON HELPERS
// --------------------------------------------------

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.message || data.error || `HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  let input = value.trim();

  if (!/^https?:\/\//i.test(input)) {
    input = "https://" + input;
  }

  try {
    const url = new URL(input);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return "";
    }

    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function domainOf(value) {
  const url = normalizeUrl(value);
  if (!url) return "";

  const hostname = new URL(url)
    .hostname.toLowerCase()
    .replace(/^www\./, "");

  if (
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.includes("..")
  ) {
    return "";
  }

  return hostname;
}

function siteId(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

function cacheGet(cache, key, ttl) {
  const item = cache.get(key);

  if (item && Date.now() - item.time < ttl) {
    return item.data;
  }

  if (item) cache.delete(key);
  return null;
}

function cacheSet(cache, key, data) {
  cache.set(key, {
    time: Date.now(),
    data
  });
}

function getDataForSeoAuth() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) return "";

  return "Basic " +
    Buffer.from(`${login}:${password}`).toString("base64");
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "SEO Map API is running",
    version: VERSION,
    database: databaseReady ? "connected" : "initializing",
    features: [
      "business-search",
      "businesses-in-view",
      "pagespeed-seo",
      "site-score",
      "automatic-seo-analysis",
      "seo-monitoring",
      "postgres-history",
      "improvement-proposals",
      "google-visibility"
    ]
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    database: databaseReady ? "connected" : "initializing"
  });
});

// --------------------------------------------------
// BUSINESS SEARCH BY CITY
// GET /api/businesses?city=Aarhus
// --------------------------------------------------

app.get("/api/businesses", async (req, res) => {
  const city =
    typeof req.query.city === "string"
      ? req.query.city.trim()
      : "";

  if (!city || city.length > 100) {
    return res.status(400).json({
      error: "Angiv en gyldig by."
    });
  }

  const cached = cacheGet(
    businessCache,
    "city:" + city.toLowerCase(),
    BUSINESS_CACHE_MS
  );

  if (cached) return res.json(cached);

  const apiKey = process.env.GEOAPIFY_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "GEOAPIFY_API_KEY mangler i Render."
    });
  }

  try {
    const geocodeUrl = new URL(
      "https://api.geoapify.com/v1/geocode/search"
    );

    geocodeUrl.searchParams.set("text", city);
    geocodeUrl.searchParams.set("type", "city");
    geocodeUrl.searchParams.set("limit", "1");
    geocodeUrl.searchParams.set("format", "json");
    geocodeUrl.searchParams.set("apiKey", apiKey);

    const geo = await fetchJson(geocodeUrl);
    const place = geo.results?.[0];

    if (!place) {
      return res.status(404).json({
        error: "Byen blev ikke fundet."
      });
    }

    const lat = Number(place.lat);
    const lon = Number(place.lon);

    const url = new URL("https://api.geoapify.com/v2/places");

    // Kun gyldige kategorier – retail er fjernet.
    url.searchParams.set(
      "categories",
      "commercial,office,catering,service,accommodation,healthcare,education,leisure"
    );
    url.searchParams.set("filter", `circle:${lon},${lat},5000`);
    url.searchParams.set("bias", `proximity:${lon},${lat}`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("apiKey", apiKey);

    const data = await fetchJson(url);
    const seen = new Set();
    const businesses = [];

    for (const feature of data.features || []) {
      const p = feature.properties || {};
      const raw = p.datasource?.raw || {};
      const name = p.name || p.address_line1;

      const website = normalizeUrl(
        p.website || raw.website || raw.contact_website
      );

      const coords = feature.geometry?.coordinates || [];
      const lng = Number(coords[0] ?? p.lon);
      const latitude = Number(coords[1] ?? p.lat);

      if (
        !name ||
        !website ||
        !Number.isFinite(lng) ||
        !Number.isFinite(latitude)
      ) {
        continue;
      }

      const key = website.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      businesses.push({
        id: String(p.place_id || `${name}-${latitude}-${lng}`),
        name,
        city: p.city || place.city || city,
        country: p.country || place.country || "",
        industry: (p.categories || [])
          .join(", ")
          .replace(/[_\.]/g, " "),
        website,
        lat: latitude,
        lng,
        phone: p.contact?.phone || p.phone || raw.phone || "",
        address: p.formatted || "",
        score: null,
        performanceScore: null,
        analyzed: false
      });

      if (businesses.length >= 100) break;
    }

    const result = {
      count: businesses.length,
      businesses,
      source: "Geoapify Places API",
      note: "Resultater afhænger af datakildens dækning."
    };

    cacheSet(
      businessCache,
      "city:" + city.toLowerCase(),
      result
    );

    return res.json(result);
  } catch (error) {
    console.error("By-søgning fejlede:", error.message);

    return res.status(502).json({
      error: "Kunne ikke hente virksomheder fra Geoapify."
    });
  }
});

// --------------------------------------------------
// BUSINESSES INSIDE THE VISIBLE MAP AREA
// GET /api/businesses-in-view?west=...&south=...&east=...&north=...
// --------------------------------------------------

app.get("/api/businesses-in-view", async (req, res) => {
  const west = Number(req.query.west);
  const south = Number(req.query.south);
  const east = Number(req.query.east);
  const north = Number(req.query.north);

  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    return res.status(400).json({
      error: "Angiv et gyldigt kortområde."
    });
  }

  if (
    (east - west) * (north - south) > 100 ||
    east - west > 30 ||
    north - south > 20
  ) {
    return res.json({
      count: 0,
      businesses: [],
      zoomInRequired: true,
      note: "Zoom længere ind for at hente virksomheder."
    });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "GEOAPIFY_API_KEY mangler i Render."
    });
  }

  const boundsKey = [west, south, east, north]
    .map(n => n.toFixed(3))
    .join(",");

  const cached = cacheGet(
    businessCache,
    "bbox:" + boundsKey,
    BUSINESS_CACHE_MS
  );

  if (cached) return res.json(cached);

  try {
    const url = new URL("https://api.geoapify.com/v2/places");

    // Samme rettelse i kortsøgningen: retail er fjernet.
    url.searchParams.set(
      "categories",
      "commercial,office,catering,service,accommodation,healthcare,education,leisure"
    );
    url.searchParams.set(
      "filter",
      `rect:${west},${south},${east},${north}`
    );
    url.searchParams.set("limit", "100");
    url.searchParams.set("apiKey", apiKey);

    const data = await fetchJson(url, {}, 30000);
    const seen = new Set();
    const businesses = [];

    for (const feature of data.features || []) {
      const p = feature.properties || {};
      const raw = p.datasource?.raw || {};
      const name = p.name || p.address_line1;

      const website = normalizeUrl(
        p.website || raw.website || raw.contact_website
      );

      const coords = feature.geometry?.coordinates || [];
      const lng = Number(coords[0] ?? p.lon);
      const lat = Number(coords[1] ?? p.lat);

      if (
        !name ||
        !website ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      ) {
        continue;
      }

      const key = website.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      businesses.push({
        id: String(p.place_id || `${name}-${lat}-${lng}`),
        name: String(name),
        city: p.city || p.county || "",
        country: p.country || "",
        industry: (p.categories || [])
          .join(", ")
          .replace(/[_\.]/g, " "),
        website,
        lat,
        lng,
        phone: p.contact?.phone || p.phone || raw.phone || "",
        address: p.formatted || "",
        score: null,
        performanceScore: null,
        analyzed: false
      });
    }

    const result = {
      count: businesses.length,
      businesses,
      source: "Geoapify Places API",
      note:
        "Virksomheder afhænger af datakildens dækning. Ikke alle virksomheder globalt er registreret eller har en hjemmeside."
    };

    cacheSet(businessCache, "bbox:" + boundsKey, result);
    return res.json(result);
  } catch (error) {
    console.error("Kortområdesøgning fejlede:", error.message);

    return res.status(502).json({
      error: "Kunne ikke hente virksomheder for kortområdet."
    });
  }
});

// --------------------------------------------------
// GOOGLE PAGESPEED SEO ANALYSIS
// --------------------------------------------------

async function runPageSpeed(value) {
  const website = normalizeUrl(value);

  if (!website || !domainOf(website)) {
    throw new Error("Angiv en gyldig offentlig hjemmeside.");
  }

  const cached = cacheGet(seoCache, website, SEO_CACHE_MS);
  if (cached) return cached;

  const url = new URL(
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
  );

  url.searchParams.set("url", website);
  url.searchParams.set("strategy", "mobile");
  url.searchParams.append("category", "SEO");
  url.searchParams.append("category", "PERFORMANCE");

  if (process.env.PAGESPEED_API_KEY) {
    url.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  }

  const data = await fetchJson(url, {}, 60000);
  const categories = data.lighthouseResult?.categories || {};

  const record = {
    url: website,
    domain: domainOf(website),
    source: "Google PageSpeed Insights",
    dataType: "Teknisk Lighthouse-måling",
    seoScore:
      typeof categories.seo?.score === "number"
        ? Math.round(categories.seo.score * 100)
        : null,
    performanceScore:
      typeof categories.performance?.score === "number"
        ? Math.round(categories.performance.score * 100)
        : null,
    fetchedAt: new Date().toISOString(),
    title: data.lighthouseResult?.requestedUrl || website
  };

  cacheSet(seoCache, website, record);
  return record;
}

app.get("/api/seo", async (req, res) => {
  const website = normalizeUrl(req.query.url);

  if (!website || !domainOf(website)) {
    return res.status(400).json({
      error: "Angiv en gyldig hjemmesideadresse."
    });
  }

  try {
    return res.json(await runPageSpeed(website));
  } catch (error) {
    console.error("SEO-analyse fejlede:", error.message);

    return res.status(502).json({
      error:
        error.message === "PAGESPEED_API_KEY mangler i Render."
          ? error.message
          : "SEO-analysen kunne ikke gennemføres lige nu."
    });
  }
});

// --------------------------------------------------
// GET PREVIOUSLY SAVED SCORE
// GET /api/site-score?url=https://example.com
// --------------------------------------------------

app.get("/api/site-score", async (req, res) => {
  if (!requireDatabase(res)) return;

  const website = normalizeUrl(req.query.url);

  if (!website || !domainOf(website)) {
    return res.status(400).json({
      error: "Angiv en gyldig hjemmesideadresse."
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, url, latest, last_checked_at, history
       FROM monitored_sites
       WHERE url = $1`,
      [website]
    );

    if (!result.rowCount) {
      return res.json({
        found: false,
        url: website,
        latest: null
      });
    }

    const row = result.rows[0];

    return res.json({
      found: Boolean(row.latest),
      id: row.id,
      url: row.url,
      latest: row.latest || null,
      lastCheckedAt: row.last_checked_at,
      history: Array.isArray(row.history) ? row.history : []
    });
  } catch (error) {
    console.error("Hentning af SEO-score fejlede:", error.message);

    return res.status(500).json({
      error: "Kunne ikke hente SEO-resultatet."
    });
  }
});

// --------------------------------------------------
// REGISTER WEBSITE FOR MONITORING
// POST /api/monitor {"url":"https://example.com"}
// --------------------------------------------------

app.post("/api/monitor", async (req, res) => {
  if (!requireDatabase(res)) return;

  const website = normalizeUrl(req.body?.url);

  if (!website || !domainOf(website)) {
    return res.status(400).json({
      error: "Angiv en gyldig offentlig hjemmesideadresse."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO monitored_sites (id, url)
       VALUES ($1, $2)
       ON CONFLICT (url)
       DO UPDATE SET url = EXCLUDED.url
       RETURNING *`,
      [siteId(website), website]
    );

    const site = rowToSite(result.rows[0]);

    return res.status(201).json({
      id: site.id,
      url: site.url,
      monitored: true,
      intervalMs: CHECK_INTERVAL_MS,
      message: "Hjemmesiden er registreret til overvågning."
    });
  } catch (error) {
    console.error("Registrering fejlede:", error.message);

    return res.status(500).json({
      error: "Kunne ikke gemme hjemmesiden i databasen."
    });
  }
});

// --------------------------------------------------
// LIST MONITORED WEBSITES
// --------------------------------------------------

app.get("/api/monitor", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      "SELECT * FROM monitored_sites ORDER BY created_at DESC"
    );

    return res.json({
      intervalMs: CHECK_INTERVAL_MS,
      count: result.rowCount,
      sites: result.rows.map(row => {
        const site = rowToSite(row);

        return {
          id: site.id,
          url: site.url,
          createdAt: site.createdAt,
          lastCheckedAt: site.lastCheckedAt,
          latest: site.latest,
          historyCount: site.history.length
        };
      })
    });
  } catch (error) {
    console.error("Hentning af overvågning fejlede:", error.message);

    return res.status(500).json({
      error: "Kunne ikke hente overvågede hjemmesider."
    });
  }
});

// --------------------------------------------------
// GET ONE WEBSITE AND ITS HISTORY
// --------------------------------------------------

app.get("/api/monitor/:id", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      "SELECT * FROM monitored_sites WHERE id = $1",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Hjemmesiden blev ikke fundet."
      });
    }

    return res.json(rowToSite(result.rows[0]));
  } catch (error) {
    console.error("Hentning af historik fejlede:", error.message);

    return res.status(500).json({
      error: "Kunne ikke hente hjemmesidens historik."
    });
  }
});

// --------------------------------------------------
// RUN AND SAVE A NEW SEO CHECK
// --------------------------------------------------

async function checkTrackedSite(site) {
  const record = await runPageSpeed(site.url);

  const history = [
    ...(Array.isArray(site.history) ? site.history : []),
    record
  ].slice(-100);

  const result = await pool.query(
    `UPDATE monitored_sites
     SET latest = $2::jsonb,
         last_checked_at = $3,
         history = $4::jsonb
     WHERE id = $1
     RETURNING *`,
    [
      site.id,
      JSON.stringify(record),
      record.fetchedAt,
      JSON.stringify(history)
    ]
  );

  cacheSet(seoCache, site.url, record);

  return rowToSite(result.rows[0]);
}

app.post("/api/monitor/:id/check", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      "SELECT * FROM monitored_sites WHERE id = $1",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Hjemmesiden blev ikke fundet."
      });
    }

    const site = await checkTrackedSite(rowToSite(result.rows[0]));

    return res.json({
      ...site.latest,
      id: site.id,
      monitored: true
    });
  } catch (error) {
    console.error("SEO-kontrol fejlede:", error.message);

    return res.status(502).json({
      error: "Kunne ikke opdatere SEO-målingen."
    });
  }
});

// --------------------------------------------------
// DELETE A MONITORED WEBSITE
// --------------------------------------------------

app.delete("/api/monitor/:id", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      "DELETE FROM monitored_sites WHERE id = $1",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Hjemmesiden blev ikke fundet."
      });
    }

    return res.sendStatus(204);
  } catch (error) {
    console.error("Sletning fejlede:", error.message);

    return res.status(500).json({
      error: "Kunne ikke fjerne hjemmesiden."
    });
  }
});

// --------------------------------------------------
// IMPROVEMENTS AND OFFER DRAFT
// POST /api/proposal {"url":"https://example.com"}
// --------------------------------------------------

app.post("/api/proposal", async (req, res) => {
  const website = normalizeUrl(req.body?.url);

  if (!website || !domainOf(website)) {
    return res.status(400).json({
      error: "Angiv en gyldig hjemmesideadresse."
    });
  }

  try {
    const seo = await runPageSpeed(website);
    const tasks = [];

    if (seo.seoScore !== null && seo.seoScore < 90) {
      tasks.push({
        task: "Teknisk SEO-gennemgang",
        reason: `SEO-score er ${seo.seoScore}/100.`,
        suggestedAction:
          "Gennemgå indeksering, sidetitler, metabeskrivelser, mobilvenlighed og tekniske SEO-kontroller."
      });
    }

    if (
      seo.performanceScore !== null &&
      seo.performanceScore < 80
    ) {
      tasks.push({
        task: "Optimering af hastighed",
        reason: `Performance-score er ${seo.performanceScore}/100.`,
        suggestedAction:
          "Undersøg billeder, JavaScript, CSS, caching og serverens svartid."
      });
    }

    if (tasks.length === 0) {
      tasks.push({
        task: "Udvidet SEO-gennemgang",
        reason:
          "De tilgængelige tekniske målinger viser ikke alene, hvilke kommercielle forbedringer der er nødvendige.",
        suggestedAction:
          "Kontrollér søgeord, lokal synlighed, indhold, indeksering og konkurrenter før et endeligt tilbud."
      });
    }

    const draft = [
      `TILBUDSUDKAST — ${domainOf(website)}`,
      `Hjemmeside: ${website}`,
      "",
      `SEO-score: ${
        seo.seoScore === null
          ? "Ikke tilgængelig"
          : seo.seoScore + "/100"
      }`,
      `Performance-score: ${
        seo.performanceScore === null
          ? "Ikke tilgængelig"
          : seo.performanceScore + "/100"
      }`,
      "",
      "ANBEFALEDE FORBEDRINGER",
      ...tasks.map(
        (task, index) =>
          `${index + 1}. ${task.task}\n   ${task.suggestedAction}`
      ),
      "",
      "OMFANG OG PRIS",
      "Fastlæg endelig pris efter gennemgang af konkrete fejl og opgavernes omfang.",
      "",
      "Dette er et uforpligtende tilbudsudkast. Pris, leveringstid og leverancer skal godkendes før afsendelse."
    ].join("\n");

    return res.json({
      url: website,
      domain: domainOf(website),
      measuredAt: seo.fetchedAt,
      scores: {
        seo: seo.seoScore,
        performance: seo.performanceScore
      },
      tasks,
      priceEstimate: null,
      priceNote:
        "Prisen beregnes ikke automatisk ud fra en score.",
      draft
    });
  } catch (error) {
    console.error("Tilbudsforslag fejlede:", error.message);

    return res.status(502).json({
      error: "Kunne ikke oprette et tilbudsforslag."
    });
  }
});

// --------------------------------------------------
// GOOGLE VISIBILITY (OPTIONAL DATAFORSEO)
// GET /api/google-visibility?domain=example.dk
// --------------------------------------------------

app.get("/api/google-visibility", async (req, res) => {
  const domain = domainOf(req.query.domain);

  const location =
    typeof req.query.location === "string"
      ? req.query.location.trim()
      : "Denmark";

  const language =
    typeof req.query.language === "string"
      ? req.query.language.trim()
      : "Danish";

  if (!domain) {
    return res.status(400).json({
      error: "Angiv et gyldigt domæne."
    });
  }

  const auth = getDataForSeoAuth();

  if (!auth) {
    return res.status(503).json({
      error:
        "Tilføj DATAFORSEO_LOGIN og DATAFORSEO_PASSWORD i Render for at bruge denne funktion.",
      setupRequired: true
    });
  }

  const cacheKey = `${domain}:${location}:${language}`;
  const cached = cacheGet(
    visibilityCache,
    cacheKey,
    VISIBILITY_CACHE_MS
  );

  if (cached) return res.json(cached);

  try {
    const response = await fetchJson(
      "https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live",
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([
          {
            target: domain,
            location_name: location,
            language_name: language
          }
        ])
      },
      45000
    );

    const task = response.tasks?.[0];
    const result = task?.result?.[0];

    if (task?.status_code !== 20000 || !result) {
      return res.status(502).json({
        error:
          "DataForSEO returnerede ingen brugbare synlighedsdata."
      });
    }

    const payload = {
      domain,
      location,
      language,
      source: "DataForSEO",
      checkedAt: new Date().toISOString(),
      metrics: result.metrics?.organic || {},
      items: result.items || []
    };

    cacheSet(visibilityCache, cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error("Google-synlighed fejlede:", error.message);

    return res.status(502).json({
      error: "Kunne ikke hente Google-synlighedsdata."
    });
  }
});

// --------------------------------------------------
// AUTOMATIC SCHEDULED CHECKS
// Checks up to five saved sites per interval.
// --------------------------------------------------

async function runScheduledChecks() {
  if (!pool || !databaseReady || scheduledCheckRunning) {
    return;
  }

  scheduledCheckRunning = true;

  try {
    const result = await pool.query(
      `SELECT *
       FROM monitored_sites
       ORDER BY last_checked_at ASC NULLS FIRST
       LIMIT 5`
    );

    for (const row of result.rows) {
      try {
        await checkTrackedSite(rowToSite(row));
      } catch (error) {
        console.error(
          `Planlagt SEO-kontrol fejlede for ${row.url}:`,
          error.message
        );
      }
    }
  } catch (error) {
    console.error(
      "Kunne ikke hente hjemmesider til planlagt kontrol:",
      error.message
    );
  } finally {
    scheduledCheckRunning = false;
  }
}

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function startServer() {
  try {
    await initDatabase();
  } catch (error) {
    console.error("Databaseopstart fejlede:", error.message);
    process.exit(1);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `SEO Map API v${VERSION} listening on port ${PORT}`
    );
  });

  const timer = setInterval(
    runScheduledChecks,
    CHECK_INTERVAL_MS
  );

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

startServer();
