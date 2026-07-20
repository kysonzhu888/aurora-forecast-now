const searchInput = document.querySelector("[data-city-search]");
const liveSearchForm = document.querySelector("[data-live-search-form]");
const liveResult = document.querySelector("[data-live-result]");
const cityCards = [...document.querySelectorAll("[data-city-card]")];
const liveStatus = document.querySelector("[data-live-status]");
const liveNote = document.querySelector("[data-live-note]");
const liveFooterUpdated = document.querySelector("[data-live-footer-updated]");
const liveMaxKp = document.querySelector("[data-live-max-kp]");
const liveForecastTime = document.querySelector("[data-live-forecast-time]");
const liveBestCity = document.querySelector("[data-live-best-city]");
const liveStormSummary = document.querySelector("[data-live-storm-summary]");
const liveCityDetail = document.querySelector("[data-live-city-detail]");

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
  if (!liveStatus && !liveFooterUpdated && !cityCards.length && !liveCityDetail) return;

  try {
    const response = await fetch("/api/forecast", { cache: "no-store" });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const forecast = await response.json();
    updateLiveStatus(forecast);
    updateLiveSummary(forecast);
    updateCityCards(forecast);
    updateLiveCityDetail(forecast);
  } catch (error) {
    if (liveStatus) liveStatus.textContent = "Unavailable";
    if (liveNote) liveNote.textContent = "Live forecast data is temporarily unavailable. Use the viewing guides and NOAA source link while it reconnects.";
    setLiveCityDetailText("[data-live-city-guidance]", "Live forecast data is temporarily unavailable. Use the local viewing guide and NOAA source link while it reconnects.");
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

function updateLiveSummary(forecast) {
  if (liveMaxKp) liveMaxKp.textContent = forecast.maxKp || "N/A";
  if (liveForecastTime) liveForecastTime.textContent = formatDateTime(forecast.forecastTime || forecast.cache?.updatedAt);
  if (liveBestCity) liveBestCity.textContent = forecast.cities?.[0]?.name || "N/A";
  if (liveStormSummary) {
    liveStormSummary.textContent = forecast.stormSummary || "No active NOAA storm summary is available right now.";
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

function updateLiveCityDetail(forecast) {
  if (!liveCityDetail || !forecast.cities) return;
  const city = forecast.cities.find((candidate) => candidate.slug === liveCityDetail.dataset.citySlug);
  if (!city) return;

  const label = liveCityDetail.querySelector("[data-live-city-label]");
  if (label) {
    label.textContent = city.label;
    label.className = `badge ${city.label.toLowerCase()}`;
  }

  setLiveCityDetailText("[data-live-city-score]", city.score);
  setLiveCityDetailText("[data-live-city-kp]", forecast.maxKp || "N/A");
  setLiveCityDetailText("[data-live-city-aurora]", city.aurora ?? "N/A");
  setLiveCityDetailText("[data-live-city-cloud]", city.bestCloud == null ? "N/A" : `${city.bestCloud}%`);
  setLiveCityDetailText("[data-live-city-guidance]", city.guidance);
  setLiveCityDetailText("[data-live-city-plan]", city.guidance);
  setLiveCityDetailText("[data-live-city-updated]", formatDateTime(forecast.cache?.updatedAt || forecast.generatedAt));
  setLiveCityDetailText("[data-live-city-forecast-time]", formatDateTime(forecast.forecastTime));
}

function setLiveCityDetailText(selector, value) {
  const element = liveCityDetail?.querySelector(selector);
  if (element) element.textContent = String(value ?? "N/A");
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

document.querySelectorAll("[data-comment-section]").forEach((section) => {
  const pageKey = section.dataset.commentKey;
  const form = section.querySelector("[data-comment-form]");
  const list = section.querySelector("[data-comment-list]");
  const status = section.querySelector("[data-comment-status]");
  const count = section.querySelector("[data-comment-count]");
  const submit = section.querySelector("[data-comment-submit]");

  if (!pageKey || !form || !list) return;

  const setStatus = (message, tone = "") => {
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  };

  const setLoading = (isLoading) => {
    if (!submit) return;
    submit.disabled = isLoading;
    submit.textContent = isLoading ? "Posting..." : "Post";
  };

  const fetchComments = async () => {
    const response = await fetch(`/api/comments?pageKey=${encodeURIComponent(pageKey)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.error || "Could not load comments.");
    }
    return Array.isArray(payload.comments) ? payload.comments : [];
  };

  const postComment = async (name, comment) => {
    const response = await fetch("/api/comments", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pageKey, name, comment }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload.error || "Could not post comment.");
    }
    return Array.isArray(payload.comments) ? payload.comments : [];
  };

  const formatDate = (value) => {
    try {
      return value ? new Date(value).toLocaleDateString() : "";
    } catch {
      return "";
    }
  };

  const render = (comments) => {
    list.replaceChildren();
    if (count) {
      count.textContent = comments.length === 1 ? "1 comment" : `${comments.length} comments`;
    }

    if (!comments.length) {
      const empty = document.createElement("p");
      empty.className = "comment-empty";
      empty.textContent = "No comments yet. Add the first sky note.";
      list.append(empty);
      return;
    }

    comments.forEach((comment) => {
      const item = document.createElement("article");
      item.className = "comment-item";

      const meta = document.createElement("div");
      meta.className = "comment-meta";

      const name = document.createElement("strong");
      name.textContent = comment.name || "Visitor";

      const time = document.createElement("time");
      time.dateTime = comment.createdAt || "";
      time.textContent = formatDate(comment.createdAt);

      const text = document.createElement("p");
      text.textContent = comment.body || "";

      meta.append(name, time);
      item.append(meta, text);
      list.append(item);
    });
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get("name") || "Visitor").trim().slice(0, 40) || "Visitor";
    const text = String(data.get("comment") || "").trim().slice(0, 600);
    if (!text) {
      setStatus("Write a comment before posting.", "error");
      return;
    }

    setLoading(true);
    setStatus("Posting...");
    postComment(name, text)
      .then((comments) => {
        form.reset();
        render(comments);
        setStatus("Posted. Thanks for the note.", "success");
      })
      .catch((error) => {
        setStatus(error.message || "Could not post comment.", "error");
      })
      .finally(() => {
        setLoading(false);
      });
  });

  fetchComments()
    .then((comments) => {
      render(comments);
      setStatus("");
    })
    .catch((error) => {
      render([]);
      setStatus(error.message || "Comments are temporarily unavailable.", "error");
    });
});

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Comments API is unavailable on this local server. Start the site with Wrangler dev.");
  }
  return response.json();
}

// Storm alert waitlist：与评论表单同风格，POST /api/alerts/subscribe
document.querySelectorAll("[data-alert-signup]").forEach((panel) => {
  const form = panel.querySelector("[data-alert-form]");
  const status = panel.querySelector("[data-alert-status]");
  if (!form) return;

  const setStatus = (message, tone = "") => {
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    const email = form.elements.email ? form.elements.email.value : "";
    const website = form.elements.website ? form.elements.website.value : "";
    const threshold = form.elements.threshold ? Number(form.elements.threshold.value) : 60;
    const citySlug = form.elements.citySlug
      ? form.elements.citySlug.value
      : (panel.dataset.alertCity || "");
    if (submit) submit.disabled = true;
    setStatus("Joining...");
    try {
      const response = await fetch("/api/alerts/subscribe", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          website,
          threshold,
          citySlug,
          sourcePath: window.location.pathname,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not join the waitlist.");
      setStatus(
        payload.delivery === "email"
          ? "Check your inbox to confirm storm alerts."
          : "Saved to the waitlist. Email delivery is not live yet.",
        "ok",
      );
      form.reset();
    } catch (error) {
      setStatus(error.message || "Something went wrong. Please try again.", "error");
      if (submit) submit.disabled = false;
    }
  });
});
