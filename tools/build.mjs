import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCity, labelForScore, guidanceFor, directionWords, nearestAurora, normalizeLon } from "../lib/forecast-core.mjs";
import { normalizeProConfig, renderProPageBody, serializeProClientConfig } from "./lib/pro-page.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const config = readJson("site.config.json");
const cities = readJson(path.join("data", "cities.json"));
const media = readJson(path.join("data", "media.json"));
// 20 个重点城市的本地观测知识层（观测点/季节/拍摄/城市专属 FAQ）。
// 只覆盖部分城市：有数据的多渲染几个 section（渐进增强），没有的保持模板原样。
const cityContent = readJson(path.join("data", "city-content.json"));

const site = {
  name: config.name,
  url: normalizeUrl(config.siteUrl),
  description: config.description,
  contentLastmod: normalizeContentLastmod(config.contentLastmod),
  contactEmail: config.contactEmail,
  cloudflareWebAnalyticsToken: normalizeCloudflareWebAnalyticsToken(config.cloudflareWebAnalyticsToken),
  googleAnalyticsId: (config.googleAnalyticsId || "").trim(),
  adsenseClientId: (config.adsenseClientId || "").trim(),
  adsensePublisherId: normalizePublisherId(config.adsensePublisherId || config.adsenseClientId || ""),
  adsenseAccountId: normalizeAdsenseAccountId(config.adsenseClientId || config.adsensePublisherId || ""),
  adsenseAdSlots: normalizeAdSlots(config.adsenseAdSlots || {}),
  searchConsoleVerification: (config.searchConsoleVerification || "").trim(),
  pro: normalizeProConfig(config.pro || {}),
};

const endpoints = {
  ovation: "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
  alerts: "https://services.swpc.noaa.gov/products/alerts.json",
};

const now = new Date();
const ALERT_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const useExistingForecast = process.env.AURORA_USE_EXISTING_FORECAST === "1";
const buildLastmod = site.contentLastmod;
const forecast = useExistingForecast
  ? readJson(path.join("data", "forecast.fixture.json"))
  : await buildForecast();
const cityCollections = buildCityCollections(forecast.cities);
const guidePages = buildGuidePages();
const glossaryEntriesList = glossaryEntries();

cleanGenerated();
writeDataFiles();
generateHomePage();
generateCityPages();
generateLocationPages();
generateAuroraAustralisHub();
generateCountryPages();
generateRegionPages();
generateGuidePages();
generateGlossaryPage();
generateUtilityPages();
generateProPage();
generateSitemap();
generateRobots();
generateAdsTxt();

console.log(`Generated ${forecast.cities.length} city pages for ${site.name}.`);
console.log(
  useExistingForecast
    ? `Forecast reused from data/forecast.fixture.json: ${forecast.observationTime || "fallback"}, max Kp ${forecast.maxKp}.`
    : `Forecast updated from NOAA: ${forecast.observationTime || "fallback"}, max Kp ${forecast.maxKp}.`
);

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
    .map((row) => ({
      message: row.message || "",
      issueMs: parseNoaaIssueTime(row.issue_datetime),
    }))
    .filter((row) => row.message && Number.isFinite(row.issueMs))
    .filter((row) => now.getTime() - row.issueMs <= ALERT_LOOKBACK_MS)
    .filter((row) => !/\bCANCEL(?:LED)?\b/i.test(row.message))
    .find((row) => /Geomagnetic Storm|Geomagnetic K-index|K-index|G[1-5]/i.test(row.message));
  if (!storm) return "No active geomagnetic storm watch appeared in the latest NOAA alert feed.";
  const lines = storm.message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /WATCH|WARNING|ALERT|G[1-5]|Predicted|Observed|Highest Storm Level/i.test(line));
  return lines.slice(0, 4).join(" ");
}

function parseNoaaIssueTime(value) {
  if (!value) return Number.NaN;
  return new Date(`${String(value).replace(" ", "T")}Z`).getTime();
}

// scoreCity / labelForScore / guidanceFor / directionWords / nearestAurora / normalizeLon
// 已抽取到 ../lib/forecast-core.mjs（与 workers/forecast-worker.js 共用唯一实现）

// 以下是模板专用的半球文案 helper（只有静态生成用，故留在本文件）
function isSouthern(city) {
  return city.lat < 0;
}

function auroraName(city) {
  return isSouthern(city) ? "southern lights" : "northern lights";
}

function auroraNameTitle(city) {
  return isSouthern(city) ? "Southern Lights (Aurora Australis)" : "Northern Lights";
}

