const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    process.env.FRONTEND_ORIGIN || "*"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "10kb" }));

app.get("/", (req, res) => {
  res.json({
    status: "SEO Map API is running",
    version: "0.6.0",
    features: [
      "business-search",
      "pagespeed-seo",
      "google-visibility",
      "seo-monitoring"
    ]
  });
});

const businessCache = new Map();
const seoCache = new Map();
const googleVisibilityCache = new Map();
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render PostgreSQL connections normally require TLS externally.
      ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

let databaseReady = false;

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
    const error = new Error(
      data?.message || data?.error || `HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

function normalizeWebsite(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  let website = value.trim();

  if (!/^https?:\/\//i.test(website)) {
    website = `https://${website}`;
  }

  try {
    const parsed = new URL(website);

    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return "";
    }

    return parsed.href;
  } catch {
    return "";
  }
}

function getDomain(value) {
  const normalized = normalizeWebsite(value);

  if (!normalized) {
    return "";
  }

  const hostname = new URL(normalized)
    .hostname.toLowerCase()
    .replace(/^www\./, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    !hostname.includes(".") ||
    !/^[a-z0-9.-]+$/.test(hostname) ||
    hostname.includes("..")
  ) {
    return "";
  }

  return hostname;
}

function getDataForSeoAuth() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    return "";
  }

  return (
    "Basic " +
    Buffer.from(`${login}:${password}`).toString("base64")
  );
}

// --------------------------------------------------
// 1. FIND VIRKSOMHEDER
// --------------------------------------------------

app.get("/api/businesses", async (req, res) => {
  const city =
    typeof req.query.city === "string"
      ? req.query.city.trim()
      : "";

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
    const geocodeUrl = new URL(
      "https://api.geoapify.com/v1/geocode/search"
    );

    geocodeUrl.searchParams.set("text", city);
    geocodeUrl.searchParams.set("type", "city");
    geocodeUrl.searchParams.set("limit", "1");
    geocodeUrl.searchParams.set("format", "json");
    geocodeUrl.searchParams.set("apiKey", apiKey);

    const geocodeData = await fetchJson(geocodeUrl, {}, 15000);
    const place = geocodeData.results?.[0];

    if (
      !place ||
      !Number.isFinite(Number(place.lat)) ||
      !Number.isFinite(Number(place.lon))
    ) {
      return res.status(404).json({
        error: "Vi kunne ikke finde byen. Prøv Aarhus, København eller London."
      });
    }

    const lat = Number(place.lat);
    const lon = Number(place.lon);
    const searchedCity = place.city || place.name || city;

    const placesUrl = new URL(
      "https://api.geoapify.com/v2/places"
    );

    placesUrl.searchParams.set(
      "categories",
      "commercial,office,catering,service,accommodation,activity"
    );

    placesUrl.searchParams.set(
      "filter",
      `circle:${lon},${lat},5000`
    );

    placesUrl.searchParams.set(
      "bias",
      `proximity:${lon},${lat}`
    );

    placesUrl.searchParams.set("limit", "100");
    placesUrl.searchParams.set("lang", "en");
    placesUrl.searchParams.set("apiKey", apiKey);

    const placesData = await fetchJson(placesUrl, {}, 20000);
    const features = Array.isArray(placesData.features)
      ? placesData.features
      : [];

    const seen = new Set();
    const businesses = [];

    for (const feature of features) {
      const props = feature.properties || {};
      const name = props.name || props.address_line1;

      const website = normalizeWebsite(
        props.website ||
        props.datasource?.raw?.website ||
        props.datasource?.raw?.contact_website
      );

      if (!name || !website) {
        continue;
      }

      const websiteKey = website.toLowerCase();

      if (seen.has(websiteKey)) {
        continue;
      }

      seen.add(websiteKey);

      const coords = feature.geometry?.coordinates || [];
      const longitude = Number(coords[0] ?? props.lon);
      const latitude = Number(coords[1] ?? props.lat);

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        continue;
      }

      const raw = props.datasource?.raw || {};

      const category = Array.isArray(props.categories)
        ? props.categories
        : [];

      const industry =
        category.find(item => typeof item === "string") ||
        "Virksomhed";

      businesses.push({
        id: String(
          props.place_id ||
          `${name}-${latitude}-${longitude}`
        ),
        name: String(name),
        city: props.city || searchedCity,
        country: props.country || place.country || "",
        lat: latitude,
        lng: longitude,
        website,
        phone:
          props.contact?.phone ||
          props.phone ||
          raw.phone ||
          raw.contact_phone ||
          "",
        email:
          props.contact?.email ||
          props.email ||
          raw.email ||
          raw.contact_email ||
          "",
        industry: String(industry)
          .replace(/_/g, " ")
          .replace(/\./g, " · ")
      });

      if (businesses.length >= 40) {
        break;
      }
    }

    const payload = {
      searchedCity,
      count: businesses.length,
      businesses,
      source: "Geoapify Places API",
      note:
        businesses.length === 0
          ? "Ingen virksomheder med hjemmeside blev fundet. Prøv en større by."
          : undefined
    };

    businessCache.set(cacheKey, {
      savedAt: Date.now(),
      payload
    });

    return res.json(payload);
  } catch (error) {
    console.error(
      "Geoapify business discovery failed:",
      error.message
    );

    return res.status(502).json({
      error:
        error.status === 401 || error.status === 403
          ? "Geoapify afviste API-nøglen. Kontrollér GEOAPIFY_API_KEY."
          : error.name === "TimeoutError"
            ? "Søgningen tog for lang tid. Prøv igen."
            : "Fejl under søgningen efter virksomheder."
    });
  }
});

