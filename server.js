
"use strict";

const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const VERSION = "0.7.0";

app.use(express.json({ limit: "20kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

let databaseReady = false;
const businessCache = new Map();
const seoCache = new Map();
const BUSINESS_CACHE_MS = 10 * 60 * 1000;
const SEO_CACHE_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.LIVE_CHECK_INTERVAL_MS) || 60 * 60 * 1000
);

async function initDatabase() {
  if (!pool) throw new Error("DATABASE_URL mangler i Render.");

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

function requireDatabase(res) {
  if (!pool) {
    res.status(503).json({ error: "DATABASE_URL mangler i Render Environment." });
    return false;
  }
  if (!databaseReady) {
    res.status(503).json({ error: "Databasen klargøres. Prøv igen om lidt." });
    return false;
  }
  return true;
}

async function fetchJson(url, options = {}, timeout = 30000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeout)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.message || body.error || `HTTP ${response.status}`);
  }

  return body;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";

  let input = value.trim();
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;

  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (!url.hostname || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function domainOf(value) {
  const url = normalizeUrl(value);
  if (!url) return "";
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  ) return "";
  return hostname;
}

function idForUrl(url) {
  return Buffer.from(url).toString("base64url");
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

app.get("/", (req, res) => {
  res.json({
    status: "SEO Map API is running",
    version: VERSION,
    database: databaseReady ? "connected" : "initializing",
    features: [
      "business-search",
      "businesses-in-view",
      "pagespeed-seo",
      "automatic-seo-analysis",
      "seo-monitoring",
      "postgres-history",
      "improvement-proposals"
    ]
  });
});

// Find virksomheder i en by.
// GET /api/businesses?city=Aarhus
app.get("/api/businesses", async (req, res) => {
  const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
  if (!city || city.length > 100) {
    return res.status(400).json({ error: "Angiv en gyldig by." });
  }

  const key = city.toLowerCase();
  const cached = businessCache.get(key);
  if (cached && Date.now() - cached.time < BUSINESS_CACHE_MS) {
    return res.json(cached.data);
  }

  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "GEOAPIFY_API_KEY mangler i Render." });
  }

  try {
    const url = new URL("https://api.geoapify.com/v2/places");
    url.searchParams.set("categories", "commercial,service,office,catering,accommodation,healthcare,leisure");
    url.searchParams.set("filter", `place:${city}`);
    url.searchParams.set("limit", "50");
    url.searchParams.set("apiKey", apiKey);

    const data = await fetchJson(url);
    const businesses = (data.features || []).map((feature, index) => {
      const p = feature.properties || {};
      const website = normalizeUrl(p.website || p.datasource?.raw?.website || "");
      return {
        id: String(p.place_id || p.datasource?.raw?.osm_id || `${key}-${index}`),
        name: p.name || p.address_line1 || "Virksomhed",
        city: p.city || city,
        country: p.country || "",
        industry: p.categories?.join(", ") || "Ikke oplyst",
        website,
        lat: p.lat ?? feature.geometry?.coordinates?.[1],
        lng: p.lon ?? feature.geometry?.coordinates?.[0],
        phone: p.datasource?.raw?.phone || "",
        address: p.formatted || "",
        score: null,
        analyzed: false
      };
    }).filter(b => Number.isFinite(b.lat) && Number.isFinite(b.lng));

    const result = {
      count: businesses.length,
      businesses,
      source: "Geoapify Places API",
      note: "Resultater afhænger af datakildens dækning."
    };

    businessCache.set(key, { time: Date.now(), data: result });
    res.json(result);
  } catch (error) {
    console.error("Virksomhedssøgning fejlede:", error.message);
    res.status(502).json({ error: "Kunne ikke hente virksomheder fra Geoapify." });
  }
});