function auroraNameSentence(city) {
  return isSouthern(city) ? "Southern lights" : "Northern lights";
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
  for (const dir of ["cities", "locations", "countries", "states", "guides", "glossary", "about", "contact", "privacy", "aurora-australis", "pro"]) {
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
  // 首页北极光区块只放北半球城市；南半球单独一个区块导流到 /aurora-australis/
  const topCities = forecast.cities.filter((city) => city.lat >= 0).slice(0, 12);
  const topSouthernCities = forecast.cities.filter((city) => city.lat < 0).slice(0, 6);
  const priorityCities = [...forecast.cities]
    .sort((a, b) => a.priority - b.priority || b.score - a.score)
    .slice(0, 36);

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
              <form class="search-box" action="#cities" data-live-search-form>
                <input data-city-search type="search" placeholder="Search a city or state" aria-label="Search a city or state">
                <button class="button" type="submit">Find forecast</button>
              </form>
              <div class="live-result" data-live-result hidden></div>
              <div class="hero-meta" aria-label="Current forecast summary">
                <div class="metric"><span>Max Kp next 36h</span><strong data-live-max-kp>Checking</strong></div>
                <div class="metric"><span>NOAA forecast time</span><strong data-live-forecast-time>Checking</strong></div>
                <div class="metric"><span>Best city now</span><strong data-live-best-city>Checking</strong></div>
                <div class="metric"><span>Live cache</span><strong data-live-status>Connecting</strong></div>
              </div>
              <p class="live-note" data-live-note>Live conditions load from the forecast API when you open this page.</p>
            </div>
            ${auroraVisual(topCities.slice(0, 4))}
          </div>
        </section>

        ${adUnit({
          slotKey: "topBanner",
          className: "ad-shell-wide",
          fallbackTitle: "More ways to plan tonight",
          fallbackText: "Compare nearby locations, cloud cover, and the signals behind each city score.",
          links: [
            ["locations/", "Browse locations"],
            ["guides/how-to-read-aurora-forecast/", "Read the score"],
            ["guides/cloud-cover-aurora-viewing/", "Check cloud cover"],
          ],
        })}

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

        <section class="section compact-section">
          <div class="section-head">
            <div>
              <p class="kicker">Southern hemisphere</p>
              <h2>Southern lights (aurora australis) chances now</h2>
            </div>
            <p>It is aurora season below the equator too: New Zealand, Tasmania, and far-south South America. <a href="aurora-australis/">See the full southern lights forecast</a>.</p>
          </div>
          <div class="city-grid">
            ${topSouthernCities.map((city) => cityCard(city, "")).join("")}
          </div>
        </section>

        <section class="section compact-section">
          <div class="guide-grid">
${alertSignupPanel(null)}
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div>
              <p class="kicker">Browse locations</p>
              <h2>City pages for tonight and tomorrow</h2>
            </div>
            <p>Use these city pages when you want a stable forecast link, a nearby comparison, or a quick check before driving north.</p>
          </div>
          <div class="city-grid">
            ${priorityCities.map((city) => cityCard(city, "")).join("")}
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div>
              <p class="kicker">Forecast atlas</p>
              <h2>Browse by location, guide, or forecast term</h2>
            </div>
            <p>Move from a single city result into place collections, plain-English guides, and the forecast terms that explain tonight's setup.</p>
          </div>
          <div class="guide-grid">
            <article class="panel">
              <h3>Location collections</h3>
              <p>Start from the full city index, country pages, or state and province collections.</p>
              ${linkCloud([
                ["locations/", "All locations"],
                ...cityCollections.countries.map((country) => [`countries/${country.slug}/`, country.name]),
                ...cityCollections.regions.slice(0, 8).map((region) => [`states/${region.slug}/`, region.name]),
              ])}
            </article>
            <article class="panel">
              <h3>Forecast guides</h3>
              <p>Evergreen pages explain the signals behind each city score.</p>
              ${linkCloud([["guides/", "All guides"], ...guidePages.map((guide) => [`guides/${guide.slug}/`, guide.shortTitle])])}
            </article>
            <article class="panel">
              <h3>Glossary and data</h3>
              <p>Plain-English definitions and source pages help readers understand NOAA and local sky inputs.</p>
              ${linkCloud([
                ["glossary/", "Forecast glossary"],
                ["guides/kp-index-aurora-forecast/", "Kp index"],
                ["guides/cloud-cover-aurora-viewing/", "Cloud cover"],
                ["guides/aurora-oval-map/", "Aurora oval"],
              ])}
            </article>
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
              <p>The public forecast uses cached official feeds, and storm watches can trigger more frequent refreshes for live city checks.</p>
            </article>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <div>
              <p class="kicker">Data sources</p>
              <h2>Official space weather, plain-English forecast</h2>
            </div>
            <p data-live-storm-summary>Live NOAA storm information loads with the current forecast.</p>
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
    const regionPath = `/states/${regionSlug(city)}/`;
    const countryPath = `/countries/${slugify(city.country)}/`;
    writePage(["cities", city.slug], layout({
      title: `${city.name} Aurora Forecast Tonight: ${auroraNameTitle(city)} Chance`,
      description: `${auroraNameSentence(city)} forecast for ${city.name}, ${city.region}: aurora chance, Kp index, cloud cover, and viewing guidance for tonight.`,
      path: `/cities/${city.slug}/`,
      schema: [cityPageSchema(city), cityFaqSchema(city), breadcrumbSchema([
        ["Home", "/"],
        ["Locations", "/locations/"],
        [city.name, `/cities/${city.slug}/`],
      ])],
      body: `
        <main class="city-page" data-live-city-detail data-city-slug="${escapeHtml(city.slug)}">
          ${breadcrumbLinks([["Home", "../../"], ["Locations", "../../locations/"], [city.name, ""]])}
          <section class="city-hero">
            <div>
              <p class="kicker">${escapeHtml(city.region)} aurora forecast</p>
              <h1>${escapeHtml(city.name)} ${auroraName(city)} forecast tonight</h1>
              <p class="lead" data-live-city-guidance>Live ${auroraName(city)} conditions for ${escapeHtml(city.name)} load from the forecast API. Use the local guide below while the latest score is checked.</p>
              <div class="hero-actions">
                <a class="button" href="../../#cities">Search more cities</a>
                <a class="button secondary" href="https://www.spaceweather.gov/products/aurora-30-minute-forecast">NOAA forecast</a>
              </div>
            </div>
            <aside class="verdict">
              <span class="badge possible" data-live-city-label>Checking</span>
              <div class="verdict-score" data-live-city-score>—</div>
              <p>Aurora chance score for the next local night window.</p>
              <div class="stat-table">
                <div><span>Best window</span><strong>${escapeHtml(city.watchWindow)}</strong></div>
                <div><span>Max Kp</span><strong data-live-city-kp>Checking</strong></div>
                <div><span>NOAA aurora grid</span><strong data-live-city-aurora>Checking</strong></div>
                <div><span>Best cloud cover</span><strong data-live-city-cloud>Checking</strong></div>
              </div>
            </aside>
          </section>

          <section class="detail-grid">
            <article class="panel">
              <p class="kicker">Tonight plan</p>
              <h2>Should you go out?</h2>
              <p data-live-city-plan>Check the live score, cloud cover, and NOAA storm status before deciding whether to travel.</p>
              <p>For most mid-latitude locations, a clear ${directionWords(city).horizon} horizon matters more than standing downtown. Look ${directionWords(city).look}, avoid street lights, and give your eyes at least 15 minutes to adapt.</p>
            </article>
${alertSignupPanel(city)}
          </section>
${cityLocalKnowledge(city)}
          ${adUnit({
            slotKey: "inArticle",
            fallbackTitle: "Keep checking nearby skies",
            fallbackText: "Compare this forecast with nearby locations before you choose a viewing spot.",
            links: [
              ["../../locations/", "All locations"],
              [`../..${regionPath}`, city.region],
              ["../../guides/how-to-read-aurora-forecast/", "Forecast guide"],
            ],
          })}

          <section class="section compact-section">
            <div class="guide-grid">
              <article class="panel">
                <p class="kicker">Region page</p>
                <h3>${escapeHtml(city.region)} aurora forecast</h3>
                <p>Compare nearby forecast pages that share similar latitude, time zone, and cloud patterns.</p>
                <a class="text-link" href="../..${regionPath}">Browse ${escapeHtml(city.region)}</a>
              </article>
              <article class="panel">
                <p class="kicker">Country page</p>
                <h3>${escapeHtml(city.country)} ${auroraName(city)} cities</h3>
                <p>Use the country collection to jump between high-latitude cities and storm-watch edge cases.</p>
                <a class="text-link" href="../..${countryPath}">Browse ${escapeHtml(city.country)}</a>
              </article>
              <article class="panel">
                <p class="kicker">Guide</p>
                <h3>How to read the score</h3>
                <p>Learn how Kp, cloud cover, latitude, and the aurora oval combine into a practical viewing chance.</p>
                <a class="text-link" href="../../guides/how-to-read-aurora-forecast/">Open guide</a>
              </article>
              <aside class="panel">
                <p class="kicker">Current data</p>
                <h3>Live forecast status</h3>
                <div class="stat-table">
                  <div><span>Updated</span><strong data-live-city-updated>Checking</strong></div>
                  <div><span>NOAA forecast</span><strong data-live-city-forecast-time>Checking</strong></div>
                  <div><span>Source</span><strong>NOAA + Open-Meteo</strong></div>
                  <div><span>Location</span><strong>${escapeHtml(formatCoord(city.lat, city.lon))}</strong></div>
                </div>
              </aside>
            </div>
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

          <section class="section compact-section">
            <div class="section-head">
              <div>
                <p class="kicker">FAQ</p>
                <h2>${escapeHtml(city.name)} aurora questions</h2>
              </div>
            </div>
            <div class="faq-grid">
              ${cityFaqItems(city).map((item) => `<article class="faq-item"><h3>${escapeHtml(item.q)}</h3><p>${escapeHtml(item.a)}</p></article>`).join("")}
            </div>
          </section>
          ${commentSection({
            key: `aurora:city:${city.slug}`,
            kicker: "Sky notes",
            title: `${city.name} comments`,
            placeholder: `Share a viewing note, correction, or question about aurora watching near ${city.name}...`,
          })}
        </main>
      `,
    }));
  }
}

