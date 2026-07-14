const DEFAULT_MY_ORDERS_URL = "https://app.lemonsqueezy.com/my-orders";

export function normalizeProConfig(rawConfig = {}) {
  const checkoutUrl = normalizeHttpsUrl(rawConfig.checkoutUrl, "checkoutUrl");
  const enabled = rawConfig.enabled === true;
  if (enabled && !checkoutUrl) {
    throw new Error("site.config.json pro.checkoutUrl is required when pro.enabled is true.");
  }

  return {
    enabled,
    publicPreview: rawConfig.publicPreview !== false,
    productName: String(rawConfig.productName || "Aurora Pro Lifetime").trim(),
    priceLabel: String(rawConfig.priceLabel || "Founding lifetime access").trim(),
    checkoutUrl,
    myOrdersUrl: normalizeHttpsUrl(rawConfig.myOrdersUrl || DEFAULT_MY_ORDERS_URL, "myOrdersUrl"),
    storageKey: String(rawConfig.storageKey || "aurora_pro_access_v1").trim(),
    locationsStorageKey: String(rawConfig.locationsStorageKey || "aurora_pro_locations_v1").trim(),
    maxSavedLocations: clampSavedLocations(rawConfig.maxSavedLocations),
  };
}

export function publicProConfig(proConfig) {
  return {
    enabled: proConfig.enabled,
    checkoutUrl: proConfig.enabled ? proConfig.checkoutUrl : "",
    storageKey: proConfig.storageKey,
    locationsStorageKey: proConfig.locationsStorageKey,
    maxSavedLocations: proConfig.maxSavedLocations,
  };
}

export function renderProPageBody(proConfig) {
  const purchasePanel = proConfig.enabled
    ? `<div class="pro-purchase">
        <p class="kicker">Founding offer</p>
        <strong class="pro-price">${escapeHtml(proConfig.priceLabel)}</strong>
        <a class="button" href="${escapeHtml(proConfig.checkoutUrl)}" rel="noopener" data-pro-checkout>Get Aurora Pro</a>
        <p class="pro-fine-print">One purchase unlocks this browser with the access key on your Lemon Squeezy receipt.</p>
      </div>`
    : `<div class="pro-purchase pro-purchase--preview">
        <p class="kicker">Existing access</p>
        <strong class="pro-price">Aurora Pro preview</strong>
        <p>Purchase checkout stays hidden until the dedicated Aurora product and successful-license path are verified. Existing founding keys can be activated below.</p>
      </div>`;

  return `<main class="pro-page" data-pro-access-page>
    <section class="pro-hero">
      <div>
        <p class="kicker">Aurora Pro</p>
        <h1>Compare the places you actually watch</h1>
        <p class="lead">Save up to ${proConfig.maxSavedLocations} cities and refresh their live aurora score, Kp, cloud cover, watch window, and guidance in one view. Public city forecasts stay free.</p>
      </div>
      <div class="pro-benefits" aria-label="Aurora Pro benefits">
        <span>Live multi-city comparison</span>
        <span>Saved on this browser</span>
        <span>No account required</span>
        <span>Free forecast pages stay open</span>
      </div>
    </section>

    <section class="pro-gate" data-pro-locked>
      <div class="pro-gate-copy">
        <p class="kicker">${escapeHtml(proConfig.productName)}</p>
        <h2>One dashboard for every dark-sky option</h2>
        <p>Use the free forecast first. Aurora Pro adds the convenience of keeping several locations together when a storm makes the driving decision time-sensitive.</p>
        <ul>
          <li>Compare up to ${proConfig.maxSavedLocations} saved places.</li>
          <li>Refresh all locations against the same live forecast.</li>
          <li>Keep the list locally without creating an account.</li>
        </ul>
      </div>
      ${purchasePanel}
      <form class="pro-license-form" data-pro-license-form>
        <label for="aurora-pro-license">Already have an Aurora Pro access key?</label>
        <div>
          <input id="aurora-pro-license" name="licenseKey" type="text" maxlength="120" autocomplete="off" placeholder="Paste your access key" required>
          <button class="button secondary" type="submit">Activate access</button>
        </div>
        <p class="pro-status" data-pro-license-status role="status"></p>
      </form>
      ${proConfig.enabled ? `<p class="pro-order-help">Lost the key? <a href="${escapeHtml(proConfig.myOrdersUrl)}" target="_blank" rel="noopener">Open Lemon Squeezy My Orders</a>.</p>` : ""}
    </section>

    <section class="pro-dashboard" data-pro-unlocked hidden>
      <div class="pro-dashboard-head">
        <div>
          <p class="kicker">Your watch list</p>
          <h2>Saved-location comparison</h2>
          <p>Try a city such as Fairbanks, Tromsø, Reykjavík, or Hobart. Results use the same live forecast API as the public city pages.</p>
        </div>
        <button class="button secondary" type="button" data-pro-lock>Lock this browser</button>
      </div>
      <form class="pro-location-form" data-pro-location-form>
        <label for="aurora-pro-location">Add a city</label>
        <div>
          <input id="aurora-pro-location" name="location" type="search" maxlength="80" autocomplete="off" placeholder="e.g. Tromso" required>
          <button class="button" type="submit">Add location</button>
        </div>
      </form>
      <div class="pro-location-list" data-pro-location-list aria-label="Saved locations"></div>
      <div class="pro-dashboard-actions">
        <button class="button" type="button" data-pro-refresh>Refresh comparison</button>
        <p class="pro-status" data-pro-comparison-status role="status"></p>
      </div>
      <div class="pro-comparison-grid" data-pro-comparison-results></div>
    </section>

    <section class="pro-boundary">
      <h2>What this does—and does not do</h2>
      <p>Aurora scores are guidance, never a guarantee. Pro does not hide public forecasts, and the current storm-alert form remains a free launch waitlist rather than a paid email service.</p>
    </section>
  </main>`;
}

export function serializeProClientConfig(proConfig) {
  return JSON.stringify(publicProConfig(proConfig)).replaceAll("<", "\\u003c");
}

function clampSavedLocations(value) {
  const parsed = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 5;
  return Math.min(5, Math.max(2, parsed));
}

function normalizeHttpsUrl(value, fieldName) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`site.config.json pro.${fieldName} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`site.config.json pro.${fieldName} must use HTTPS.`);
  }
  return url.toString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
