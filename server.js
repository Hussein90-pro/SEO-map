const express = require("express");

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
    version: "0.5.0",
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
const trackedSites = new Map();

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

  if (!city || city.length > 100