function generateLocationPages() {
  writePage(["locations"], layout({
    title: "Northern Lights Forecast Locations",
    description: "Browse aurora forecast city pages, country collections, region pages, and current best viewing chances.",
    path: "/locations/",
    schema: [collectionPageSchema({
      title: "Northern lights forecast locations",
      description: "A city and region index for Aurora Forecast Now.",
      path: "/locations/",
      items: forecast.cities.map((city) => ({ name: `${city.name}, ${city.region}`, path: `/cities/${city.slug}/` })),
    }), breadcrumbSchema([["Home", "/"], ["Locations", "/locations/"]])],
    body: `
      <main class="city-page">
        ${breadcrumbLinks([["Home", "../"], ["Locations", ""]])}
        <section class="city-hero">
          <div>
            <p class="kicker">Location index</p>
            <h1>Northern lights forecast locations</h1>
            <p class="lead">Browse aurora forecast pages by city, country, and region. The live search box can also score cities that are not yet part of the saved city list.</p>
          </div>
          <aside class="verdict">
            <span class="badge good">Live</span>
            <div class="verdict-score">${forecast.cities.length}</div>
            <p>Saved city pages plus dynamic lookup for custom city and coordinate searches.</p>
          </aside>
        </section>
        <section class="section compact-section">
          <div class="section-head">
            <div>
              <p class="kicker">Top chances</p>
              <h2>Best city pages right now</h2>
            </div>
          </div>
          <div class="city-grid">
            ${forecast.cities.slice(0, 12).map((city) => cityCard(city, "../")).join("")}
          </div>
        </section>
        <section class="section compact-section">
          <div class="guide-grid">
            <article class="panel">
              <p class="kicker">Countries</p>
              <h3>Browse by country</h3>
              ${linkCloud(cityCollections.countries.map((country) => [`../countries/${country.slug}/`, country.name]))}
            </article>
            <article class="panel">
              <p class="kicker">Regions</p>
              <h3>Browse by state or province</h3>
              ${linkCloud(cityCollections.regions.slice(0, 18).map((region) => [`../states/${region.slug}/`, region.name]))}
            </article>
            <article class="panel">
              <p class="kicker">Guides</p>
              <h3>Learn the forecast signals</h3>
              ${linkCloud(guidePages.map((guide) => [`../guides/${guide.slug}/`, guide.shortTitle]))}
            </article>
          </div>
        </section>
      </main>
    `,
  }));
}

// Storm alert waitlist 表单：citySlug 为空 = 全站（首页/hub），有值 = 城市页。
// honeypot 字段 website 视觉隐藏；提交逻辑在 script.js 的 [data-alert-form]。
// 重点城市的本地知识区块：观测点 + 季节窗口 + 拍摄建议。
// 没有数据的城市返回空字符串，页面结构与旧版完全一致。
function cityLocalKnowledge(city) {
  const content = cityContent[city.slug];
  if (!content) return "";
  const spotCards = (content.spots || []).map((spot) => `
              <article class="panel">
                <p class="kicker">Viewing spot</p>
                <h3>${escapeHtml(spot.name)}</h3>
                <p>${escapeHtml(spot.note)}</p>
              </article>`).join("");
  return `
          <section class="section" style="padding-left:0;padding-right:0">
            <div class="section-head">
              <div>
                <p class="kicker">Local knowledge</p>
                <h2>Where to watch the ${auroraName(city)} near ${escapeHtml(city.name)}</h2>
              </div>
              <p>${escapeHtml(content.intro)}</p>
            </div>
            <div class="guide-grid">
${spotCards}
              <article class="panel">
                <p class="kicker">Season &amp; timing</p>
                <h3>When to go</h3>
                <p>${escapeHtml(content.season)}</p>
              </article>
              <article class="panel">
                <p class="kicker">Photography</p>
                <h3>Camera notes</h3>
                <p>${escapeHtml(content.photo)}</p>
              </article>
            </div>
          </section>`;
}

function alertSignupPanel(city) {
  const citySlug = city ? city.slug : "";
  const target = city ? city.name : "your city";
  return `
            <article class="panel" data-alert-signup data-alert-city="${escapeHtml(citySlug)}">
              <p class="kicker">Storm alerts</p>
              <h3>Get an email when a storm hits ${escapeHtml(target)}</h3>
              <p>We are building free storm email alerts. Join the waitlist and we will notify you when they launch.</p>
              <form class="comment-form" data-alert-form>
                <div class="comment-fields">
                  <label>
                    <span>Email</span>
                    <input name="email" type="email" maxlength="254" placeholder="you@example.com" autocomplete="email" required>
                  </label>
                  <input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0;opacity:0">
                </div>
                <button type="submit" class="text-link">Join the waitlist</button>
              </form>
              <p data-alert-status role="status"></p>
            </article>`;
}

function generateAuroraAustralisHub() {
  const southernCities = [...forecast.cities]
    .filter((city) => city.lat < 0)
    .sort((a, b) => b.score - a.score);
  if (!southernCities.length) return;
  const southernGuides = guidePages.filter((guide) => guide.slug.startsWith("southern-lights-"));
  const hubFaqs = [
    { q: "Can you see the aurora australis tonight?", a: "Check the live city scores below. They combine NOAA aurora grid data, Kp forecast, latitude, and cloud cover without storing a weather snapshot in the static page." },
    { q: "Where are the southern lights most visible?", a: "Tasmania, the southern South Island of New Zealand, and far-south South America (Ushuaia, Punta Arenas) are the most accessible aurora australis regions." },
    { q: "What Kp do I need for the southern lights?", a: "Photographic aurora is possible from Kp 4 to 5 in Tasmania and southern New Zealand. Naked-eye displays usually need Kp 6 or stronger with dark, clear skies." },
    { q: "When is southern lights season?", a: "Southern hemisphere winter, May to August, offers the longest dark windows. Weeks around the equinoxes often bring stronger geomagnetic activity." },
  ];
  writePage(["aurora-australis"], layout({
    title: "Southern Lights Forecast Tonight: Aurora Australis by City",
    description: "Live aurora australis forecast for New Zealand, Tasmania, and southern South America: city scores, Kp index, cloud cover, and viewing guidance.",
    path: "/aurora-australis/",
    schema: [collectionPageSchema({
      title: "Southern lights forecast cities",
      description: "Aurora australis forecast city collection for the southern hemisphere.",
      path: "/aurora-australis/",
      items: southernCities.map((city) => ({ name: `${city.name}, ${city.region}`, path: `/cities/${city.slug}/` })),
    }), faqPageSchema(hubFaqs), breadcrumbSchema([["Home", "/"], ["Aurora Australis", "/aurora-australis/"]])],
    body: `
      <main class="city-page">
        ${breadcrumbLinks([["Home", "../"], ["Aurora Australis", ""]])}
        <section class="city-hero">
          <div>
            <p class="kicker">Southern hemisphere</p>
            <h1>Southern lights forecast tonight</h1>
            <p class="lead">Live aurora australis viewing chances for New Zealand, Tasmania, and far-south South America. Face south from a dark sky site; scores update from NOAA space weather and local cloud cover.</p>
          </div>
          <aside class="verdict">
            <span class="badge possible">Live data</span>
            <div class="verdict-score">—</div>
            <p>Current southern city scores load from the forecast API below.</p>
          </aside>
        </section>
        <section class="section compact-section">
          <div class="section-head">
            <div>
              <p class="kicker">Live scores</p>
              <h2>Aurora australis cities ranked tonight</h2>
            </div>
          </div>
          <div class="city-grid">
            ${southernCities.map((city) => cityCard(city, "../")).join("")}
          </div>
        </section>
        <section class="section compact-section">
          <div class="guide-grid">
            ${southernGuides.map((guide) => `
            <article class="panel">
              <p class="kicker">${escapeHtml(guide.kicker)}</p>
              <h3>${escapeHtml(guide.title)}</h3>
              <p>${escapeHtml(guide.description)}</p>
              <a class="text-link" href="../guides/${guide.slug}/">Open guide</a>
            </article>`).join("")}
            <article class="panel">
              <p class="kicker">FAQ</p>
              <h3>Southern lights basics</h3>
              ${hubFaqs.map((faq) => `<p><strong>${escapeHtml(faq.q)}</strong><br>${escapeHtml(faq.a)}</p>`).join("")}
            </article>
${alertSignupPanel(null)}
          </div>
        </section>
      </main>
    `,
  }));
}