// --------------------------------------------------
// 2. GOOGLE PAGESPEED SEO-ANALYSE
// --------------------------------------------------

async function runPageSpeed(website) {
  const apiKey = process.env.PAGESPEED_API_KEY;

  if (!apiKey) {
    throw new Error("PAGESPEED_API_KEY mangler i Render.");
  }

  const endpoint = new URL(
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
  );

  endpoint.searchParams.set("url", website);
  endpoint.searchParams.set("key", apiKey);
  endpoint.searchParams.append("category", "SEO");
  endpoint.searchParams.append("category", "PERFORMANCE");
  endpoint.searchParams.set("strategy", "mobile");

  const data = await fetchJson(endpoint, {}, 60000);
  const categories = data.lighthouseResult?.categories || {};

  const seoScore = categories.seo?.score;
  const performanceScore = categories.performance?.score;

  return {
    url: website,
    seoScore:
      typeof seoScore === "number"
        ? Math.round(seoScore * 100)
        : null,
    performanceScore:
      typeof performanceScore === "number"
        ? Math.round(performanceScore * 100)
        : null,
    availableCategories: Object.keys(categories),
    fetchedAt: new Date().toISOString(),
    source: "Google PageSpeed Insights"
  };
}

app.get("/api/seo", async (req, res) => {
  const inputUrl = req.query.url;

  if (typeof inputUrl !== "string" || !inputUrl.trim()) {
    return res.status(400).json({
      error: "Angiv en URL, fx ?url=https://example.com"
    });
  }

  const website = normalizeWebsite(inputUrl);

  if (!website) {
    return res.status(400).json({
      error: "Ugyldig hjemmesideadresse. Brug HTTP eller HTTPS."
    });
  }

  const cached = seoCache.get(website);

  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return res.json(cached.payload);
  }

  try {
    const result = await runPageSpeed(website);

    seoCache.set(website, {
      savedAt: Date.now(),
      payload: result
    });

    return res.json(result);
  } catch (error) {
    console.error("SEO analysis failed:", error.message);

    return res.status(502).json({
      error:
        error.name === "TimeoutError"
          ? "Google-analysen tog for lang tid. Prøv igen."
          : error.message === "PAGESPEED_API_KEY mangler i Render."
            ? error.message
            : "Google kunne ikke analysere hjemmesiden."
    });
  }
});

// --------------------------------------------------
// 3. AUTOMATISK SEO-OVERVÅGNING
// --------------------------------------------------

// Tilføj en hjemmeside til overvågning.
// POST /api/monitor
// JSON body: {"url":"https://example.com"}

app.post("/api/monitor", async (req, res) => {
  if (!ensureDatabase(res)) return;
  const website = normalizeWebsite(req.body?.url);
  if (!website) {
    return res.status(400).json({ error: "Angiv en gyldig hjemmesideadresse." });
  }

  const id = Buffer.from(website).toString("base64url");
  try {
    const result = await pool.query(
      `INSERT INTO monitored_sites (id, url)
       VALUES ($1, $2)
       ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
       RETURNING *`,
      [id, website]
    );
    const site = rowToSite(result.rows[0]);
    return res.status(201).json({
      id: site.id,
      url: site.url,
      monitored: true,
      intervalMs: LIVE_CHECK_INTERVAL_MS,
      message: "Hjemmesiden er tilføjet til SEO-overvågning."
    });
  } catch (error) {
    console.error("Could not save monitored site:", error.message);
    return res.status(500).json({ error: "Kunne ikke gemme hjemmesiden i databasen." });
  }
});

