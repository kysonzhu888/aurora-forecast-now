export function renderAlertProcess() {
  return `
        <section class="section alert-process" aria-labelledby="alert-process-title">
          <div class="section-head">
            <div>
              <p class="kicker">Free email alerts</p>
              <h2 id="alert-process-title">How email alerts work</h2>
            </div>
            <button class="button secondary" type="button" data-open-alert-prompt>Set an alert</button>
          </div>
          <ol class="process-grid">
            <li class="process-step"><span>01</span><div><h3>Choose your city</h3><p>Pick the place where you plan to watch.</p></div></li>
            <li class="process-step"><span>02</span><div><h3>We watch the forecast</h3><p>The live score combines space weather and local cloud cover.</p></div></li>
            <li class="process-step"><span>03</span><div><h3>Open the email</h3><p>When conditions reach Good or better, we tell you it is worth checking the sky.</p></div></li>
          </ol>
        </section>`;
}

export function renderPracticalVisualStory({ assetPrefix = "" } = {}) {
  return `
        <section class="section home-services" aria-labelledby="services-title">
          <div class="section-head">
            <div>
              <p class="kicker">Plan the night</p>
              <h2 id="services-title">Everything you need before you leave</h2>
            </div>
            <p>A short forecast, a timely reminder, and practical field guidance. Nothing else competes for attention.</p>
          </div>
          <div class="service-list">
            ${serviceRow({
              assetPrefix,
              file: "aurora-ai-field.webp",
              width: 1448,
              height: 1086,
              alt: "An AI-created aurora observer preparing a tripod beside a dark road",
              kicker: "City forecast",
              title: "A clear answer for tonight",
              copy: "Search your city and see one viewing score, the best cloud window, and the storm strength. Use it as a go-or-wait decision before you drive.",
              link: "locations/",
              linkLabel: "Find your city",
            })}
            ${serviceRow({
              assetPrefix,
              file: "aurora-ai-city-edge.webp",
              width: 1448,
              height: 1086,
              alt: "An AI-created northern town edge with aurora beyond the street lights",
              kicker: "Email alerts",
              title: "No app to remember to open",
              copy: "Confirm once, then hear from us only when your selected city reaches a worthwhile viewing score. Every message includes one-click unsubscribe.",
              actionLabel: "Set a free alert",
              reverse: true,
            })}
            <article class="service-row">
              <div class="service-visual-pair">
                ${visual({
                  assetPrefix,
                  file: "aurora-ai-coast.webp",
                  width: 1448,
                  height: 1086,
                  alt: "An AI-created green aurora above an open black-rock coast and low horizon",
                })}
                ${visual({
                  assetPrefix,
                  file: "aurora-ai-south.webp",
                  width: 1536,
                  height: 1024,
                  alt: "An AI-created southern aurora glowing above a rocky ocean coast",
                })}
              </div>
              <div class="service-copy">
                <p class="kicker">Viewing &amp; photography</p>
                <h3>Arrive with a real plan</h3>
                <p>City guides cover direction, darkness, timing, nearby viewing spots, and camera basics for both northern and southern lights.</p>
                <a class="text-link" href="${escapeHtml(assetPrefix)}guides/">Browse viewing guides</a>
              </div>
            </article>
          </div>
        </section>`;
}

export function renderProjectAbout({ assetPrefix = "" } = {}) {
  return `
        <section class="about-band" aria-labelledby="about-project-title">
          <div class="about-inner">
            <figure class="about-visual">
              <img class="about-image" src="${escapeHtml(assetPrefix)}assets/photos/aurora-ai-cabin.webp" width="1448" height="1086" alt="An AI-created remote cabin under a subtle green aurora and a clear northern sky" loading="lazy" decoding="async">
              <figcaption>AI-generated visual</figcaption>
            </figure>
            <div class="about-copy">
              <p class="kicker">Independent project</p>
              <h2 id="about-project-title">Built by Kyson Zhu</h2>
              <p>I built Aurora Forecast Now to turn public space-weather feeds into a practical answer: should you look tonight, and where should you go?</p>
              <p>The forecast uses NOAA and local cloud data. The images are original AI-generated visuals created for this site.</p>
              <a class="text-link" href="${escapeHtml(assetPrefix)}about/">About the project</a>
            </div>
          </div>
        </section>`;
}

function serviceRow({
  assetPrefix,
  file,
  width,
  height,
  alt,
  kicker,
  title,
  copy,
  link = "",
  linkLabel = "",
  actionLabel = "",
  reverse = false,
}) {
  return `
            <article class="service-row${reverse ? " reverse" : ""}">
              ${visual({ assetPrefix, file, width, height, alt })}
              <div class="service-copy">
                <p class="kicker">${escapeHtml(kicker)}</p>
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(copy)}</p>
                ${link ? `<a class="text-link" href="${escapeHtml(assetPrefix)}${escapeHtml(link)}">${escapeHtml(linkLabel)}</a>` : ""}
                ${actionLabel ? `<button class="button secondary" type="button" data-open-alert-prompt>${escapeHtml(actionLabel)}</button>` : ""}
              </div>
            </article>`;
}

function visual({ assetPrefix, file, width, height, alt }) {
  return `<figure class="service-visual">
                <img src="${escapeHtml(assetPrefix)}assets/photos/${escapeHtml(file)}" width="${width}" height="${height}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">
                <figcaption>AI-generated visual</figcaption>
              </figure>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