function generateCountryPages() {
  for (const country of cityCollections.countries) {
    writePage(["countries", country.slug], layout({
      title: `${country.name} ${auroraNameTitle(country.bestCity)} Forecast Cities`,
      description: `Browse aurora forecast pages for ${country.name}: city scores, cloud cover, Kp index, and viewing guidance.`,
      path: `/countries/${country.slug}/`,
      schema: [collectionPageSchema({
        title: `${country.name} ${auroraName(country.bestCity)} forecast`,
        description: `Aurora forecast city collection for ${country.name}.`,
        path: `/countries/${country.slug}/`,
        items: country.cities.map((city) => ({ name: `${city.name}, ${city.region}`, path: `/cities/${city.slug}/` })),
      }), breadcrumbSchema([["Home", "/"], ["Locations", "/locations/"], [country.name, `/countries/${country.slug}/`]])],
      body: `
        <main class="city-page">
          ${breadcrumbLinks([["Home", "../../"], ["Locations", "../../locations/"], [country.name, ""]])}
          <section class="city-hero">
            <div>
              <p class="kicker">Country collection</p>
              <h1>${escapeHtml(country.name)} ${auroraName(country.bestCity)} forecast</h1>
              <p class="lead">Compare city-level aurora chances across ${escapeHtml(country.name)}. Scores combine NOAA aurora grid data, Kp forecast, latitude, and local cloud cover.</p>
            </div>
            <aside class="verdict">
              <span class="badge possible">Live data</span>
              <div class="verdict-score">—</div>
              <p>Compare the current city scores loaded below.</p>
            </aside>
          </section>
          <section class="section compact-section">
            <div class="city-grid">
              ${country.cities.map((city) => cityCard(city, "../../")).join("")}
            </div>
          </section>
        </main>
      `,
    }));
  }
}

function generateRegionPages() {
  for (const region of cityCollections.regions) {
    writePage(["states", region.slug], layout({
      title: `${region.name} Aurora Forecast Tonight`,
      description: `Northern lights forecast pages for ${region.name}: local city scores, cloud cover, and current Kp context.`,
      path: `/states/${region.slug}/`,
      schema: [collectionPageSchema({
        title: `${region.name} aurora forecast`,
        description: `Aurora forecast city collection for ${region.name}.`,
        path: `/states/${region.slug}/`,
        items: region.cities.map((city) => ({ name: city.name, path: `/cities/${city.slug}/` })),
      }), breadcrumbSchema([["Home", "/"], ["Locations", "/locations/"], [region.name, `/states/${region.slug}/`]])],
      body: `
        <main class="city-page">
          ${breadcrumbLinks([["Home", "../../"], ["Locations", "../../locations/"], [region.name, ""]])}
          <section class="city-hero">
            <div>
              <p class="kicker">State and region collection</p>
              <h1>${escapeHtml(region.name)} aurora forecast</h1>
              <p class="lead">Use this region page to compare nearby northern lights forecast pages before deciding whether to watch from town, drive north, or wait for a stronger alert.</p>
            </div>
            <aside class="verdict">
              <span class="badge possible">Live data</span>
              <div class="verdict-score">—</div>
              <p>Compare the current city scores loaded below.</p>
            </aside>
          </section>
          <section class="section compact-section">
            <div class="city-grid">
              ${region.cities.map((city) => cityCard(city, "../../")).join("")}
            </div>
          </section>
        </main>
      `,
    }));
  }
}

