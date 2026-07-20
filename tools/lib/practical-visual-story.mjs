export function renderPracticalVisualStory({ assetPrefix = "" } = {}) {
  const visuals = [
    {
      file: "aurora-ai-field.webp",
      width: 1448,
      height: 1086,
      alt: "An AI-created scene of an aurora observer preparing a tripod beside a dark road",
      title: "Prepare before dark",
      copy: "Scout a safe pull-off, dress for a long wait, and keep camera batteries warm.",
    },
    {
      file: "aurora-ai-city-edge.webp",
      width: 1448,
      height: 1086,
      alt: "An AI-created northern town edge with aurora visible beyond the direct street lights",
      title: "Step beyond direct light",
      copy: "Put streetlights behind you and let your eyes adapt for at least 15 minutes.",
    },
    {
      file: "aurora-ai-coast.webp",
      width: 1448,
      height: 1086,
      alt: "An AI-created green aurora above an open black-rock coast and low horizon",
      title: "Keep the horizon open",
      copy: "Trees, hills, and buildings can hide a weak display low in the poleward sky.",
    },
    {
      file: "aurora-ai-south.webp",
      width: 1536,
      height: 1024,
      alt: "An AI-created southern aurora glowing above a rocky ocean coast",
      title: "Face the right direction",
      copy: "Look north in the Northern Hemisphere and south below the equator.",
    },
  ];

  return `
        <section class="section visual-story" aria-labelledby="visual-story-title">
          <div class="story-intro">
            <div>
              <p class="kicker">From forecast to horizon</p>
              <h2 id="visual-story-title">Four field checks before you leave</h2>
            </div>
            <p>The score answers whether conditions are promising. These checks decide whether your actual viewing spot can reveal the sky.</p>
          </div>
          <div class="story-grid">
            ${visuals.map((visual) => renderVisual(visual, assetPrefix)).join("")}
          </div>
        </section>`;
}

function renderVisual(visual, assetPrefix) {
  return `
            <figure class="story-visual">
              <img src="${escapeHtml(assetPrefix)}assets/photos/${escapeHtml(visual.file)}" width="${visual.width}" height="${visual.height}" alt="${escapeHtml(visual.alt)}" loading="lazy" decoding="async">
              <div class="story-copy">
                <h3>${escapeHtml(visual.title)}</h3>
                <p>${escapeHtml(visual.copy)}</p>
              </div>
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
