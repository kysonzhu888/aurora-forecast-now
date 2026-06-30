const searchInput = document.querySelector("[data-city-search]");
const liveSearchForm = document.querySelector("[data-live-search-form]");
const liveResult = document.querySelector("[data-live-result]");
const cityCards = [...document.querySelectorAll("[data-city-card]")];
const liveStatus = document.querySelector("[data-live-status]");
const liveNote = document.querySelector("[data-live-note]");
const liveFooterUpdated = document.querySelector("[data-live-footer-updated]");

if (searchInput && cityCards.length) {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    for (const card of cityCards) {
      const haystack = card.dataset.search || "";
      card.classList.toggle("hidden", query.length > 0 && !haystack.includes(query));
    }
  });
}

if (liveSearchForm && searchInput && liveResult) {
  liveSearchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    await searchLiveCity(query);
  });
}

refreshLiveForecast();

async function searchLiveCity(query) {
  showLiveResult(`<p>Checking ${escapeHtml(query)}...</p>`);
  try {
    const params = parseCoordinateQuery(query);
    const url = params
      ? `/api/forecast?lat=${encodeURIComponent(params.lat)}&lon=${encodeURIComponent(params.lon)}`
      : `/api/forecast?city=${encodeURIComponent(query)}`;
    const response = await fetch(url, { cache: "no-store" });
    const forecast = await response.json();
    if (!response.ok || !forecast.city) {
      showLiveResult(`<p><strong>No city match found.</strong> Try a larger nearby city or paste latitude, longitude.</p>`);
      return;
    }
    renderLiveCityResult(forecast);
  } catch (error) {
    showLiveResult(`<p><strong>Live lookup failed.</strong> Showing the static city list below.</p>`);
  }
}

async function refreshLiveForecast() {
  if (!liveStatus && !liveFooterUpdated && !cityCards.length) return;

  try {
    const response = await fetch("/api/forecast", { cache: "no-store" });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const forecast = await response.json();
    updateLiveStatus(forecast);
    updateCityCards(forecast);
  } catch (error) {
    if (liveStatus) liveStatus.textContent = "Static fallback";
    if (liveNote) liveNote.textContent = "Live forecast API is not available yet. Showing the last generated static forecast.";
  }
}

function updateLiveStatus(forecast) {
  if (!forecast.cache) return;

  const status = forecast.cache.status === "fresh" ? "Fresh" : forecast.cache.status === "stale" ? "Stale" : "Fallback";
  if (liveStatus) liveStatus.textContent = `${status} · ${forecast.cache.refreshMode}`;

  if (liveNote) {
    const age = formatAge(forecast.cache.ageSeconds);
    const storm = forecast.stormMode ? ` Storm mode G${forecast.stormLevel}.` : "";
    liveNote.textContent = `Updated ${age} ago from the live cache.${storm} Next refresh target: ${formatAge(forecast.cache.maxAgeSeconds)}.`;
  }

  if (liveFooterUpdated) {
    liveFooterUpdated.textContent = `Forecast guidance, not a guarantee. Updated ${formatDateTime(forecast.cache.updatedAt || forecast.generatedAt)}.`;
  }
}

function updateCityCards(forecast) {
  if (!forecast.cities || !cityCards.length) return;
  const bySlug = new Map(forecast.cities.map((city) => [city.slug, city]));

  for (const card of cityCards) {
    const city = bySlug.get(card.dataset.citySlug);
    if (!city) continue;

    const score = card.querySelector("[data-city-score]");
    const label = card.querySelector("[data-city-label]");
    const kp = card.querySelector("[data-city-kp]");
    const cloud = card.querySelector("[data-city-cloud]");
    const aurora = card.querySelector("[data-city-aurora]");

    if (score) score.textContent = city.score;
    if (label) {
      label.textContent = city.label;
      label.className = `badge ${city.label.toLowerCase()}`;
    }
    if (kp) kp.textContent = `Kp ${forecast.maxKp || "N/A"}`;
    if (cloud) cloud.textContent = `Cloud ${city.bestCloud == null ? "N/A" : `${city.bestCloud}%`}`;
    if (aurora) aurora.textContent = `Aurora ${city.aurora}`;
  }
}

function renderLiveCityResult(forecast) {
  const city = forecast.city;
  const location = [city.region, city.country].filter(Boolean).join(", ");
  const cloud = city.bestCloud == null ? "N/A" : `${city.bestCloud}%`;
  const source = city.source === "open-meteo-geocoding" ? "city database" : city.source === "coordinates" ? "coordinates" : "preset city";
  showLiveResult(`
    <div class="result-score">
      <div>
        <strong>${escapeHtml(city.name)}</strong>
        <p>${escapeHtml(location || "Custom location")} · ${escapeHtml(source)}</p>
      </div>
      <span class="badge ${city.label.toLowerCase()}">${escapeHtml(city.label)}</span>
    </div>
    <div class="result-score">
      <span class="score">${city.score}</span>
      <p>Kp ${forecast.maxKp || "N/A"} · Cloud ${cloud} · Aurora ${city.aurora}</p>
    </div>
    <p>${escapeHtml(city.guidance)}</p>
    <p>Live cache: ${escapeHtml(forecast.cache.status)} · ${escapeHtml(forecast.cache.refreshMode)} · updated ${formatAge(forecast.cache.ageSeconds)} ago.</p>
  `);
}

function showLiveResult(html) {
  if (!liveResult) return;
  liveResult.hidden = false;
  liveResult.innerHTML = html;
}

function parseCoordinateQuery(query) {
  const match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}

function formatDateTime(value) {
  if (!value) return "recently";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
