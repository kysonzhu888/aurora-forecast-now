const searchInput = document.querySelector("[data-city-search]");
const cityCards = [...document.querySelectorAll("[data-city-card]")];
const liveStatus = document.querySelector("[data-live-status]");
const liveNote = document.querySelector("[data-live-note]");

if (searchInput && cityCards.length) {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    for (const card of cityCards) {
      const haystack = card.dataset.search || "";
      card.classList.toggle("hidden", query.length > 0 && !haystack.includes(query));
    }
  });
}

refreshLiveForecast();

async function refreshLiveForecast() {
  if (!liveStatus && !cityCards.length) return;

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
  if (!liveStatus || !forecast.cache) return;

  const status = forecast.cache.status === "fresh" ? "Fresh" : forecast.cache.status === "stale" ? "Stale" : "Fallback";
  liveStatus.textContent = `${status} · ${forecast.cache.refreshMode}`;

  if (liveNote) {
    const age = formatAge(forecast.cache.ageSeconds);
    const storm = forecast.stormMode ? ` Storm mode G${forecast.stormLevel}.` : "";
    liveNote.textContent = `Updated ${age} ago from the live cache.${storm} Next refresh target: ${formatAge(forecast.cache.maxAgeSeconds)}.`;
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

function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}
