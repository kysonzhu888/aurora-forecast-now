const northernVisuals = [
  {
    file: "aurora-ai-forest.webp",
    alt: "An AI-created boreal forest clearing with a subtle green aurora above the northern horizon",
  },
  {
    file: "aurora-ai-coast.webp",
    alt: "An AI-created open black-rock coast with aurora visible between broken clouds",
  },
  {
    file: "aurora-ai-city-edge.webp",
    alt: "An AI-created dark lakeshore beyond a small northern town with a faint green aurora",
  },
];

const southernVisual = {
  file: "aurora-ai-south.webp",
  width: 1536,
  height: 1024,
  alt: "An AI-created southern aurora above a dark rocky coast and open southern horizon",
};

export function renderCitySkyContext({ city, direction, assetPrefix = "" }) {
  const visual = selectVisual(city);
  const titleId = `sky-context-${city.slug}`;

  return `
          <section class="city-sky-context" aria-labelledby="${escapeHtml(titleId)}">
            <figure class="city-sky-visual">
              <img class="city-sky-image" src="${escapeHtml(assetPrefix)}assets/photos/${escapeHtml(visual.file)}" width="${visual.width}" height="${visual.height}" alt="${escapeHtml(visual.alt)}" loading="lazy" decoding="async">
              <figcaption>AI-generated visual</figcaption>
            </figure>
            <div class="city-sky-copy">
              <p class="kicker">Local sky context</p>
              <h2 id="${escapeHtml(titleId)}">Read the sky around ${escapeHtml(city.name)}</h2>
              <p>A good space-weather signal still needs the right ground conditions. Use these four checks before committing to a drive.</p>
              <div class="sky-signal-grid">
                <article class="sky-signal">
                  <span aria-hidden="true">01</span>
                  <div><h3>Face the ${escapeHtml(direction.horizon)} horizon</h3><p>Start by looking ${escapeHtml(direction.look)} where a weaker display often sits low in the sky.</p></div>
                </article>
                <article class="sky-signal">
                  <span aria-hidden="true">02</span>
                  <div><h3>Leave direct lights</h3><p>Put streetlights behind you and choose a safe view without nearby glare.</p></div>
                </article>
                <article class="sky-signal">
                  <span aria-hidden="true">03</span>
                  <div><h3>Use the local watch window</h3><p>${escapeHtml(city.watchWindow)} gives you a practical starting window, not a guarantee.</p></div>
                </article>
                <article class="sky-signal">
                  <span aria-hidden="true">04</span>
                  <div><h3>Recheck before leaving</h3><p>Compare the live city score, cloud cover, local roads, and current weather.</p></div>
                </article>
              </div>
            </div>
          </section>`;
}

function selectVisual(city) {
  if (city.lat < 0) return southernVisual;
  const index = [...city.slug].reduce((sum, character) => sum + character.charCodeAt(0), 0)
    % northernVisuals.length;
  return {
    ...northernVisuals[index],
    width: 1448,
    height: 1086,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
