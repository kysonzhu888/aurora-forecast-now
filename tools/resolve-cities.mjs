import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const seeds = JSON.parse(fs.readFileSync(path.join(root, "data", "city-seeds.json"), "utf8"));

const delayMs = 140;
const geocodingEndpoint = "https://geocoding-api.open-meteo.com/v1/search";
const countryNames = {
  FO: "Faroe Islands",
  GL: "Greenland",
  SJ: "Svalbard and Jan Mayen",
};

const legacySlugs = new Map([
  ["Fairbanks|Alaska|US", "fairbanks"],
  ["Anchorage|Alaska|US", "anchorage"],
  ["Seattle|Washington|US", "seattle"],
  ["Spokane|Washington|US", "spokane"],
  ["Portland|Oregon|US", "portland"],
  ["Boise|Idaho|US", "boise"],
  ["Missoula|Montana|US", "missoula"],
  ["Helena|Montana|US", "helena"],
  ["Billings|Montana|US", "billings"],
  ["Grand Forks|North Dakota|US", "grand-forks"],
  ["Fargo|North Dakota|US", "fargo"],
  ["Minneapolis|Minnesota|US", "minneapolis"],
  ["Duluth|Minnesota|US", "duluth"],
  ["Madison|Wisconsin|US", "madison"],
  ["Green Bay|Wisconsin|US", "green-bay"],
  ["Chicago|Illinois|US", "chicago"],
  ["Marquette|Michigan|US", "marquette"],
  ["Detroit|Michigan|US", "detroit"],
  ["Cleveland|Ohio|US", "cleveland"],
  ["Buffalo|New York|US", "buffalo"],
  ["Rochester|New York|US", "rochester"],
  ["Burlington|Vermont|US", "burlington"],
  ["Concord|New Hampshire|US", "concord"],
  ["Bangor|Maine|US", "bangor"],
  ["Boston|Massachusetts|US", "boston"],
  ["New York City|New York|US", "new-york-city"],
  ["Denver|Colorado|US", "denver"],
  ["Calgary|Alberta|CA", "calgary"],
  ["Edmonton|Alberta|CA", "edmonton"],
  ["Winnipeg|Manitoba|CA", "winnipeg"],
  ["Toronto|Ontario|CA", "toronto"],
  ["Ottawa|Ontario|CA", "ottawa"],
  ["Montreal|Quebec|CA", "montreal"],
  ["Yellowknife|Northwest Territories|CA", "yellowknife"],
  ["Reykjavik|Capital Region|IS", "reykjavik"],
]);

const cities = [];
const misses = [];
const seenSlugs = new Set();

for (const seed of seeds) {
  const match = await resolveSeed(seed);
  if (!match) {
    misses.push(seed);
    continue;
  }

  const region = match.admin1 || seed.admin1 || match.admin2 || match.country || countryNames[seed.countryCode] || "";
  const country = match.country || seed.country || countryNames[seed.countryCode] || seed.countryCode;
  const slug = seed.slug || legacySlugFor(seed, region) || slugify(`${seed.name}-${region || country}`);

  if (seenSlugs.has(slug)) {
    throw new Error(`Duplicate slug "${slug}" from ${seed.name}`);
  }
  seenSlugs.add(slug);

  cities.push({
    slug,
    name: seed.displayName || seed.name,
    region,
    country,
    lat: roundCoordinate(match.latitude),
    lon: roundCoordinate(match.longitude),
    timezone: match.timezone || "UTC",
    priority: seed.priority,
  });

  await sleep(delayMs);
}

function legacySlugFor(seed, region) {
  return legacySlugs.get(`${seed.name}|${region}|${seed.countryCode}`) || null;
}

if (misses.length) {
  console.error("Could not resolve these seeds:");
  console.error(JSON.stringify(misses, null, 2));
  process.exit(1);
}

cities.sort((a, b) => a.priority - b.priority || a.country.localeCompare(b.country) || a.region.localeCompare(b.region) || a.name.localeCompare(b.name));

fs.writeFileSync(path.join(root, "data", "cities.json"), `${JSON.stringify(cities, null, 2)}\n`);

console.log(`Resolved ${cities.length} city seeds into data/cities.json`);
console.log(`Open-Meteo cloud refresh requests per full forecast: ${Math.ceil(cities.length / 25)}`);

async function resolveSeed(seed) {
  if (Number.isFinite(seed.lat) && Number.isFinite(seed.lon)) {
    return {
      name: seed.name,
      country: seed.country,
      country_code: seed.countryCode,
      admin1: seed.admin1,
      latitude: seed.lat,
      longitude: seed.lon,
      timezone: seed.timezone,
    };
  }

  const query = seed.query || seed.name;
  const url = `${geocodingEndpoint}?name=${encodeURIComponent(query)}&count=10&language=en&format=json`;
  const response = await fetch(url, {
    headers: { "User-Agent": "AuroraForecastNow/0.3 hello@auroraforecastnow.com" },
  });
  if (!response.ok) throw new Error(`Open-Meteo geocoding failed for ${seed.name}: ${response.status}`);

  const data = await response.json();
  const rows = Array.isArray(data.results) ? data.results : [];
  const countryRows = rows.filter((row) => row.country_code === seed.countryCode);
  if (!countryRows.length) return null;

  if (!seed.admin1) return countryRows[0];

  const normalizedAdmin = normalize(seed.admin1);
  return countryRows.find((row) => normalize(row.admin1) === normalizedAdmin)
    || countryRows.find((row) => normalize(row.admin1).includes(normalizedAdmin) || normalizedAdmin.includes(normalize(row.admin1)))
    || null;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value) {
  return normalize(value).replace(/\s+/g, "-");
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
