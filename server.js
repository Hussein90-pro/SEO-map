
const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "SEO Map API is running" });
});

app.get("/api/seo", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({
      error: "Angiv en hjemmesideadresse med ?url=https://example.com"
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({
      error: "Ugyldig hjemmesideadresse"
    });
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).json({
      error: "Kun HTTP- og HTTPS-adresser er tilladt"
    });
  }

  const apiKey = process.env.PAGESPEED_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "API-nøglen mangler i serverens miljøvariabler"
    });
  }

  try {
    const endpoint = new URL(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    );

    endpoint.searchParams.set("url", parsedUrl.href);
    endpoint.searchParams.set("key", apiKey);
    endpoint.searchParams.set("category", "SEO");
    endpoint.searchParams.set("category", "PERFORMANCE");

    const response = await fetch(endpoint);

    if (!response.ok) {
      return res.status(502).json({
        error: "Google kunne ikke analysere hjemmesiden",
        status: response.status
      });
    }

    const data = await response.json();
    const categories = data.lighthouseResult?.categories || {};

    res.json({
      url: parsedUrl.href,
      seoScore: categories.seo?.score == null
        ? null
        : Math.round(categories.seo.score * 100),
      performanceScore: categories.performance?.score == null
        ? null
        : Math.round(categories.performance.score * 100),
      fetchedAt: new Date().toISOString()
    });
  } catch {
    res.status(500).json({
      error: "Der opstod en fejl under SEO-analysen"
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`SEO Map API listening on port ${port}`);
});
