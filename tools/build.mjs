import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const config = readJson("site.config.json");
const cities = readJson(path.join("data", "cities.json"));
const media = readJson(path.join("data", "media.json"));

const site = {
  name: config.name,
  url: normalizeUrl(config.siteUrl),
  description: config.description,
  contactEmail: config.contactEmail,
  googleAnalyticsId: (config.googleAnalyticsId || "").trim(),
  adsenseClientId: (config.adsenseClientId || "").trim(),
  adsensePublisherId: (config.adsensePublisherId || "").trim(),
  searchConsoleVerification: (config.searchConsoleVerification || "").trim(),
};

const endpoints = {
  ovation: "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
  alerts: "https://services.swpc.noaa.gov/products/alerts.json",
};

const now = new Date();
const forecast = await buildForecast();

cleanGenerated();
writeDataFiles();
generateHomePage();
generateCityPages();
generateUtilityPages();
generateSitemap();
generateRobots();
generateAdsTxt();

console.log(`Generated ${forecast.cities.length} city pages for ${site.name}.`);
console.log(`Forecast updated from NOAA: ${forecast.observationTime || "fallback"}, max Kp ${forecast.maxKp}.`);

async function buildForecast() {
  const [ovation, kpRows, alerts, cloudBySlug] = await Promise.all([
    fetchJson(endpoints.ovation, "ovation"),
    fetchJson(endpoints.kp, "kp"),
    fetchJson(endpoints.alerts, "alerts"),
    fetchCloudCover(cities),
  ]);

  const coordinates = Array.isArray(ovation?.coordinates) ? ovation.coordinates : [];
  const maxKp = maxUpcomingKp(kpRows);
  const stormSummary = summarizeAlerts(alerts);

  const cityForecasts = cities
    .map((city) => {
      const aurora = nearestAurora(coordinates, city);
      const clouds = cloudBySlug.get(city.slug) || { bestCloud: null, avgCloud: null };
      const score = scoreCity(city, aurora.value, maxKp, clouds.bestCloud);
      const label = labelForScore(score);
      return {
        ...city,
        aurora: aurora.value,
        gridLat: aurora.lat,
        gridLon: aurora.lon,
        bestCloud: clouds.bestCloud,
        avgCloud: clouds.avgCloud,
        score,
        label,
        watchWindow: watchWindowFor(city),
        guidance: guidanceFor(city, score, maxKp, clouds.bestCloud),
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    generatedAt: now.toISOString(),
    observationTime: ovation?.["Observation Time"] || "",
    forecastTime: ovation?.["Forecast Time"] || "",
    maxKp,
    stormSummary,
    dataSources: media.dataSources,
    cities: cityForecasts,
    mapDots: buildMapDots(coordinates),
  };
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AuroraForecastNow/0.1 hello@auroraforecastnow.com" },
    });
    if (!response.ok) throw new Error(`${label} ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`WARN: ${label} fetch failed: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCloudCover(cityRows) {
  const result = new Map();
  const chunkSize = 25;
  for (let i = 0; i < cityRows.length; i += chunkSize) {
    const chunk = cityRows.slice(i, i + chunkSize);
    const lat = chunk.map((city) => city.lat).join(",");
    const lon = chunk.map((city) => city.lon).join(",");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&timezone=UTC&forecast_days=2`;
    const json = await fetchJson(url, "open-meteo");
    const rows = Array.isArray(json) ? json : json ? [json] : [];
    rows.forEach((row, index) => {
      const city = chunk[index];
      const cloudValues = (row?.hourly?.cloud_cover || []).slice(0, 24).filter((value) => Number.isFinite(value));
      const bestCloud = cloudValues.length ? Math.min(...cloudValues) : null;
      const avgCloud = cloudValues.length ? Math.round(cloudValues.reduce((sum, value) => sum + value, 0) / cloudValues.length) : null;
      result.set(city.slug, { bestCloud, avgCloud });
    });
  }
  return result;
}

function maxUpcomingKp(rows) {
  if (!Array.isArray(rows)) return 0;
  const start = now.getTime() - 3 * 60 * 60 * 1000;
  const end = now.getTime() + 36 * 60 * 60 * 1000;
  const values = rows
    .filter((row) => {
      const time = new Date(row.time_tag).getTime();
      return Number.isFinite(time) && time >= start && time <= end;
    })
    .map((row) => Number(row.kp ?? row.Kp))
    .filter(Number.isFinite);
  return values.length ? round1(Math.max(...values)) : 0;
}

function summarizeAlerts(rows) {
  if (!Array.isArray(rows)) return "No current NOAA alert summary was available during the last build.";
  const storm = rows
    .map((row) => row.message || "")
    .find((message) => /Geomagnetic Storm|G[1-5]/i.test(message));
  if (!storm) return "No active geomagnetic storm watch appeared in the latest NOAA alert feed.";
  const lines = storm
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /WATCH|WARNING|ALERT|G[1-5]|Predicted|Observed|Highest Storm Level/i.test(line));
  return lines.slice(0, 4).join(" ");
}

function nearestAurora(coordinates, city) {
  if (!coordinates.length) return { value: 0, lat: null, lon: null };
  const cityLon = city.lon < 0 ? city.lon + 360 : city.lon;
  let best = null;
  for (const point of coordinates) {
    const [lon, lat, value] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(value)) continue;
    const dLat = lat - city.lat;
    const dLonRaw = Math.abs(lon - cityLon);
    const dLon = Math.min(dLonRaw, 360 - dLonRaw);
    const distance = dLat * dLat + dLon * dLon * Math.cos((city.lat * Math.PI) / 180) ** 2;
    if (!best || distance < best.distance) best = { value, lat, lon: normalizeLon(lon), distance };
  }
  return best || { value: 0, lat: null, lon: null };
}

function scoreCity(city, auroraValue, kp, bestCloud) {
  const latitudeBoost = Math.max(0, city.lat - 39) * 1.25;
  const auroraBoost = Math.min(52, auroraValue * 1.5);
  const kpBoost = Math.min(30, kp * 5.8);
  const cloudBoost = bestCloud == null ? 4 : Math.max(0, 100 - bestCloud) * 0.12;
  const score = Math.round(Math.min(99, auroraBoost + kpBoost + latitudeBoost + cloudBoost));
  return Math.max(3, score);
}

function labelForScore(score) {
  if (score >= 72) return "Great";
  if (score >= 52) return "Good";
  if (score >= 32) return "Possible";
  return "Low";
}

function guidanceFor(city, score, kp, bestCloud) {
  if (score >= 72) {
    return `Conditions are strong for ${city.name}. Find a dark northern horizon and check the sky after local twilight.`;
  }
  if (score >= 52) {
    return `${city.name} has a reasonable chance if clouds stay low and the aurora oval pushes south. Dark sites north of town help.`;
  }
  if (score >= 32) {
    return `Aurora is possible near ${city.name}, but it may require a camera, a darker location, or a stronger-than-forecast Kp pulse.`;
  }
  if (kp >= 5) {
    return `${city.name} is on the southern edge for this forecast. Watch updates, but do not expect easy naked-eye aurora.`;
  }
  if (bestCloud != null && bestCloud > 70) {
    return `Cloud cover is the main problem for ${city.name}. Check again if the sky clears later tonight.`;
  }
  return `${city.name} is unlikely tonight under the current NOAA forecast. Higher latitude cities have a better setup.`;
}

function watchWindowFor(city) {
  return "10:00 PM to 2:00 AM local time";
}

function buildMapDots(coordinates) {
  if (!coordinates.length) return [];
  const dots = [];
  for (const point of coordinates) {
    const lon = normalizeLon(point[0]);
    const lat = point[1];
    const value = point[2];
    if (lon < -170 || lon > -50 || lat < 35 || lat > 75) continue;
    const showQuietGrid = value <= 0 && lat >= 45 && Math.round(lat) % 4 === 0 && Math.round(lon) % 12 === 0;
    const showActiveGrid = value > 0 && Math.round(lat) % 2 === 0 && Math.round(lon) % 3 === 0;
    if (!showActiveGrid && !showQuietGrid) continue;
    dots.push({ lon, lat, value });
  }
  return dots
    .sort((a, b) => b.value - a.value)
    .slice(0, 240)
    .map((dot) => ({
      x: round1(((dot.lon + 170) / 120) * 100),
      y: round1(((75 - dot.lat) / 40) * 100),
      value: dot.value,
      alpha: round1(dot.value <= 0 ? 0.1 : Math.min(0.9, 0.16 + dot.value / 130)),
      size: Math.round(dot.value <= 0 ? 3 : 4 + Math.min(16, dot.value / 5)),
      color: dot.value >= 45 ? "#74f2a4" : dot.value >= 20 ? "#9ff7d2" : dot.value > 0 ? "#ffd166" : "#b7c1b4",
    }));
}

function cleanGenerated() {
  for (const dir of ["cities", "about", "contact", "privacy"]) {
    fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  }
  for (const file of ["index.html", "sitemap.xml", "robots.txt", "ads.txt"]) {
    fs.rmSync(path.join(root, file), { force: true });
  }
}

function writeDataFiles() {
  writeFile("data/forecast.json", `${JSON.stringify(forecast, null, 2)}\n`);
}

function generateHomePage() {
  const topCities = forecast.cities.slice(0, 9);
  const priorityCities = [...forecast.cities]
    .sort((a, b) => a.priority - b.priority || b.score - a.score)
    .slice(0, 24);

  writePage([], layout({
    title: "Northern Lights Forecast Tonight by City",
    description: site.description,
    path: "/",
    schema: [websiteSchema(), faqSchema()],
    body: `
      <main>
        <section class="hero">
          <div class="hero-grid">
            <div>
              <p class="kicker">Northern lights forecast tonight</p>
              <h1>Can you see the aurora tonight?</h1>
              <p class="lead">Aurora Forecast Now turns NOAA space weather data and cloud cover into a city-level viewing chance for the northern lights.</p>
              <form class="search-box" action="#cities">
                <input data-city-search type="search" placeholder="Search a city or state" aria-label="Search a city or state">
                <button class="button" type="submit">Find forecast</button>
              </form>
              <div class="hero-meta" aria-label="Current forecast summary">
                <div class="metric"><span>Max Kp next 36h</span><strong>${forecast.maxKp || "N/A"}</strong></div>
                <div class="metric"><span>NOAA forecast time</span><strong>${formatDateTime(forecast.forecastTime)}</strong></div>
                <div class="metric"><span>Best city now</span><strong>${escapeHtml(topCities[0]?.name || "Checking")}</strong></div>
              </div>
            </div>
            ${auroraVisual(topCities.slice(0, 4))}
          </div>
        </section>

        <section id="cities" class="section">
          <div class="section-head">
            <div>
              <p class="kicker">City forecast</p>
              <h2>Best northern lights chances now</h2>
            </div>
            <p>Scores combine NOAA aurora intensity, Kp forecast, latitude, and the best cloud window in the next 24 hours.</p>
          </div>
          <div class="city-grid">
            ${topCities.map((city) => cityCard(city, "")).join("")}
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div>
              <p class="kicker">Browse locations</p>
              <h2>City pages for tonight and tomorrow</h2>
            </div>
            <p>These static city pages are direct links, so search engines can discover them without JavaScript.</p>
          </div>
          <div class="city-grid">
            ${priorityCities.map((city) => cityCard(city, "")).join("")}
          </div>
        </section>

        <section class="section">
          <div class="guide-grid">
            <article class="panel">
              <p class="kicker">How to use it</p>
              <h3>Start with your city score</h3>
              <p>Great and Good mean it is worth checking the sky. Possible means camera-first or drive-north conditions. Low means wait for a stronger alert.</p>
            </article>
            <article class="panel">
              <p class="kicker">What matters</p>
              <h3>Kp is only one signal</h3>
              <p>Kp helps describe storm strength, but local visibility also depends on aurora oval position, clouds, twilight, moonlight, and light pollution.</p>
            </article>
            <article class="panel">
              <p class="kicker">Update strategy</p>
              <h3>Built for cached refreshes</h3>
              <p>The static MVP can rebuild from official feeds. A Worker/KV layer can later refresh popular cities every few minutes during storm watches.</p>
            </article>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div>
              <p class="kicker">Data sources</p>
              <h2>Official space weather, plain-English forecast</h2>
            </div>
            <p>${escapeHtml(forecast.stormSummary)}</p>
          </div>
          <div class="source-grid">
            ${media.dataSources.map((source) => `<a class="source-card" href="${escapeHtml(source.url)}"><h3>${escapeHtml(source.name)}</h3><p>Used for forecast data, Kp values, or local sky conditions.</p></a>`).join("")}
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div>
              <p class="kicker">FAQ</p>
              <h2>Northern lights forecast basics</h2>
            </div>
          </div>
          <div class="faq-grid">
            ${faqItems().map((item) => `<article class="faq-item"><h3>${item.q}</h3><p>${item.a}</p></article>`).join("")}
          </div>
        </section>
      </main>
    `,
  }));
}

function generateCityPages() {
  for (const city of forecast.cities) {
    writePage(["cities", city.slug], layout({
      title: `${city.name} Aurora Forecast Tonight: Northern Lights Chance`,
      description: `Northern lights forecast for ${city.name}, ${city.region}: aurora chance, Kp index, cloud cover, and viewing guidance for tonight.`,
      path: `/cities/${city.slug}/`,
      schema: [cityPageSchema(city), breadcrumbSchema(city)],
      body: `
        <main class="city-page">
          <a class="breadcrumb" href="../../">Aurora Forecast Now / Cities / ${escapeHtml(city.name)}</a>
          <section class="city-hero">
            <div>
              <p class="kicker">${escapeHtml(city.region)} aurora forecast</p>
              <h1>${escapeHtml(city.name)} northern lights forecast tonight</h1>
              <p class="lead">${escapeHtml(city.guidance)}</p>
              <div class="hero-actions">
                <a class="button" href="../../#cities">Search more cities</a>
                <a class="button secondary" href="https://www.spaceweather.gov/products/aurora-30-minute-forecast">NOAA forecast</a>
              </div>
            </div>
            <aside class="verdict">
              <span class="badge ${labelClass(city.label)}">${escapeHtml(city.label)}</span>
              <div class="verdict-score">${city.score}</div>
              <p>Aurora chance score for the next local night window.</p>
              <div class="stat-table">
                <div><span>Best window</span><strong>${escapeHtml(city.watchWindow)}</strong></div>
                <div><span>Max Kp</span><strong>${forecast.maxKp || "N/A"}</strong></div>
                <div><span>NOAA aurora grid</span><strong>${city.aurora}</strong></div>
                <div><span>Best cloud cover</span><strong>${city.bestCloud == null ? "N/A" : `${city.bestCloud}%`}</strong></div>
              </div>
            </aside>
          </section>

          <section class="detail-grid">
            <article class="panel">
              <p class="kicker">Tonight plan</p>
              <h2>Should you go out?</h2>
              <p>${escapeHtml(cityPlan(city))}</p>
              <p>For most mid-latitude locations, a clear northern horizon matters more than standing downtown. Look north, avoid street lights, and give your eyes at least 15 minutes to adapt.</p>
            </article>
            <aside class="panel">
              <p class="kicker">Current data</p>
              <h3>Last build</h3>
              <div class="stat-table">
                <div><span>Generated</span><strong>${formatDateTime(forecast.generatedAt)}</strong></div>
                <div><span>NOAA observed</span><strong>${formatDateTime(forecast.observationTime)}</strong></div>
                <div><span>NOAA forecast</span><strong>${formatDateTime(forecast.forecastTime)}</strong></div>
                <div><span>Nearest grid</span><strong>${formatCoord(city.gridLat, city.gridLon)}</strong></div>
              </div>
            </aside>
          </section>

          <section class="section" style="padding-left:0;padding-right:0">
            <div class="section-head">
              <div>
                <p class="kicker">Nearby options</p>
                <h2>Compare other cities</h2>
              </div>
            </div>
            <div class="city-grid">
              ${nearbyCities(city).map((nearby) => cityCard(nearby, "../../")).join("")}
            </div>
          </section>
        </main>
      `,
    }));
  }
}

function generateUtilityPages() {
  const pages = [
    {
      slug: "about",
      title: "About Aurora Forecast Now",
      body: `<p>Aurora Forecast Now is a city-level northern lights forecast built from public space weather data and local cloud forecasts. It is designed for quick viewing decisions, not scientific guarantees.</p><p>Forecasts can change quickly. Always check local weather and safety conditions before driving to a dark-sky site.</p>`,
    },
    {
      slug: "contact",
      title: "Contact Aurora Forecast Now",
      body: `<p>Send corrections, city requests, and partnership notes to <a href="mailto:${escapeHtml(site.contactEmail)}">${escapeHtml(site.contactEmail)}</a>.</p>`,
    },
    {
      slug: "privacy",
      title: "Privacy Policy",
      body: `<p>Aurora Forecast Now does not require an account for the public forecast pages. Basic analytics and advertising scripts may be added to understand traffic and support the site.</p><p>If email alerts are added later, subscribed addresses will only be used for the requested aurora alerts.</p>`,
    },
  ];

  for (const page of pages) {
    writePage([page.slug], layout({
      title: page.title,
      description: `${page.title} for ${site.name}.`,
      path: `/${page.slug}/`,
      body: `<main class="city-page"><a class="breadcrumb" href="../">Aurora Forecast Now</a><section class="panel"><h1>${page.title}</h1>${page.body}</section></main>`,
    }));
  }
}

function generateSitemap() {
  const urls = [
    { loc: "/", priority: "1.0", changefreq: "hourly" },
    ...forecast.cities.map((city) => ({ loc: `/cities/${city.slug}/`, priority: city.priority === 1 ? "0.9" : "0.7", changefreq: "hourly" })),
    { loc: "/about/", priority: "0.3", changefreq: "monthly" },
    { loc: "/contact/", priority: "0.3", changefreq: "monthly" },
    { loc: "/privacy/", priority: "0.3", changefreq: "monthly" },
  ];
  writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${site.url}${url.loc}</loc><lastmod>${now.toISOString()}</lastmod><changefreq>${url.changefreq}</changefreq><priority>${url.priority}</priority></url>`).join("\n")}
</urlset>
`);
}

function generateRobots() {
  writeFile("robots.txt", `User-agent: *
Allow: /

Sitemap: ${site.url}/sitemap.xml
`);
}

function generateAdsTxt() {
  const publisherId = site.adsensePublisherId.replace(/^pub-/, "");
  if (!publisherId) {
    writeFile("ads.txt", "");
    return;
  }
  writeFile("ads.txt", `google.com, pub-${publisherId}, DIRECT, f08c47fec0942fa0\n`);
}

function layout({ title, description, path: pagePath, body, schema = [] }) {
  const canonical = `${site.url}${pagePath}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | ${escapeHtml(site.name)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="${relativeAsset(pagePath)}styles.css">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta name="twitter:card" content="summary_large_image">
  ${site.searchConsoleVerification ? `<meta name="google-site-verification" content="${escapeHtml(site.searchConsoleVerification)}">` : ""}
  ${site.googleAnalyticsId ? analyticsTag(site.googleAnalyticsId) : ""}
  ${site.adsenseClientId ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escapeHtml(site.adsenseClientId)}" crossorigin="anonymous"></script>` : ""}
  ${schema.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join("\n  ")}
</head>
<body>
  <header class="site-header">
    <nav class="nav" aria-label="Main navigation">
      <a class="brand" href="${relativeAsset(pagePath)}"><span class="brand-mark" aria-hidden="true"></span>${escapeHtml(site.name)}</a>
      <div class="nav-links">
        <a href="${relativeAsset(pagePath)}#cities">Cities</a>
        <a href="${relativeAsset(pagePath)}data/forecast.json">Data</a>
        <a href="${relativeAsset(pagePath)}about/">About</a>
        <a href="${relativeAsset(pagePath)}contact/">Contact</a>
      </div>
    </nav>
  </header>
  ${body}
  <footer class="footer">
    <div class="footer-inner">
      <span>Forecast guidance, not a guarantee. Updated ${escapeHtml(formatDateTime(forecast.generatedAt))}.</span>
      <span><a href="${relativeAsset(pagePath)}privacy/">Privacy</a> · <a href="${relativeAsset(pagePath)}sitemap.xml">Sitemap</a></span>
    </div>
  </footer>
  <script src="${relativeAsset(pagePath)}script.js"></script>
</body>
</html>
`;
}

function auroraVisual(cityRows) {
  const dots = forecast.mapDots.map((dot) => `<span class="map-dot" style="--x:${dot.x}%;--y:${dot.y}%;--size:${dot.size}px;--alpha:${dot.alpha};color:${dot.color}"></span>`).join("");
  const cityPins = cityRows.map((city) => {
    const x = round1(((city.lon + 170) / 120) * 100);
    const y = round1(((75 - city.lat) / 40) * 100);
    return `<span class="map-city" title="${escapeHtml(city.name)}" style="--x:${x}%;--y:${y}%"></span>`;
  }).join("");
  return `<div class="aurora-visual" role="img" aria-label="NOAA aurora forecast map generated from OVATION data">
    <div class="aurora-band" aria-hidden="true"></div>
    ${dots}
    ${cityPins}
    <div class="visual-label">Generated from NOAA OVATION grid. Bright dots mark stronger aurora probability across North America.</div>
  </div>`;
}

function cityCard(city, prefix) {
  return `<a class="city-card" data-city-card data-search="${escapeHtml(`${city.name} ${city.region} ${city.country}`.toLowerCase())}" href="${prefix}cities/${city.slug}/">
    <div class="card-top">
      <div>
        <h3>${escapeHtml(city.name)}</h3>
        <p>${escapeHtml(city.region)}</p>
      </div>
      <span class="badge ${labelClass(city.label)}">${escapeHtml(city.label)}</span>
    </div>
    <div class="score-row">
      <span class="score">${city.score}</span>
      <p>${escapeHtml(city.watchWindow)}</p>
    </div>
    <div class="mini-stats">
      <span>Kp ${forecast.maxKp || "N/A"}</span>
      <span>Cloud ${city.bestCloud == null ? "N/A" : `${city.bestCloud}%`}</span>
      <span>Aurora ${city.aurora}</span>
      <span>${escapeHtml(city.country)}</span>
    </div>
  </a>`;
}

function cityPlan(city) {
  if (city.label === "Great") return `Yes, ${city.name} is one of the stronger locations in this build. Go after local twilight, face north, and prioritize an open dark horizon.`;
  if (city.label === "Good") return `It is worth watching conditions in ${city.name}. A short drive away from city lights can make the difference if the aurora brightens.`;
  if (city.label === "Possible") return `${city.name} is a borderline setup. Bring a camera, check cloud breaks, and watch for NOAA alerts before committing to a long drive.`;
  return `This is probably not a strong night for ${city.name}. Keep the page handy for the next G2 or stronger geomagnetic storm watch.`;
}

function nearbyCities(city) {
  return forecast.cities
    .filter((candidate) => candidate.slug !== city.slug)
    .map((candidate) => ({ candidate, distance: haversine(city, candidate) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((row) => row.candidate);
}

function faqItems() {
  return [
    {
      q: "What Kp do I need to see the northern lights?",
      a: "High-latitude cities can see aurora at lower Kp values. Mid-latitude cities often need Kp 5 or higher, plus clear skies and a dark northern horizon.",
    },
    {
      q: "Why does my city have a low score during a storm watch?",
      a: "A storm watch describes global geomagnetic activity. Local visibility also depends on where the aurora oval sits, your latitude, clouds, twilight, and light pollution.",
    },
    {
      q: "How often should this forecast update?",
      a: "The MVP can rebuild every 15 to 60 minutes. During a G2 or stronger watch, a Worker cache can refresh popular cities more frequently.",
    },
  ];
}

function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: site.name,
    url: site.url,
    description: site.description,
  };
}

function cityPageSchema(city) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${city.name} Aurora Forecast Tonight`,
    url: `${site.url}/cities/${city.slug}/`,
    description: `Northern lights forecast for ${city.name}, ${city.region}.`,
    about: {
      "@type": "Place",
      name: `${city.name}, ${city.region}`,
      geo: { "@type": "GeoCoordinates", latitude: city.lat, longitude: city.lon },
    },
  };
}

function breadcrumbSchema(city) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: site.url },
      { "@type": "ListItem", position: 2, name: city.name, item: `${site.url}/cities/${city.slug}/` },
    ],
  };
}

function faqSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems().map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, "");
}

function normalizeLon(lon) {
  return lon > 180 ? lon - 360 : lon;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function labelClass(label) {
  return label.toLowerCase();
}

function formatCoord(lat, lon) {
  if (lat == null || lon == null) return "N/A";
  return `${round1(lat)}, ${round1(lon)}`;
}

function formatDateTime(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function relativeAsset(pagePath) {
  const depth = pagePath.split("/").filter(Boolean).length;
  return depth === 0 ? "" : "../".repeat(depth);
}

function analyticsTag(id) {
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(id)}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","${escapeHtml(id)}");</script>`;
}

function haversine(a, b) {
  const r = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function writePage(parts, html) {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
}

function writeFile(relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
