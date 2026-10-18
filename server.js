
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Tillad vores frontend at hente data fra backend'en.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Test om serveren kører.
app.get("/", (req, res) => {
  res.json({
    status: "SEO Map API is running",
    version: "1.0.0"
  });
});

// Analyser en hjemmeside med Google PageSpeed Insights.
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

    if (
      !["http:", "https:"].includes(website.protocol) ||
      !website.hostname ||
      website.username ||
      website.password
    ) {
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

    // Vigtigt: Begge kategorier skal sendes.
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
      seoScore:
        typeof seoScore === "number"
          ? Math.round(seoScore * 100)
          : null,
      performanceScore:
        typeof performanceScore === "number"
          ? Math.round(performanceScore * 100)
          : null,
      availableCategories: Object.keys(categories),
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("SEO analysis failed:", error.message);

    return res.status(500).json({
      error:
        error.name === "TimeoutError"
          ? "Google-analysen tog for lang tid. Prøv igen."
          : "Der opstod en fejl under SEO-analysen."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SEO Map API listening on port ${PORT}`);
});
