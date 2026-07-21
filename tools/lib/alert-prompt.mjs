export function renderAlertPrompt({ cities = [], selectedCitySlug = "" } = {}) {
  const cityOptions = [...cities]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (city) =>
        `<option value="${escapeHtml(city.slug)}"${city.slug === selectedCitySlug ? " selected" : ""}>${escapeHtml(city.name)}, ${escapeHtml(city.region)}</option>`,
    )
    .join("");

  return `
  <dialog class="alert-prompt" data-alert-prompt data-alert-signup data-alert-city="${escapeHtml(selectedCitySlug)}" aria-labelledby="alert-prompt-title" aria-describedby="alert-prompt-description">
    <div class="alert-prompt-shell">
      <div class="alert-prompt-content">
        <button class="alert-prompt-close" type="button" data-alert-prompt-close aria-label="Close storm reminder" title="Close storm reminder">&times;</button>
        <p class="kicker">Free email alert</p>
        <h2 id="alert-prompt-title">Let us watch the sky for you</h2>
        <p id="alert-prompt-description">Choose a city. We will send one confirmation now, then email only when conditions reach Good or better.</p>
        <form class="alert-prompt-form" data-alert-form>
          <label>
            Viewing city
            <select name="citySlug" required autofocus>
              <option value=""${selectedCitySlug ? "" : " selected"} disabled>Select a city</option>
              ${cityOptions}
            </select>
          </label>
          <label>
            Email address
            <input name="email" type="email" maxlength="254" placeholder="you@example.com" autocomplete="email" required>
          </label>
          <input name="threshold" type="hidden" value="60">
          <input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0;opacity:0">
          <button class="button" type="submit">Set email alert</button>
        </form>
        <p class="alert-status" data-alert-status role="status" aria-live="polite"></p>
        <p class="alert-prompt-privacy">Used only for aurora alerts. Unsubscribe in one click. We never sell your address.</p>
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