function generateGuidePages() {
  writePage(["guides"], layout({
    title: "Northern Lights Forecast Guides",
    description: "Plain-English guides for reading aurora forecasts, Kp index, cloud cover, and city-level northern lights chances.",
    path: "/guides/",
    schema: [collectionPageSchema({
      title: "Northern lights forecast guides",
      description: "Plain-English aurora forecast explainers.",
      path: "/guides/",
      items: guidePages.map((guide) => ({ name: guide.title, path: `/guides/${guide.slug}/` })),
    }), breadcrumbSchema([["Home", "/"], ["Guides", "/guides/"]])],
    body: `
      <main class="city-page">
        ${breadcrumbLinks([["Home", "../"], ["Guides", ""]])}
        <section class="detail-hero">
          <p class="kicker">Forecast guides</p>
          <h1>Northern lights forecast guides</h1>
          <p class="lead">Short, practical explainers for people who want to know whether tonight is worth a sky check, a camera attempt, or a drive to darker ground.</p>
        </section>
        <section class="guide-list" aria-label="Aurora forecast guides">
          ${guidePages.map((guide) => guideCard(guide, "../")).join("")}
        </section>
      </main>
    `,
  }));

  for (const guide of guidePages) {
    writePage(["guides", guide.slug], layout({
      title: guide.title,
      description: guide.description,
      path: `/guides/${guide.slug}/`,
      schema: [guideSchema(guide), faqPageSchema(guide.faqs), breadcrumbSchema([["Home", "/"], ["Guides", "/guides/"], [guide.shortTitle, `/guides/${guide.slug}/`]])],
      body: `
        <main class="city-page">
          ${breadcrumbLinks([["Home", "../../"], ["Guides", "../"], [guide.shortTitle, ""]])}
          <article class="article-body">
            <p class="kicker">${escapeHtml(guide.kicker)}</p>
            <h1>${escapeHtml(guide.title)}</h1>
            <p class="lead">${escapeHtml(guide.intro)}</p>
            ${guide.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("")}</section>`).join("")}
            <section>
              <h2>Quick answers</h2>
              <div class="faq-grid">
                ${guide.faqs.map((item) => `<article class="faq-item"><h3>${escapeHtml(item.q)}</h3><p>${escapeHtml(item.a)}</p></article>`).join("")}
              </div>
            </section>
          </article>
          ${adUnit({
            slotKey: "inArticle",
            fallbackTitle: "Forecast tools for tonight",
            fallbackText: "Jump from this guide into city scores, cloud checks, and aurora oval basics.",
            links: [
              ["../../locations/", "All locations"],
              ["../../guides/cloud-cover-aurora-viewing/", "Cloud cover"],
              ["../../guides/aurora-oval-map/", "Aurora oval"],
            ],
          })}
          <section class="section compact-section">
            <div class="section-head">
              <div>
                <p class="kicker">Related city pages</p>
                <h2>Check live city conditions</h2>
              </div>
            </div>
            <div class="city-grid">
              ${forecast.cities.slice(0, 6).map((city) => cityCard(city, "../../")).join("")}
            </div>
          </section>
          ${commentSection({
            key: `aurora:guide:${guide.slug}`,
            kicker: "Reader notes",
            title: "Guide comments",
            placeholder: "Share a question, correction, or practical aurora forecast tip...",
          })}
        </main>
      `,
    }));
  }
}

function generateGlossaryPage() {
  writePage(["glossary"], layout({
    title: "Northern Lights Forecast Glossary",
    description: "Plain-English definitions for aurora forecast terms such as Kp, aurora oval, G storm watch, cloud cover, and NOAA OVATION.",
    path: "/glossary/",
    schema: [faqPageSchema(glossaryEntriesList.map((entry) => ({ q: entry.term, a: entry.definition }))), breadcrumbSchema([["Home", "/"], ["Glossary", "/glossary/"]])],
    body: `
      <main class="city-page">
        ${breadcrumbLinks([["Home", "../"], ["Glossary", ""]])}
        <section class="detail-hero">
          <p class="kicker">Glossary</p>
          <h1>Northern lights forecast terms, explained</h1>
          <p class="lead">Use this page when a forecast says Kp, G2 watch, aurora oval, OVATION, cloud cover, or magnetic latitude and you just need the practical meaning.</p>
        </section>
        <section class="glossary-grid" aria-label="Northern lights forecast glossary">
          ${glossaryEntriesList.map((entry) => glossaryCard(entry)).join("")}
        </section>
      </main>
    `,
  }));
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
      body: `<p>Aurora Forecast Now does not require an account for the public forecast pages. We use Cloudflare Web Analytics to count page loads and understand site performance. Its privacy-first beacon does not use cookies or local storage and does not collect information that directly identifies you.</p><p>If you join the storm alert waitlist, we store your email address, the city you selected, and the signup date. These are used only to launch and send the aurora alerts you requested, and never sold or shared. To remove your email from the waitlist, contact us via the contact page.</p><p>Aurora Pro stores an access key and saved location names in your browser. License activation sends the access key to our Worker, which validates the dedicated Aurora product with Lemon Squeezy; the site does not return or store the checkout email. Pro funnel measurements contain only an event name, page type, and saved-location count.</p>`,
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

function generateProPage() {
  if (!site.pro.publicPreview && !site.pro.enabled) return;
  writePage(["pro"], layout({
    title: "Aurora Pro Saved Location Comparison",
    description: "Save and compare live aurora forecasts for multiple cities without hiding the free public forecast pages.",
    path: "/pro/",
    robots: site.pro.enabled ? "" : "noindex, follow",
    extraStyles: ["assets/pro.css"],
    body: renderProPageBody(site.pro),
    bodyScripts: [
      `<script>window.AURORA_PRO=${serializeProClientConfig(site.pro)};</script>`,
      `<script type="module" src="${relativeAsset("/pro/")}assets/pro-access.js"></script>`,
    ],
  }));
}

function generateSitemap() {
  const urls = [
    { loc: "/", priority: "1.0" },
    { loc: "/locations/", priority: "0.9" },
    { loc: "/aurora-australis/", priority: "0.9" },
    { loc: "/guides/", priority: "0.8" },
    { loc: "/glossary/", priority: "0.7" },
    ...forecast.cities.map((city) => ({ loc: `/cities/${city.slug}/`, priority: city.priority === 1 ? "0.9" : "0.7" })),
    ...cityCollections.countries.map((country) => ({ loc: `/countries/${country.slug}/`, priority: "0.7" })),
    ...cityCollections.regions.map((region) => ({ loc: `/states/${region.slug}/`, priority: region.cities.length > 1 ? "0.7" : "0.5" })),
    ...guidePages.map((guide) => ({ loc: `/guides/${guide.slug}/`, priority: guide.priority })),
    { loc: "/about/", priority: "0.3" },
    { loc: "/contact/", priority: "0.3" },
    { loc: "/privacy/", priority: "0.3" },
    ...(site.pro.enabled ? [{ loc: "/pro/", priority: "0.6" }] : []),
  ];
  writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${site.url}${url.loc}</loc><lastmod>${buildLastmod}</lastmod><priority>${url.priority}</priority></url>`).join("\n")}
</urlset>
`);
}

function generateRobots() {
  // Disallow /api/comments so crawlers that render JS skip the comments fetch (UCH-10/UCH-11).
  // /api/forecast must stay crawlable: forecast content is client-rendered.
  writeFile("robots.txt", `User-agent: *
Allow: /
Disallow: /api/comments
Disallow: /api/pro/

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

function layout({ title, description, path: pagePath, body, schema = [], robots = "", extraStyles = [], bodyScripts = [] }) {
  const canonical = `${site.url}${pagePath}`;
  const pageBody = body.trim();
  const headExtras = [
    site.searchConsoleVerification ? `<meta name="google-site-verification" content="${escapeHtml(site.searchConsoleVerification)}">` : "",
    site.adsenseAccountId ? `<meta name="google-adsense-account" content="${escapeHtml(site.adsenseAccountId)}">` : "",
    site.cloudflareWebAnalyticsToken ? cloudflareWebAnalyticsTag(site.cloudflareWebAnalyticsToken) : "",
    site.googleAnalyticsId ? analyticsTag(site.googleAnalyticsId) : "",
    site.adsenseClientId ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escapeHtml(site.adsenseClientId)}" crossorigin="anonymous"></script>` : "",
    robots ? `<meta name="robots" content="${escapeHtml(robots)}">` : "",
    ...extraStyles.map((href) => `<link rel="stylesheet" href="${relativeAsset(pagePath)}${escapeHtml(href)}">`),
    ...schema.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`),
  ].filter(Boolean).map((item) => `  ${item}`).join("\n");
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
  <meta property="og:image" content="${site.url}/assets/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="The aurora borealis seen from the International Space Station (NASA)">
  <meta name="twitter:image" content="${site.url}/assets/og-image.jpg">
${headExtras}
</head>
<body>
  <header class="site-header">
    <nav class="nav" aria-label="Main navigation">
      <a class="brand" href="${relativeAsset(pagePath)}"><span class="brand-mark" aria-hidden="true"></span>${escapeHtml(site.name)}</a>
      <div class="nav-links">
        <a href="${relativeAsset(pagePath)}locations/">Locations</a>
        <a href="${relativeAsset(pagePath)}aurora-australis/">Southern Lights</a>
        <a href="${relativeAsset(pagePath)}guides/">Guides</a>
        <a class="nav-secondary" href="${relativeAsset(pagePath)}glossary/">Glossary</a>
        ${site.pro.enabled ? `<a class="nav-secondary" href="${relativeAsset(pagePath)}pro/">Pro</a>` : ""}
        <a class="nav-secondary" href="${relativeAsset(pagePath)}about/">About</a>
        <a class="nav-secondary" href="${relativeAsset(pagePath)}contact/">Contact</a>
        <details class="nav-more">
          <summary>More</summary>
          <div class="nav-more-menu">
            <a href="${relativeAsset(pagePath)}glossary/">Glossary</a>
            ${site.pro.enabled ? `<a href="${relativeAsset(pagePath)}pro/">Pro</a>` : ""}
            <a href="${relativeAsset(pagePath)}about/">About</a>
            <a href="${relativeAsset(pagePath)}contact/">Contact</a>
          </div>
        </details>
      </div>
    </nav>
  </header>
${pageBody}
  <footer class="footer">
    <div class="footer-inner">
      <span data-live-footer-updated>Forecast guidance, not a guarantee. Live conditions load from the forecast API.</span>
      <span><a href="${relativeAsset(pagePath)}privacy/">Privacy</a> · <a href="${relativeAsset(pagePath)}sitemap.xml">Sitemap</a></span>
    </div>
  </footer>
  <script src="${relativeAsset(pagePath)}script.js"></script>
  ${bodyScripts.join("\n  ")}
</body>
</html>
`;
}

function auroraVisual() {
  return `<div class="aurora-visual" role="img" aria-label="Illustrated aurora forecast backdrop">
    <div class="aurora-band" aria-hidden="true"></div>
    <div class="visual-label">Live NOAA and cloud-aware city scores load below.</div>
  </div>`;
}

function cityCard(city, prefix) {
  return `<a class="city-card" data-city-card data-city-slug="${escapeHtml(city.slug)}" data-search="${escapeHtml(`${city.name} ${city.region} ${city.country}`.toLowerCase())}" href="${prefix}cities/${city.slug}/">
    <div class="card-top">
      <div>
        <h3>${escapeHtml(city.name)}</h3>
        <p>${escapeHtml(city.region)}</p>
      </div>
      <span class="badge possible" data-city-label>Checking</span>
    </div>
    <div class="score-row">
      <span class="score" data-city-score>—</span>
      <p>${escapeHtml(city.watchWindow)}</p>
    </div>
    <div class="mini-stats">
      <span data-city-kp>Kp checking</span>
      <span data-city-cloud>Cloud checking</span>
      <span data-city-aurora>Aurora checking</span>
      <span>${escapeHtml(city.country)}</span>
    </div>
  </a>`;
}

function nearbyCities(city) {
  return forecast.cities
    .filter((candidate) => candidate.slug !== city.slug)
    .map((candidate) => ({ candidate, distance: haversine(city, candidate) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((row) => row.candidate);
}

function buildCityCollections(cityRows) {
  const countries = Array.from(groupBy(cityRows, (city) => city.country).entries())
    .map(([countryName, rows]) => {
      const sortedRows = sortCities(rows);
      return {
        slug: slugify(countryName),
        name: countryName,
        cities: sortedRows,
        bestCity: sortedRows[0],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const regions = Array.from(groupBy(cityRows, (city) => `${city.country}|||${city.region}`).entries())
    .map(([key, rows]) => {
      const [country, region] = key.split("|||");
      const sortedRows = sortCities(rows);
      return {
        slug: slugify(`${region}-${country}`),
        name: `${region}, ${country}`,
        region,
        country,
        cities: sortedRows,
        bestCity: sortedRows[0],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { countries, regions };
}

function sortCities(cityRows) {
  return [...cityRows].sort((a, b) => b.score - a.score || a.priority - b.priority || a.name.localeCompare(b.name));
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function buildGuidePages() {
  return [
    {
      slug: "how-to-read-aurora-forecast",
      shortTitle: "Read the forecast",
      title: "How to Read an Aurora Forecast Tonight",
      description: "A practical guide to reading Kp, aurora oval position, cloud cover, and city-level northern lights scores.",
      kicker: "Forecast basics",
      priority: "0.8",
      intro: "Aurora forecasts look technical, but the viewing decision is usually a simple mix of storm strength, aurora oval position, darkness, clouds, and how far north you are.",
      sections: [
        {
          heading: "Start with location, not only Kp",
          paragraphs: [
            "A high Kp number is useful, but it does not guarantee visible aurora in every city. High-latitude cities can work with lower Kp, while mid-latitude cities usually need a stronger storm and a clear northern horizon.",
            "Aurora Forecast Now scores each city by combining NOAA aurora grid intensity, latitude, Kp forecast, and local cloud cover so the decision is closer to a practical viewing plan.",
          ],
        },
        {
          heading: "Check clouds before you drive",
          paragraphs: [
            "Cloud cover can erase a good space-weather setup. A lower cloud number means a better local sky window, but it should still be checked against local radar and road conditions before a long drive.",
          ],
        },
      ],
      faqs: [
        { q: "Is Kp enough to decide whether to go outside?", a: "No. Kp describes geomagnetic activity, but visibility also depends on aurora oval position, latitude, darkness, cloud cover, and light pollution." },
        { q: "What does a city score mean?", a: "The score is a practical viewing signal for the next local night window. It is guidance, not a guarantee." },
      ],
    },
    {
      slug: "kp-index-aurora-forecast",
      shortTitle: "Kp index",
      title: "Kp Index for Northern Lights Forecasts",
      description: "What the Kp index means for aurora viewing and why high Kp does not always mean visible northern lights in your city.",
      kicker: "Kp guide",
      priority: "0.7",
      intro: "Kp is a global geomagnetic index. It helps describe storm strength, but it should be read together with local sky conditions and aurora oval position.",
      sections: [
        {
          heading: "What Kp measures",
          paragraphs: [
            "Kp summarizes geomagnetic disturbance on a planetary scale. A higher number usually means the aurora oval can push farther south, which improves the chance for mid-latitude viewers.",
            "For a city-level forecast, Kp is one signal among several. A strong Kp value with heavy clouds can still be a bad viewing night.",
          ],
        },
        {
          heading: "How to use Kp for city decisions",
          paragraphs: [
            "High-latitude locations can see aurora at lower Kp values. Cities farther south often need Kp 5 or higher, plus darkness and a clear northern horizon.",
          ],
        },
      ],
      faqs: [
        { q: "What Kp do I need to see aurora?", a: "It depends on latitude. Northern cities can work at lower Kp; mid-latitude cities often need Kp 5 or stronger." },
        { q: "Can Kp be high while my city score is low?", a: "Yes. Clouds, twilight, light pollution, and aurora oval position can all lower the local viewing chance." },
      ],
    },
    {
      slug: "cloud-cover-aurora-viewing",
      shortTitle: "Cloud cover",
      title: "Cloud Cover and Northern Lights Viewing",
      description: "How cloud cover affects aurora viewing and why a clear local sky can matter as much as the space-weather forecast.",
      kicker: "Sky conditions",
      priority: "0.7",
      intro: "A strong aurora forecast still needs a clear sky. Cloud cover is the local filter between space weather and what you can actually see.",
      sections: [
        {
          heading: "Why clouds change the plan",
          paragraphs: [
            "Clouds block visible aurora even when geomagnetic conditions are favorable. That is why city-level guidance should include both space weather and weather data.",
            "The best viewing plan often means finding a nearby cloud break, not simply driving to the darkest location on the map.",
          ],
        },
        {
          heading: "Use the clearest window",
          paragraphs: [
            "Aurora Forecast Now looks at near-term cloud cover to surface the best local window. If the score is borderline, a short clear break can still make a camera-first attempt worthwhile.",
          ],
        },
      ],
      faqs: [
        { q: "Can I see aurora through thin clouds?", a: "Sometimes a camera may catch glow through thin cloud, but naked-eye viewing usually needs clearer sky." },
        { q: "Should I drive if clouds are high?", a: "Only if nearby forecasts show a credible clearing window and roads are safe. Space weather alone is not enough." },
      ],
    },
    {
      slug: "aurora-oval-map",
      shortTitle: "Aurora oval map",
      title: "Aurora Oval Map: What It Means Tonight",
      description: "A plain-English explanation of the aurora oval, NOAA OVATION maps, and why city latitude matters.",
      kicker: "Aurora map",
      priority: "0.7",
      intro: "The aurora oval is the zone where northern lights are most likely. When geomagnetic activity increases, that oval can brighten and expand toward lower latitudes.",
      sections: [
        {
          heading: "What the oval tells you",
          paragraphs: [
            "NOAA aurora maps estimate where aurora is more likely in the near term. A city closer to stronger grid values has a better setup than a city far outside the active oval.",
            "The map is not a promise. Local clouds, moonlight, twilight, and horizon quality still decide whether you can actually see anything.",
          ],
        },
        {
          heading: "Why city pages use the nearest grid",
          paragraphs: [
            "Each static city page compares the city location to the nearest NOAA aurora grid point. That keeps the forecast local enough to be useful without pretending the model is street-level precise.",
          ],
        },
      ],
      faqs: [
        { q: "Is the aurora oval the same as the visible aurora?", a: "No. It is a forecast probability zone. Visibility also depends on darkness, weather, and local light pollution." },
        { q: "Why do nearby cities have different scores?", a: "Latitude, cloud cover, and distance to the modeled aurora grid can differ enough to change the practical score." },
      ],
    },
    {
      slug: "southern-lights-tasmania",
      shortTitle: "Tasmania guide",
      title: "How to See the Southern Lights in Tasmania",
      description: "Where and when to watch the aurora australis from Hobart and southern Tasmania: best dark-sky spots, Kp guidance, and season windows.",
      kicker: "Aurora australis",
      priority: "0.8",
      intro: "Tasmania is one of the most accessible places on Earth to watch the aurora australis. Face south from a dark coastline, watch the Kp forecast, and pick a winter night with low cloud cover for the best chance.",
      sections: [
        {
          heading: "Why Tasmania works for aurora australis",
          paragraphs: [
            "Hobart sits near latitude 43 degrees south, closer to the southern auroral oval than almost any other city with an airport and sealed roads. When geomagnetic activity reaches Kp 5 or higher, displays can climb well above the southern horizon.",
            "Unlike Antarctica or the sub-Antarctic islands, Tasmania lets you chase a storm alert on the same evening: check the forecast, drive 30 to 60 minutes to a dark coastline, and face south.",
          ],
        },
        {
          heading: "Best viewing spots near Hobart",
          paragraphs: [
            "South Arm Peninsula, Goat Bluff, and Clifton Beach give wide, dark southern horizons within an hour of Hobart. Bruny Island and Cockle Creek go darker still if you have more time.",
            "Avoid looking across the city glow: the display sits to the south, so position yourself with Hobart's lights behind you, not in front.",
          ],
        },
        {
          heading: "When to go: season and Kp",
          paragraphs: [
            "Winter (May to August) brings the longest, darkest nights, and the weeks around the equinoxes often carry stronger geomagnetic activity. A practical trigger: start watching the sky when the Kp forecast reaches 5 and Tasmanian cloud cover stays low.",
            "Check the live city scores for Hobart, Launceston, and Devonport on this site before driving: the score already combines aurora oval intensity, Kp, latitude, and cloud cover.",
          ],
        },
      ],
      faqs: [
        { q: "Can you see the southern lights from Hobart itself?", a: "During strong storms, yes, but city light pollution mutes the display. A 30 to 60 minute drive to a dark southern coastline improves the view dramatically." },
        { q: "What Kp do I need in Tasmania?", a: "Photographic aurora is possible from Kp 4 to 5. Naked-eye colour and structure usually need Kp 6 or stronger with clear, dark skies." },
        { q: "Is summer viewing possible?", a: "It is harder: Tasmanian summer nights are short and twilight lingers. Winter offers far more dark hours per night." },
      ],
    },
    {
      slug: "southern-lights-new-zealand",
      shortTitle: "New Zealand guide",
      title: "Southern Lights in New Zealand: Best Viewing Spots",
      description: "Where to watch the aurora australis in New Zealand: Otago and Southland dark-sky spots, Stewart Island, season timing, and Kp guidance.",
      kicker: "Aurora australis",
      priority: "0.8",
      intro: "The southern South Island is New Zealand's aurora country. From Dunedin, Queenstown, and Invercargill, face south on a dark winter night when the Kp forecast reaches 5, and give the sky at least 20 minutes.",
      sections: [
        {
          heading: "Otago: Dunedin and Queenstown",
          paragraphs: [
            "Dunedin's Otago Peninsula offers classic aurora vantage points: Hoopers Inlet, Sandfly Bay, and Tunnel Beach all give dark southern horizons within 30 minutes of the city.",
            "Around Queenstown, escape the town glow toward Kingston at the southern end of Lake Wakatipu, or use elevated lookouts with a clear line to the south.",
          ],
        },
        {
          heading: "Southland and Stewart Island",
          paragraphs: [
            "Invercargill and Bluff sit at the bottom of the South Island, and Stewart Island / Rakiura across the strait is an International Dark Sky Sanctuary: minimal light pollution and an unobstructed southern sea horizon.",
            "The Aoraki Mackenzie Dark Sky Reserve near Lake Tekapo is farther north, which trades some aurora frequency for exceptionally dark skies during stronger storms.",
          ],
        },
        {
          heading: "Season, Kp, and practical timing",
          paragraphs: [
            "New Zealand winter (June to August) delivers the longest dark windows, and equinox weeks often bring elevated geomagnetic activity. Start paying attention when the Kp forecast reaches 5; naked-eye displays over water usually arrive with Kp 6 or more.",
            "Before driving, check the live scores for Queenstown, Dunedin, and Invercargill on this site: the score already folds in aurora oval intensity, Kp, latitude, and local cloud cover.",
          ],
        },
      ],
      faqs: [
        { q: "Where is the best place in New Zealand to see the aurora?", a: "The southern coasts of Otago and Southland: Otago Peninsula, the Catlins, Bluff, and Stewart Island / Rakiura offer the darkest southern horizons." },
        { q: "Can you see the southern lights from Auckland or Wellington?", a: "Only during unusually strong storms, and mostly as a low glow or on camera. The South Island's southern coast is far more reliable." },
        { q: "What time of night is best?", a: "Local midnight, roughly 11pm to 2am, is statistically strongest, but during big storms displays can appear any time the sky is dark." },
      ],
    },
    {
      slug: "southern-lights-patagonia",
      shortTitle: "Patagonia guide",
      title: "Southern Lights in Patagonia: Ushuaia, Punta Arenas & the Falklands",
      description: "Where and when to see the aurora australis from far-south South America: Ushuaia, Punta Arenas, and the Falkland Islands, with dark-sky spots, season windows, and Kp guidance.",
      kicker: "Aurora australis",
      priority: "0.8",
      intro: "Far-south Patagonia holds some of the closest inhabited land to the southern auroral zone: Ushuaia at nearly 55 degrees south, Punta Arenas at 53, and the Falkland Islands out in the South Atlantic. Big displays are still uncommon and need a strong storm, but when one lands, these skies are as well placed as anywhere on Earth.",
      sections: [
        {
          heading: "Ushuaia and Tierra del Fuego",
          paragraphs: [
            "Ushuaia is the world's southernmost city, so it sits closer to the aurora australis zone than any other urban area. The limiting factor is almost always the Beagle Channel's maritime weather, not geomagnetic activity.",
            "For dark, south-facing horizons, locals use the Beagle Channel shoreline east of town, the Martial Glacier road above the city, and Ruta 3 toward Lapataia in Tierra del Fuego National Park.",
          ],
        },
        {
          heading: "Punta Arenas and the Strait of Magellan",
          paragraphs: [
            "Punta Arenas, at about 53 degrees south, pairs an airport and sealed roads with a low southern horizon over the Strait of Magellan. The Reserva Nacional Magallanes just west of town and its Cerro Mirador viewpoint get you above the city glow quickly.",
            "For a truly dark horizon, the coastal Ruta 9 running south toward Fuerte Bulnes offers pull-offs over the water, and the remote Cabo Froward hike reaches the southern tip of the South American mainland.",
          ],
        },
        {
          heading: "The Falkland Islands",
          paragraphs: [
            "Stanley sits near 52 degrees south with dark, sparsely populated skies and open South Atlantic horizons. The Cape Pembroke peninsula, a nature reserve about 11 km east of town, and nearby Gypsy Cove give low, south-facing coastal views away from the settlement's lights.",
            "Because the southern magnetic pole is offset toward Australia, displays in the South Atlantic sector are rarer than at the same latitude in the north, so treat any sighting as a genuine bonus.",
          ],
        },
        {
          heading: "Season, Kp, and Patagonian weather",
          paragraphs: [
            "The dark-sky window runs from about April to September, with June and July offering the longest nights. Ushuaia and Punta Arenas sit far enough south to catch displays during solid storms, but a bright, naked-eye show still generally wants a strong, high-Kp night because this sector sits farther from the geomagnetic pole than its map latitude suggests.",
            "Clouds and wind are the real gatekeepers here. Check the live city scores for Ushuaia and Punta Arenas on this site, wait for a clear break, and face south over open water.",
          ],
        },
      ],
      faqs: [
        { q: "Where in South America is best for the southern lights?", a: "The far south: Ushuaia in Argentina and Punta Arenas in Chile are the closest cities to the auroral zone, with the Falkland Islands also well placed out in the South Atlantic." },
        { q: "Is Ushuaia guaranteed to show aurora because it is so far south?", a: "No. Its latitude helps, but the southern magnetic pole's offset and frequent maritime cloud mean clear, storm-night timing matters more than latitude alone." },
        { q: "What Kp do I need in Patagonia?", a: "The far-south cities can show aurora during active storms, but plan around a strong, high-Kp night for a naked-eye display, and always pair it with a clear, dark southern horizon." },
      ],
    },
  ];
}

function glossaryEntries() {
  return [
    { term: "Aurora oval", definition: "The ring-shaped region around the magnetic pole where aurora is most likely. During stronger storms it can brighten and expand toward lower latitudes." },
    { term: "Kp index", definition: "A global geomagnetic activity scale. Higher Kp often means aurora can reach farther south, but local visibility still depends on sky conditions." },
    { term: "G storm watch", definition: "A NOAA geomagnetic storm watch category. G2 or stronger watches are useful signals for more frequent aurora forecast checks." },
    { term: "NOAA OVATION", definition: "A NOAA aurora forecast model that estimates short-term aurora probability and intensity across a geographic grid." },
    { term: "Cloud cover", definition: "The share of the sky expected to be covered by clouds. Lower cloud cover improves local aurora viewing chances." },
    { term: "Northern horizon", definition: "The part of the sky facing north. Mid-latitude viewers often need a dark, open northern horizon to catch low aurora." },
    { term: "Camera-first aurora", definition: "A weak aurora setup where a phone or camera may capture color before the naked eye sees a clear display." },
    { term: "Stale-while-revalidate", definition: "A caching pattern where the page can show recent old data while the system refreshes the newest forecast in the background." },
  ];
}

function linkCloud(items) {
  return `<div class="link-cloud">
    ${items.map(([href, label]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`).join("")}
  </div>`;
}

function guideCard(guide, prefix) {
  return `<article class="panel guide-card">
    <p class="kicker">${escapeHtml(guide.kicker)}</p>
    <h2><a href="${prefix}guides/${guide.slug}/">${escapeHtml(guide.title)}</a></h2>
    <p>${escapeHtml(guide.description)}</p>
    <a class="text-link" href="${prefix}guides/${guide.slug}/">Read guide</a>
  </article>`;
}

function glossaryCard(entry) {
  return `<article class="faq-item glossary-card">
    <h2>${escapeHtml(entry.term)}</h2>
    <p>${escapeHtml(entry.definition)}</p>
  </article>`;
}

function commentSection({ key, kicker, title, placeholder }) {
  return `<section class="comment-section" data-comment-section data-comment-key="${escapeHtml(key)}">
    <div class="comment-head">
      <div>
        <p class="kicker">${escapeHtml(kicker)}</p>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <span data-comment-count>Loading comments</span>
    </div>
    <form class="comment-form" data-comment-form>
      <div class="comment-fields">
        <label>
          <span>Name</span>
          <input name="name" type="text" maxlength="40" placeholder="Visitor" autocomplete="name">
        </label>
        <label>
          <span>Comment</span>
          <textarea name="comment" maxlength="600" rows="3" placeholder="${escapeHtml(placeholder)}" required></textarea>
        </label>
      </div>
      <div class="comment-actions">
        <p class="comment-status" data-comment-status role="status"></p>
        <button type="submit" data-comment-submit>Post</button>
      </div>
    </form>
    <div class="comment-list" data-comment-list></div>
  </section>`;
}

function breadcrumbLinks(items) {
  return `<nav class="breadcrumb" aria-label="Breadcrumb">
    ${items.map(([label, href], index) => {
      const isLast = index === items.length - 1 || !href;
      return isLast ? `<span>${escapeHtml(label)}</span>` : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    }).join("<span>/</span>")}
  </nav>`;
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
      a: "The public forecast can update from official feeds throughout the day. During a G2 or stronger watch, the live cache can refresh more frequently.",
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
    potentialAction: {
      "@type": "SearchAction",
      target: `${site.url}/api/forecast?city={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
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

function cityFaqItems(city) {
  const localFaqs = cityContent[city.slug]?.faqs || [];
  return [
    ...localFaqs,
    {
      q: `Can I see the ${auroraName(city)} in ${city.name} tonight?`,
      a: `Open this page for the live ${auroraName(city)} score, Kp forecast, cloud cover, and NOAA storm context for ${city.name}.`,
    },
    {
      q: `What matters most for ${city.name}?`,
      a: `Watch the city score, Kp forecast, cloud cover, and whether you can find a dark ${directionWords(city).horizon} horizon away from bright local lights.`,
    },
    {
      q: `How often does the ${city.name} forecast update?`,
      a: "The crawlable page keeps stable location guidance, while the live API refreshes forecast values from Cloudflare KV and official feeds.",
    },
  ];
}

function cityFaqSchema(city) {
  return faqPageSchema(cityFaqItems(city));
}

function collectionPageSchema({ title, description, path: pagePath, items }) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    url: `${site.url}${pagePath}`,
    isPartOf: { "@type": "WebSite", name: site.name, url: site.url },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: items.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: item.name,
        url: `${site.url}${item.path}`,
      })),
    },
    inLanguage: "en",
  };
}

function guideSchema(guide) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: guide.title,
    description: guide.description,
    url: `${site.url}/guides/${guide.slug}/`,
    isPartOf: { "@type": "WebSite", name: site.name, url: site.url },
    dateModified: buildLastmod,
    inLanguage: "en",
  };
}

function breadcrumbSchema(items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, item], index) => ({
      "@type": "ListItem",
      position: index + 1,
      name,
      item: `${site.url}${item === "/" ? "" : item}`,
    })),
  };
}

