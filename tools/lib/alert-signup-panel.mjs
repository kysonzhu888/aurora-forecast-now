export function renderAlertSignupPanel({ city = null, cities = [] } = {}) {
  const citySlug = city?.slug || "";
  const target = city?.name || "your city";
  const availableCities = city
    ? [city]
    : [...cities].sort((left, right) => left.name.localeCompare(right.name));
  const cityOptions = availableCities
    .map((option) => {
      const selected = option.slug === citySlug ? " selected" : "";
      return `<option value="${escapeHtml(option.slug)}"${selected}>${escapeHtml(option.name)}, ${escapeHtml(option.region)}</option>`;
    })
    .join("");

  return `
            <article class="panel alert-signup" data-alert-signup data-alert-city="${escapeHtml(citySlug)}">
              <p class="kicker">Storm alerts</p>
              <h3>Get an email when a storm reaches ${escapeHtml(target)}</h3>
              <p>Set one clear trigger. We will either send a live confirmation or save the same preference for launch.</p>
              <form class="comment-form alert-form" data-alert-form>
                <ol class="alert-steps">
                  <li class="alert-step alert-location">
                    <label>
                      <span class="alert-step-heading"><b aria-hidden="true">1</b><span><strong>Choose a location</strong><small>Where you want to watch</small></span></span>
                      <select name="citySlug" required>
                        <option value=""${city ? "" : " selected"} disabled>Select a city</option>
                        ${cityOptions}
                      </select>
                    </label>
                  </li>
                  <li class="alert-step">
                    <fieldset class="alert-threshold">
                      <legend class="alert-step-heading"><b aria-hidden="true">2</b><span><strong>Choose your minimum level</strong><small>We alert at this score or higher</small></span></legend>
                      <div class="alert-threshold-options">
                        <label class="alert-threshold-option"><input type="radio" name="threshold" value="50"><span><strong>Possible</strong><small>Score 50+</small></span></label>
                        <label class="alert-threshold-option"><input type="radio" name="threshold" value="60" checked><span><strong>Good</strong><small>Score 60+</small></span></label>
                        <label class="alert-threshold-option"><input type="radio" name="threshold" value="70"><span><strong>Strong</strong><small>Score 70+</small></span></label>
                        <label class="alert-threshold-option"><input type="radio" name="threshold" value="80"><span><strong>Rare storm</strong><small>Score 80+</small></span></label>
                      </div>
                    </fieldset>
                  </li>
                  <li class="alert-step alert-email">
                    <label>
                      <span class="alert-step-heading"><b aria-hidden="true">3</b><span><strong>Add your email</strong><small>Used only for this alert</small></span></span>
                      <input name="email" type="email" maxlength="254" placeholder="you@example.com" autocomplete="email" required>
                    </label>
                  </li>
                </ol>
                <input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;height:0;width:0;opacity:0">
                <button type="submit" class="text-link">Save my alert</button>
              </form>
              <p class="alert-status" data-alert-status role="status" aria-live="polite"></p>
              <div class="alert-how">
                <h4>How alerts work</h4>
                <ol>
                  <li><strong>Choose a location</strong><span>Pick the city you plan to watch from.</span></li>
                  <li><strong>Wait for a storm</strong><span>We compare the live score with your minimum.</span></li>
                  <li><strong>Check cloud cover</strong><span>Review local clouds before heading out.</span></li>
                </ol>
              </div>
            </article>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