// Hent virksomheder i kortets synlige område.
// GET /api/businesses-in-view?west=...&south=...&east=...&north=...
app.get("/api/businesses-in-view", async (req, res) => {
  const west = Number(req.query.west);
  const south = Number(req.query.south);
  const east = Number(req.query.east);
  const north = Number(req.query.north);

  if (![west, south, east, north].every(Number.isFinite) ||
      west < -180 || east > 180 || south < -90 || north > 90 ||
      south >= north || west >= east) {
    return res.status(400).json({
      error: "Angiv et gyldigt kortområde. Brug vest, syd, øst og nord."
    });
  }

  // Store områder skal zoomes ind på, så API-kvoter og svartider begrænses.
  if ((east - west) * (north - south) > 100) {
    return res.status(400).json({
      error: "Zoom længere ind for at hente virksomheder i området."
    });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "GEOAPIFY_API_KEY mangler i Render." });
  }

  const cacheKey = [west, south, east, north].map(n => n.toFixed(3)).join(",");
  const cached = businessCache.get("bbox:" + cacheKey);
  if (cached && Date.now() - cached.time < BUSINESS_CACHE_MS) {
    return res.json(cached.data);
  }

  try {
    const url = new URL("https://api.geoapify.com/v2/places");
    url.searchParams.set("categories", "commercial,service,office,catering,accommodation,healthcare,leisure");
    url.searchParams.set("filter", `rect:${west},${south},${east},${north}`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("apiKey", apiKey);

    const data = await fetchJson(url);
    const businesses = (data.features || []).map((feature, index) => {
      const p = feature.properties || {};
      return {
        id: String(p.place_id || p.datasource?.raw?.osm_id || `${cacheKey}-${index}`),
        name: p.name || p.address_line1 || "Virksomhed",
        city: p.city || "",
        country: p.country || "",
        industry: p.categories?.join(", ") || "Ikke oplyst",
        website: normalizeUrl(p.website || p.datasource?.raw?.website || ""),
        lat: p.lat ?? feature.geometry?.coordinates?.[1],
        lng: p.lon ?? feature.geometry?.coordinates?.[0],
        address: p.formatted || "",
        score: null,
        analyzed: false
      };
    }).filter(b => Number.isFinite(b.lat) && Number.isFinite(b.lng));

    const result = {
      count: businesses.length,
      businesses,
      source: "Geoapify Places API",
      note: "Kun virksomheder fundet i datakilden vises."
    };

    businessCache.set("bbox:" + cacheKey, { time: Date.now(), data: result });
    res.json(result);
  } catch (error) {
    console.error("Kortområdesøgning fejlede:", error.message);
    res.status(502).json({ error: "Kunne ikke hente virksomheder for kortområdet." });
  }
});

// Teknisk SEO-analyse via Google PageSpeed Insights.
async function runPageSpeed(value) {
  const website = normalizeUrl(value);
  if (!website) throw new Error("Angiv en gyldig hjemmesideadresse.");

  const cached = seoCache.get(website);
  if (cached && Date.now() - cached.time < SEO_CACHE_MS) {
    return cached.data;
  }

  const url = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  url.searchParams.set("url", website);
  url.searchParams.set("strategy", "mobile");
  url.searchParams.append("category", "SEO");
  url.searchParams.append("category", "PERFORMANCE");

  if (process.env.PAGESPEED_API_KEY) {
    url.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  }

  const data = await fetchJson(url, {}, 60000);
  const categories = data.lighthouseResult?.categories || {};
  const seo = categories.seo?.score;
  const performance = categories.performance?.score;

  const record = {
    url: website,
    domain: domainOf(website),
    source: "Google PageSpeed Insights",
    dataType: "Teknisk Lighthouse-måling",
    seoScore: typeof seo === "number" ? Math.round(seo * 100) : null,
    performanceScore: typeof performance === "number"
      ? Math.round(performance * 100)
      : null,
    fetchedAt: new Date().toISOString(),
    title: data.lighthouseResult?.requestedUrl || website
  };

  seoCache.set(website, { time: Date.now(), data: record });
  return record;
}

app.get("/api/seo", async (req, res) => {
  const website = normalizeUrl(req.query.url);
  if (!website) return res.status(400).json({ error: "Angiv en gyldig URL." });

  try {
    res.json(await runPageSpeed(website));
  } catch (error) {
    console.error("SEO-analyse fejlede:", error.message);
    res.status(502).json({ error: "SEO-analysen kunne ikke gennemføres lige nu." });
  }
});

// Tilføj en hjemmeside til vedvarende overvågning.
// POST /api/monitor {"url":"https://example.com"}
app.post("/api/monitor", async (req, res) => {
  if (!requireDatabase(res)) return;

  const url = normalizeUrl(req.body?.url);
  if (!url || !domainOf(url)) {
    return res.status(400).json({ error: "Angiv en gyldig offentlig hjemmesideadresse." });
  }

  const id = idForUrl(url);

  try {
    const result = await pool.query(
      `INSERT INTO monitored_sites (id, url)
       VALUES ($1, $2)
       ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
       RETURNING *`,
      [id, url]
    );

    res.status(201).json({
      id: result.rows[0].id,
      url: result.rows[0].url,
      monitored: true,
      intervalMs: CHECK_INTERVAL_MS,
      message: "Hjemmesiden er registreret til overvågning."
    });
  } catch (error) {
    console.error("Kunne ikke gemme overvågning:", error.message);
    res.status(500).json({ error: "Kunne ikke gemme hjemmesiden i databasen." });
  }
});

app.get("/api/monitor", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      "SELECT * FROM monitored_sites ORDER BY created_at DESC"
    );

    res.json({
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
    console.error("Kunne ikke hente overvågning:", error.message);
    res.status(500).json({ error: "Kunne ikke hente overvågede hjemmesider." });
  }
});