function faqPageSchema(items) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

function faqSchema() {
  return faqPageSchema(faqItems());
}

function regionSlug(city) {
  return slugify(`${city.region}-${city.country}`);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "location";
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, "");
}


function round1(value) {
  return Math.round(value * 10) / 10;
}

function formatCoord(lat, lon) {
  if (lat == null || lon == null) return "N/A";
  return `${round1(lat)}, ${round1(lon)}`;
}

function relativeAsset(pagePath) {
  const depth = pagePath.split("/").filter(Boolean).length;
  return depth === 0 ? "" : "../".repeat(depth);
}

function analyticsTag(id) {
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(id)}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","${escapeHtml(id)}");</script>`;
}

function cloudflareWebAnalyticsTag(token) {
  return `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${escapeHtml(token)}"}'></script>`;
}

function normalizeCloudflareWebAnalyticsToken(value) {
  const token = String(value || "").trim();
  if (token && !/^[a-f0-9]{32}$/.test(token)) {
    throw new Error("site.config.json cloudflareWebAnalyticsToken must be a 32-character lowercase hexadecimal token.");
  }
  return token;
}

function normalizePublisherId(value) {
  const id = String(value || "").trim().replace(/^ca-pub-/, "").replace(/^pub-/, "");
  return id ? `pub-${id}` : "";
}