// GET /api/monitor
app.get("/api/monitor", async (req, res) => {
  if (!ensureDatabase(res)) return;
  try {
    const result = await pool.query(
      "SELECT * FROM monitored_sites ORDER BY created_at DESC"
    );
    return res.json({
      intervalMs: LIVE_CHECK_INTERVAL_MS,
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
    console.error("Could not list monitored sites:", error.message);
    return res.status(500).json({ error: "Kunne ikke hente overvågede hjemmesider." });
  }
});

// GET /api/monitor/:id
app.get("/api/monitor/:id", async (req, res) => {
  if (!ensureDatabase(res)) return;
  try {
    const result = await pool.query("SELECT * FROM monitored_sites WHERE id = $1", [req.params.id]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Den overvågede hjemmeside blev ikke fundet." });
    }
    return res.json(rowToSite(result.rows[0]));
  } catch (error) {
    console.error("Could not get monitored site:", error.message);
    return res.status(500).json({ error: "Kunne ikke hente hjemmesidens historik." });
  }
});

// DELETE /api/monitor/:id
app.delete("/api/monitor/:id", async (req, res) => {
  if (!ensureDatabase(res)) return;
  try {
    const result = await pool.query("DELETE FROM monitored_sites WHERE id = $1", [req.params.id]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Hjemmesiden blev ikke fundet." });
    }
    return res.sendStatus(204);
  } catch (error) {
    console.error("Could not delete monitored site:", error.message);
    return res.status(500).json({ error: "Kunne ikke fjerne hjemmesiden fra overvågning." });
  }
});

async function checkTrackedSite(site) {
  const record = await runPageSpeed(site.url);
  const previousHistory = Array.isArray(site.history) ? site.history : [];
  const history = [...previousHistory, record].slice(-100);

  const result = await pool.query(
    `UPDATE monitored_sites
     SET latest = $2::jsonb,
         last_checked_at = $3,
         history = $4::jsonb
     WHERE id = $1
     RETURNING *`,
    [site.id, JSON.stringify(record), record.fetchedAt, JSON.stringify(history)]
  );

  seoCache.set(site.url, { savedAt: Date.now(), payload: record });
  return rowToSite(result.rows[0]).latest;
}

// POST /api/monitor/:id/check
app.post("/api/monitor/:id/check", async (req, res) => {
  if (!ensureDatabase(res)) return;
  try {
    const result = await pool.query("SELECT * FROM monitored_sites WHERE id = $1", [req.params.id]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Den overvågede hjemmeside blev ikke fundet." });
    }
    const site = rowToSite(result.rows[0]);
    const record = await checkTrackedSite(site);
    return res.json({ ...record, monitored: true });
  } catch (error) {
    console.error("Tracked site check failed:", error.message);
    return res.status(502).json({ error: error.message || "Kunne ikke opdatere SEO-målingen lige nu." });
  }
});

// Scheduled re-analysis. Data is persisted after every successful check.
let monitorCheckRunning = false;
async function runScheduledChecks() {
  if (!pool || !databaseReady || monitorCheckRunning) return;
  monitorCheckRunning = true;
  try {
    const result = await pool.query("SELECT * FROM monitored_sites ORDER BY created_at ASC");
    for (const row of result.rows) {
      try {
        await checkTrackedSite(rowToSite(row));
      } catch (error) {
        console.error("Scheduled SEO check failed:", row.url, error.message);
      }
    }
  } catch (error) {
    console.error("Could not load monitored sites for scheduled checks:", error.message);
  } finally {
    monitorCheckRunning = false;
  }
}

setInterval(runScheduledChecks, LIVE_CHECK_INTERVAL_MS).unref();

// --------------------------------------------------
// 4. GOOGLE-SYNLIGHED OG TRAFIKESTIMATER
// --------------------------------------------------

// Kræver DATAFORSEO_LOGIN og DATAFORSEO_PASSWORD i Render.
// GET /api/google-visibility?domain=example.com
// Valgfrit: &location=Denmark&language=Danish

app.get("/api/google-visibility", async (req, res) => {
  const domain = getDomain(
    typeof req.query.domain === "string"
      ? req.query.domain
      : ""
  );

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
      error: "Angiv et gyldigt domæne, fx ?domain=example.dk."
    });
  }

  if (
    !location ||
    location.length > 80 ||
    !language ||
    language.length > 40
  ) {
    return res.status(400).json({
      error: "Ugyldig location eller language."
    });
  }

  const auth = getDataForSeoAuth();

  if (!auth) {
    return res.status(503).json({
      error:
        "Google-synlighed er ikke konfigureret. Tilføj DATAFORSEO_LOGIN og DATAFORSEO_PASSWORD i Render.",
      setupRequired: true
    });
  }

  const cacheKey =
    `${domain}|${location.toLowerCase()}|${language.toLowerCase()}`;

  const cached = googleVisibilityCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.savedAt < GOOGLE_CACHE_TTL_MS
  ) {
    return res.json({
      ...cached.payload,
      cached: true
    });
  }

  try {
    const endpoint =
      "https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live";

    const data = await fetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([{
          target: domain,
          location_name: location,
          language_name: language,
          limit: 1
        }])
      },
      30000
    );

    const task = data.tasks?.[0];

    if (!task || task.status_code !== 20000) {
      console.error(
        "DataForSEO task error:",
        task?.status_code,
        task?.status_message
      );

      return res.status(502).json({
        error: "Google-søgedata kunne ikke hentes fra DataForSEO.",
        providerStatus:
          task?.status_code || data.status_code || null
      });
    }

    const result = task.result?.[0];
    const item = result?.items?.[0];

    if (!result || !item) {
      const payload = {
        domain,
        location,
        language,
        available: false,
        message:
          "Der blev ikke fundet tilstrækkelige rankingdata for domænet i den valgte region.",
        source: "DataForSEO Labs",
        dataType: "Estimat",
        fetchedAt: new Date().toISOString()
      };

      googleVisibilityCache.set(cacheKey, {
        savedAt: Date.now(),
        payload
      });

      return res.json(payload);
    }

    const organic = item.metrics?.organic || {};

    const payload = {
      domain,
      location,
      language,
      available: true,

      estimatedMonthlyOrganicTraffic:
        typeof organic.etv === "number"
          ? organic.etv
          : null,

      rankedKeywordCount:
        typeof organic.count === "number"
          ? organic.count
          : null,

      rankingDistribution: {
        top1: organic.pos_1 ?? 0,
        positions2to3: organic.pos_2_3 ?? 0,
        positions4to10: organic.pos_4_10 ?? 0,
        positions11to20: organic.pos_11_20 ?? 0,

        positions21to100: [
          organic.pos_21_30,
          organic.pos_31_40,
          organic.pos_41_50,
          organic.pos_51_60,
          organic.pos_61_70,
          organic.pos_71_80,
          organic.pos_81_90,
          organic.pos_91_100
        ].reduce(
          (sum, value) => sum + (Number(value) || 0),
          0
        )
      },

      estimatedMonthlyPaidTraffic:
        typeof item.metrics?.paid?.etv === "number"
          ? item.metrics.paid.etv
          : null,

      source: "DataForSEO Labs",
      dataType:
        "Estimat – ikke virksomhedens faktiske Google Analytics- eller Search Console-tal",

      updatedByProvider: task.time || null,
      fetchedAt: new Date().toISOString(),

      providerCostUsd:
        typeof task.cost === "number"
          ? task.cost
          : null
    };

    googleVisibilityCache.set(cacheKey, {
      savedAt: Date.now(),
      payload
    });

    return res.json(payload);
  } catch (error) {
    console.error(
      "Google visibility request failed:",
      error.message
    );

    return res.status(502).json({
      error:
        error.name === "TimeoutError"
          ? "Google-søgningen tog for lang tid. Prøv igen."
          : "Der opstod en fejl ved hentning af Google-synlighed."
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function startServer() {
  if (pool) {
    try {
      await initDatabase();
    } catch (error) {
      console.error("PostgreSQL initialization failed:", error.message);
      // Keep API alive so Render health checks work; monitor routes will report DB status.
    }
  } else {
    console.error("DATABASE_URL is missing. Persistent SEO monitoring is disabled.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SEO Map API listening on port ${PORT}`);
  });
}

startServer();
