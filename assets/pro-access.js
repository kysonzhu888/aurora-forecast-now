(() => {
  const root = document.querySelector("[data-pro-access-page]");
  if (!root) return;

  const config = window.AURORA_PRO || {};
  const storageKey = config.storageKey || "aurora_pro_access_v1";
  const locationsStorageKey = config.locationsStorageKey || "aurora_pro_locations_v1";
  const maxSavedLocations = clamp(Number(config.maxSavedLocations) || 5, 2, 5);
  const lockedPanel = root.querySelector("[data-pro-locked]");
  const unlockedPanel = root.querySelector("[data-pro-unlocked]");
  const licenseForm = root.querySelector("[data-pro-license-form]");
  const licenseInput = licenseForm?.querySelector("input[name='licenseKey']");
  const licenseStatus = root.querySelector("[data-pro-license-status]");
  const lockButton = root.querySelector("[data-pro-lock]");
  const locationForm = root.querySelector("[data-pro-location-form]");
  const locationInput = locationForm?.querySelector("input[name='location']");
  const locationList = root.querySelector("[data-pro-location-list]");
  const refreshButton = root.querySelector("[data-pro-refresh]");
  const comparisonStatus = root.querySelector("[data-pro-comparison-status]");
  const comparisonResults = root.querySelector("[data-pro-comparison-results]");
  let savedLocations = readSavedLocations();
  let access = readStoredAccess();

  initialize();

  async function initialize() {
    applyAccessState(false);
    renderSavedLocations();
    trackFunnelEvent("pro_view");
    bindInteractions();

    const incomingKey = consumeLicenseKeyFromUrl();
    if (incomingKey) {
      if (licenseInput) licenseInput.value = incomingKey;
      await activateLicense(incomingKey, { reportAttempt: true });
      return;
    }

    if (access?.licenseKey) {
      setStatus(licenseStatus, "Checking saved Aurora Pro access...");
      const result = await validateLicense(access.licenseKey);
      if (result.ok) {
        applyAccessState(true);
        setStatus(licenseStatus, "Aurora Pro is active on this browser.", "success");
        if (savedLocations.length) refreshComparison();
      } else {
        setStatus(licenseStatus, result.error || "Saved access could not be verified.", "error");
      }
    }
  }

  function bindInteractions() {
    root.querySelector("[data-pro-checkout]")?.addEventListener("click", () => {
      trackFunnelEvent("checkout_click");
    });

    licenseForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = normalizeLicenseKey(licenseInput?.value);
      if (!key) {
        setStatus(licenseStatus, "Paste your Aurora Pro access key first.", "error");
        return;
      }
      await activateLicense(key, { reportAttempt: true });
    });

    lockButton?.addEventListener("click", () => {
      access = null;
      removeStorage(storageKey);
      applyAccessState(false);
      setStatus(licenseStatus, "Aurora Pro is locked on this browser.");
    });

    locationForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const location = normalizeLocation(locationInput?.value);
      if (!location) {
        setStatus(comparisonStatus, "Enter a city to add.", "error");
        return;
      }
      if (savedLocations.some((value) => value.toLowerCase() === location.toLowerCase())) {
        setStatus(comparisonStatus, `${location} is already saved.`, "error");
        return;
      }
      if (savedLocations.length >= maxSavedLocations) {
        setStatus(comparisonStatus, `You can save up to ${maxSavedLocations} locations.`, "error");
        return;
      }

      savedLocations.push(location);
      writeJsonStorage(locationsStorageKey, savedLocations);
      if (locationInput) locationInput.value = "";
      renderSavedLocations();
      setStatus(comparisonStatus, `${location} added. Refreshing the comparison...`, "success");
      trackFunnelEvent("location_add");
      refreshComparison();
    });

    refreshButton?.addEventListener("click", refreshComparison);
  }

  async function activateLicense(licenseKey, { reportAttempt }) {
    if (reportAttempt) trackFunnelEvent("license_attempt");
    setStatus(licenseStatus, "Checking Aurora Pro access...");
    setLicenseFormDisabled(true);
    const result = await validateLicense(licenseKey);
    setLicenseFormDisabled(false);

    if (!result.ok) {
      if (reportAttempt) trackFunnelEvent("license_failure");
      setStatus(licenseStatus, result.error || "That key did not unlock Aurora Pro.", "error");
      return false;
    }

    access = { unlocked: true, licenseKey, unlockedAt: new Date().toISOString() };
    const persisted = writeJsonStorage(storageKey, access);
    if (licenseInput) licenseInput.value = "";
    applyAccessState(true);
    if (reportAttempt) trackFunnelEvent("license_success");
    setStatus(
      licenseStatus,
      persisted
        ? "Aurora Pro is active on this browser."
        : "Aurora Pro is active for this tab, but browser storage is unavailable.",
      "success",
    );
    if (savedLocations.length) refreshComparison();
    return true;
  }

  async function validateLicense(licenseKey) {
    try {
      const response = await fetch("/api/pro/license", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok || !payload.ok) {
        return { ok: false, status: response.status, error: payload.error || "License validation failed." };
      }
      return { ok: true, license: payload.license };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: error.message || "License validation is temporarily unavailable.",
      };
    }
  }

  async function refreshComparison() {
    if (!access?.licenseKey) {
      setStatus(comparisonStatus, "Activate Aurora Pro before refreshing locations.", "error");
      return;
    }
    if (!savedLocations.length) {
      comparisonResults?.replaceChildren();
      setStatus(comparisonStatus, "Add at least one city first.", "error");
      return;
    }

    setRefreshDisabled(true);
    setStatus(comparisonStatus, `Refreshing ${savedLocations.length} saved location${savedLocations.length === 1 ? "" : "s"}...`);
    trackFunnelEvent("comparison_run");
    const results = await Promise.all(savedLocations.map(loadLocationForecast));
    setRefreshDisabled(false);
    renderComparisonResults(results);

    const successes = results.filter((result) => result.ok).length;
    setStatus(
      comparisonStatus,
      successes === results.length
        ? `Updated ${successes} location${successes === 1 ? "" : "s"} from the live forecast.`
        : `Updated ${successes} of ${results.length} locations. Check the city names that failed.`,
      successes ? "success" : "error",
    );
  }

  async function loadLocationForecast(location) {
    try {
      const response = await fetch(`/api/forecast?q=${encodeURIComponent(location)}`, {
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonResponse(response);
      if (!response.ok || !payload.city) {
        throw new Error(payload.message || payload.error || "Location not found.");
      }
      return { ok: true, requestedName: location, payload };
    } catch (error) {
      return { ok: false, requestedName: location, error: error.message || "Forecast unavailable." };
    }
  }

  function renderSavedLocations() {
    if (!locationList) return;
    locationList.replaceChildren();
    savedLocations.forEach((location) => {
      const item = document.createElement("span");
      item.className = "pro-location-chip";
      item.append(document.createTextNode(location));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${location}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        savedLocations = savedLocations.filter((value) => value !== location);
        writeJsonStorage(locationsStorageKey, savedLocations);
        renderSavedLocations();
        refreshComparison();
      });
      item.append(remove);
      locationList.append(item);
    });
  }

  function renderComparisonResults(results) {
    if (!comparisonResults) return;
    comparisonResults.replaceChildren();
    const sorted = [...results].sort((left, right) => {
      if (left.ok !== right.ok) return left.ok ? -1 : 1;
      return (right.payload?.city?.score || 0) - (left.payload?.city?.score || 0);
    });
    sorted.forEach((result) => comparisonResults.append(createComparisonCard(result)));
  }

  function createComparisonCard(result) {
    const card = document.createElement("article");
    card.className = "pro-comparison-card";
    if (!result.ok) {
      card.classList.add("pro-comparison-card--error");
      appendTextElement(card, "p", "kicker", result.requestedName);
      appendTextElement(card, "h3", "", "Forecast unavailable");
      appendTextElement(card, "p", "", result.error);
      return card;
    }

    const { city, maxKp, generatedAt } = result.payload;
    const heading = document.createElement("div");
    heading.className = "pro-comparison-heading";
    const titleBlock = document.createElement("div");
    appendTextElement(titleBlock, "p", "kicker", city.country || city.region || "Saved location");
    appendTextElement(titleBlock, "h3", "", city.name || result.requestedName);
    const score = appendTextElement(heading, "strong", "pro-comparison-score", String(city.score ?? "—"));
    score.setAttribute("aria-label", `Aurora score ${city.score ?? "unknown"}`);
    heading.prepend(titleBlock);
    card.append(heading);

    const label = appendTextElement(card, "span", `badge ${badgeClass(city.label)}`, city.label || "Checking");
    label.setAttribute("data-pro-forecast-label", "");
    const stats = document.createElement("dl");
    stats.className = "pro-comparison-stats";
    appendDefinition(stats, "Max Kp", maxKp ?? "N/A");
    appendDefinition(stats, "Best cloud", city.bestCloud == null ? "N/A" : `${city.bestCloud}%`);
    appendDefinition(stats, "Watch window", city.watchWindow || "Check local twilight");
    card.append(stats);
    appendTextElement(card, "p", "pro-comparison-guidance", city.guidance || "Check the live sky and local weather before traveling.");
    appendTextElement(card, "p", "pro-comparison-updated", `Forecast generated ${formatDateTime(generatedAt)}.`);
    return card;
  }

  function applyAccessState(isUnlocked) {
    if (lockedPanel) lockedPanel.hidden = isUnlocked;
    if (unlockedPanel) unlockedPanel.hidden = !isUnlocked;
    root.classList.toggle("pro-is-unlocked", isUnlocked);
  }

  function setLicenseFormDisabled(disabled) {
    licenseForm?.querySelectorAll("input, button").forEach((control) => { control.disabled = disabled; });
  }

  function setRefreshDisabled(disabled) {
    if (refreshButton) refreshButton.disabled = disabled;
  }

  function setStatus(element, message, tone = "") {
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function trackFunnelEvent(eventName) {
    const payload = JSON.stringify({
      eventName,
      pageType: "pro",
      locationCount: savedLocations.length,
    });
    if (navigator.sendBeacon) {
      const accepted = navigator.sendBeacon(
        "/api/pro/funnel",
        new Blob([payload], { type: "text/plain" }),
      );
      if (accepted) return;
    }
    fetch("/api/pro/funnel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }

  function consumeLicenseKeyFromUrl() {
    const url = new URL(window.location.href);
    const key = normalizeLicenseKey(
      url.searchParams.get("license_key")
      || url.searchParams.get("licenseKey")
      || url.searchParams.get("key"),
    );
    if (!key) return "";
    url.searchParams.delete("license_key");
    url.searchParams.delete("licenseKey");
    url.searchParams.delete("key");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    return key;
  }

  function readStoredAccess() {
    const value = readJsonStorage(storageKey, null);
    return value?.unlocked && normalizeLicenseKey(value.licenseKey) ? value : null;
  }

  function readSavedLocations() {
    const values = readJsonStorage(locationsStorageKey, []);
    if (!Array.isArray(values)) return [];
    const unique = [];
    values.forEach((value) => {
      const location = normalizeLocation(value);
      if (location && !unique.some((entry) => entry.toLowerCase() === location.toLowerCase())) {
        unique.push(location);
      }
    });
    return unique.slice(0, maxSavedLocations);
  }

  function readJsonStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // The current tab still locks even when browser storage is unavailable.
    }
  }

  async function readJsonResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("Aurora Pro API is unavailable on this server.");
    }
    return response.json();
  }

  function appendTextElement(parent, tagName, className, value) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(value ?? "");
    parent.append(element);
    return element;
  }

  function appendDefinition(parent, term, value) {
    const row = document.createElement("div");
    appendTextElement(row, "dt", "", term);
    appendTextElement(row, "dd", "", value);
    parent.append(row);
  }

  function badgeClass(label) {
    return {
      Great: "great",
      Good: "good",
      Possible: "possible",
      Low: "low",
    }[label] || "possible";
  }

  function formatDateTime(value) {
    if (!value) return "recently";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleString();
  }

  function normalizeLicenseKey(value) {
    return String(value || "").replace(/\s+/g, "").slice(0, 120);
  }

  function normalizeLocation(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
})();