function normalizeAdsenseAccountId(value) {
  const id = String(value || "").trim().replace(/^ca-pub-/, "").replace(/^pub-/, "");
  return id ? `ca-pub-${id}` : "";
}

function normalizeAdSlots(slots) {
  return {
    topBanner: String(slots.topBanner || "").trim(),
    inArticle: String(slots.inArticle || "").trim(),
  };
}

function normalizeContentLastmod(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("site.config.json contentLastmod must use YYYY-MM-DD.");
  }
  return date;
}

function adUnit({ slotKey, className = "", fallbackTitle, fallbackText, links }) {
  const slot = site.adsenseAdSlots[slotKey];
  if (site.adsenseClientId && slot) {
    return `<aside class="ad-shell ${className}" aria-label="Advertisement">
      <ins class="adsbygoogle"
        style="display:block"
        data-ad-client="${escapeHtml(site.adsenseClientId)}"
        data-ad-slot="${escapeHtml(slot)}"
        data-ad-format="auto"
        data-full-width-responsive="true"></ins>
      <script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>
    </aside>`;
  }
  return `<aside class="ad-shell ad-fallback ${className}">
    <div>
      <p class="kicker">Keep exploring</p>
      <h2>${escapeHtml(fallbackTitle)}</h2>
      <p>${escapeHtml(fallbackText)}</p>
    </div>
    ${linkCloud(links)}
  </aside>`;
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