app.get("/api/monitor/:id", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      "SELECT * FROM monitored_sites WHERE id = $1",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Hjemmesiden blev ikke fundet." });
    }

    res.json(rowToSite(result.rows[0]));
  } catch (error) {
    console.error("Kunne ikke hente historik:", error.message);
    res.status(500).json({ error: "Kunne ikke hente hjemmesidens historik." });
  }
});

async function checkTrackedSite(site) {
  const record = await runPageSpeed(site.url);
  const history = [...site.history, record].slice(-100);

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
      return res.status(404).json({ error: "Hjemmesiden blev ikke fundet." });
    }

    const site = await checkTrackedSite(rowToSite(result.rows[0]));
    res.json({ ...site.latest, monitored: true });
  } catch (error) {
    console.error("Manuel kontrol fejlede:", error.message);
    res.status(502).json({ error: "Kunne ikke opdatere SEO-målingen." });
  }
});

app.delete("/api/monitor/:id", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      "DELETE FROM monitored_sites WHERE id = $1",
      [req.params.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Hjemmesiden blev ikke fundet." });
    }
    res.sendStatus(204);
  } catch (error) {
    console.error("Kunne ikke slette overvågning:", error.message);
    res.status(500).json({ error: "Kunne ikke fjerne hjemmesiden." });
  }
});

// Foreslå forbedringer og et tilbudsudkast baseret på faktiske målinger.
// POST /api/proposal {"url":"https://example.com"}
app.post("/api/proposal", async (req, res) => {
  const url = normalizeUrl(req.body?.url);
  if (!url || !domainOf(url)) {
    return res.status(400).json({ error: "Angiv en gyldig hjemmesideadresse." });
  }

  try {
    const seo = await runPageSpeed(url);
    const tasks = [];

    if (seo.seoScore !== null && seo.seoScore < 90) {
      tasks.push({
        task: "Teknisk SEO-gennemgang",
        reason: `SEO-score er ${seo.seoScore}/100.`,
        suggestedAction: "Gennemgå indeksering, sidetitler, metabeskrivelser og tekniske SEO-kontroller."
      });
    }

    if (seo.performanceScore !== null && seo.performanceScore < 80) {
      tasks.push({
        task: "Optimering af hastighed",
        reason: `Performance-score er ${seo.performanceScore}/100.`,
        suggestedAction: "Undersøg billeder, JavaScript, CSS og serverens svartid."
      });
    }

    if (tasks.length === 0) {
      tasks.push({
        task: "Udvidet SEO-gennemgang",
        reason: "De tilgængelige Lighthouse-scorer viser ikke tydelige problemer, der alene kan begrunde et større tilbud.",
        suggestedAction: "Kontrollér søgeord, lokal synlighed, indeksering og indhold manuelt, før du fastsætter opgaver."
      });
    }

    res.json({
      url,
      domain: domainOf(url),
      measuredAt: seo.fetchedAt,
      scores: {
        seo: seo.seoScore,
        performance: seo.performanceScore
      },
      tasks,
      priceEstimate: null,
      priceNote: "Fastlæg pris efter vurdering af opgavernes omfang. Prisen beregnes ikke automatisk ud fra en score.",
      draft: [
        `Tilbud på forbedring af hjemmesiden ${domainOf(url)}`,
        "",
        "Baseret på den tekniske måling anbefales følgende:",
        ...tasks.map((task, index) =>
          `${index + 1}. ${task.task}: ${task.suggestedAction}`
        ),
        "",
        "Det endelige omfang, leveringstid og pris aftales efter nærmere gennemgang."
      ].join("\n")
    });
  } catch (error) {
    console.error("Tilbudsforslag fejlede:", error.message);
    res.status(502).json({ error: "Kunne ikke oprette et tilbudsforslag." });
  }
});

// Automatisk kontrol af gemte hjemmesider.
async function runScheduledChecks() {
  if (!databaseReady) return;

  try {
    const result = await pool.query(
      "SELECT * FROM monitored_sites ORDER BY last_checked_at ASC NULLS FIRST LIMIT 5"
    );

    for (const row of result.rows) {
      try {
        await checkTrackedSite(rowToSite(row));
      } catch (error) {
        console.error(`Kontrol fejlede for ${row.url}:`, error.message);
      }
    }
  } catch (error) {
    console.error("Planlagt kontrol fejlede:", error.message);
  }
}

async function startServer() {
  try {
    await initDatabase();
  } catch (error) {
    console.error("Databaseopstart fejlede:", error.message);
    process.exit(1);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SEO Map API v${VERSION} listening on port ${PORT}`);
  });

  setInterval(runScheduledChecks, CHECK_INTERVAL_MS);
}

startServer();
