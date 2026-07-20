export function renderAlertPrompt({ cities = [], assetPrefix = "" } = {}) {
  const cityOptions = [...cities]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (city) =>
        `<option value="${escapeHtml(city.slug)}">${escapeHtml(city.name)}, ${escapeHtml(city.region)}</option>`,
    )
    .join("");

  return `
  <dialog class="alert-prompt" data-alert-prompt data-alert-signup data-alert-city="" aria-labelledby="alert-prompt-title" aria-describedby="alert-prompt-description">
    <div class="alert-prompt-shell">
      <figure class="alert-prompt-media">
        <img class="alert-prompt-image" src="${escapeHtml(assetPrefix)}assets/photos/aurora-ai-cabin.webp" width="1448" height="1086" alt="An AI-created remote cabin under a subtle green aurora and a clear northern sky" loading="lazy" decoding="async">
        <figcaption>AI-generated visual</figcaption>
      </figure>
      <div class="alert-prompt-content">
        <button class="alert-prompt-close" type="button" data-alert-prompt-close aria-label="Close storm reminder" title="Close storm reminder">&times;</button>
        <p class="kicker">Free storm reminder</p>
        <h2 id="alert-prompt-title">Know when the aurora is worth a look</h2>
        <p id="alert-prompt-description">Choose a city and save a Good-or-better alert. We will tell you immediately whether email delivery is live or your request is queued for launch.</p>
        <form class="comment-form alert-prompt-form" data-alert-form>
          <label>
            Viewing city
            <select name="citySlug" required autofocus>
              <option value="" selected disabled>Select a city</option>
              ${cityOptions}
            </select>
          </label>
          <label>
            Email address
            <input name="email" type="email" maxlength="254" placeholder="you@example.com" autocomplete="email" required>
          </label>
          <input name="threshold" type="hidden" value="60">
          <input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0;opacity:0">
          <button type="submit">Set storm reminder</button>
        </form>
        <p class="alert-status" data-alert-status role="status" aria-live="polite"></p>
        <p class="alert-prompt-privacy">Only this alert uses your address. Unsubscribe anytime. We never sell it.</p>
      </div>
    </div>
  </dialog>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
