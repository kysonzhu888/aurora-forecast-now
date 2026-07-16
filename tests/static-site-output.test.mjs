import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

execFileSync(process.execPath, ["tools/build.mjs"], {
  cwd: root,
  env: { ...process.env, AURORA_USE_EXISTING_FORECAST: "1" },
  stdio: "pipe",
});

const config = JSON.parse(fs.readFileSync(path.join(root, "site.config.json"), "utf8"));
const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
const city = fs.readFileSync(path.join(root, "cities", "fairbanks", "index.html"), "utf8");
const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
const pro = fs.readFileSync(path.join(root, "pro", "index.html"), "utf8");
const proClient = fs.readFileSync(path.join(root, "assets", "pro-access.js"), "utf8");
const proLicenseState = fs.readFileSync(path.join(root, "assets", "pro-license-state.mjs"), "utf8");
const proCss = fs.readFileSync(path.join(root, "assets", "pro.css"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const googleVerification = fs.readFileSync(
  path.join(root, "google1089c0cca1aa4f0a.html"),
  "utf8",
);

const generatedHtmlPaths = fs.readdirSync(root, { recursive: true })
  .filter((relativePath) => relativePath === "index.html" || relativePath.endsWith("/index.html"))
  .filter((relativePath) => !relativePath.startsWith(".deploy/") && !relativePath.startsWith("node_modules/"));

test("keeps the exact Google Search Console verification file", () => {
  assert.equal(
    googleVerification,
    "google-site-verification: google1089c0cca1aa4f0a.html\n",
  );
});

test("every generated page includes exactly one Cloudflare Web Analytics beacon", () => {
  assert.match(config.cloudflareWebAnalyticsToken || "", /^[a-f0-9]{32}$/);
  assert.ok(generatedHtmlPaths.length > 100, "expected the full generated site");

  for (const relativePath of generatedHtmlPaths) {
    const html = fs.readFileSync(path.join(root, relativePath), "utf8");
    const beacons = html.match(/<script[^>]+static\.cloudflareinsights\.com\/beacon\.min\.js[^>]*><\/script>/g) || [];
    assert.equal(beacons.length, 1, relativePath);
    assert.match(beacons[0], /type="module"/);
    assert.match(beacons[0], new RegExp(`data-cf-beacon='\\{"token":"${config.cloudflareWebAnalyticsToken}"\\}'`));
  }
});

test("privacy policy describes the active privacy-first analytics", () => {
  const privacy = fs.readFileSync(path.join(root, "privacy", "index.html"), "utf8");
  assert.match(privacy, /Cloudflare Web Analytics/);
  assert.match(privacy, /does not use cookies or local storage/i);
  assert.doesNotMatch(privacy, /analytics[^.]*may be added/i);
});

test("generated pages expose a stable SEO shell without internal review language", () => {
  assert.doesNotMatch(home, /ad review|reserved for review|ad-ready/i);
  assert.match(home, /data-live-max-kp/);
  assert.match(home, /data-live-forecast-time/);
  assert.match(home, /data-live-best-city/);
  assert.doesNotMatch(home, /Updated from the static build/i);
});

test("generated navigation moves lower-priority links into an accessible mobile menu", () => {
  assert.match(home, /<a class="nav-secondary"[^>]*>Glossary<\/a>/);
  assert.match(home, /<a class="nav-secondary"[^>]*>About<\/a>/);
  assert.match(home, /<a class="nav-secondary"[^>]*>Contact<\/a>/);
  assert.match(home, /<details class="nav-more">/);
  assert.match(home, /<summary>More<\/summary>/);
  assert.match(home, /<div class="nav-more-menu">/);
  assert.match(styles, /\.nav-more\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.nav-secondary\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.nav-more\s*\{[^}]*display:\s*block/s);
});

test("city pages keep live values out of the crawlable fallback", () => {
  assert.match(city, /data-live-city-detail/);
  assert.match(city, /data-live-city-score>—</);
  assert.match(city, /data-live-city-kp>Checking</);
  assert.doesNotMatch(city, /<h3>Last build<\/h3>/);
  assert.doesNotMatch(city, /<span>Generated<\/span>/);
});

test("sitemap lastmod describes source content instead of forecast refreshes", () => {
  assert.match(config.contentLastmod || "", /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(sitemap, /<changefreq>/);
  const lastmods = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]);
  assert.ok(lastmods.length > 0);
  assert.deepEqual(new Set(lastmods), new Set([config.contentLastmod]));
});

test("Aurora Pro preview is fail-closed without leaking the GGB product", () => {
  assert.equal(config.pro.enabled, false);
  assert.equal(config.pro.priceLabel, "$9.99 lifetime founding access");
  assert.equal(config.pro.checkoutUrl, "");
  assert.match(pro, /<meta name="robots" content="noindex, follow">/);
  assert.match(pro, /data-pro-access-page/);
  assert.match(pro, /data-pro-locked/);
  assert.match(pro, /data-pro-unlocked hidden/);
  assert.match(pro, /assets\/pro-access\.js/);
  assert.doesNotMatch(pro, /1189903|Game Guide Base|gameguidebase/i);
  assert.doesNotMatch(pro, /auroraforecastnow\.lemonsqueezy\.com\/checkout\/buy/i);
  assert.doesNotMatch(sitemap, /\/pro\//);
  assert.doesNotMatch(city, /data-pro-locked|paywall-locked/);
  assert.match(proClient, /\/api\/pro\/license/);
  assert.match(proClient, /\/api\/pro\/funnel/);
  assert.match(pro, /<script type="module" src="\.\.\/assets\/pro-access\.js"><\/script>/);
  assert.match(proClient, /from "\.\/pro-license-state\.mjs"/);
  assert.match(proLicenseState, /parseLicenseReturnUrl/);
  assert.match(proCss, /\.pro-page \[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});
