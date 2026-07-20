import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-deploy-package-"));
const deployRoot = path.join(fixtureRoot, ".deploy");

fs.copyFileSync(path.join(root, "deploy.sh"), path.join(fixtureRoot, "deploy.sh"));
for (const relativePath of [
  ".github/workflows/hidden.yml",
  ".wrangler/cache/account.json",
  "assets/alert.css",
  "assets/alert-prompt.js",
  "assets/content-density.css",
  "assets/pro-access.js",
  "assets/pro-license-state.mjs",
  "data/forecast.json",
  "lib/pro-access.mjs",
  "pro/index.html",
  "tests/pro-access.test.mjs",
  "tools/build.mjs",
  "workers/forecast-worker.js",
  "index.html",
  "schema.sql",
  "wrangler.worker.toml",
]) {
  const filePath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${relativePath}\n`);
}
execFileSync("sh", ["deploy.sh", "package"], { cwd: fixtureRoot, stdio: "pipe" });
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

test("Aurora Pages package excludes source, tests and deployment metadata", () => {
  for (const relativePath of [
    ".git",
    ".github",
    ".wrangler",
    "lib",
    "tests",
    "tools",
    "workers",
    "schema.sql",
    "wrangler.worker.toml",
  ]) {
    assert.equal(fs.existsSync(path.join(deployRoot, relativePath)), false, relativePath);
  }
});

test("Aurora Pages package keeps the generated site and Pro browser modules", () => {
  for (const relativePath of [
    "index.html",
    "pro/index.html",
    "assets/alert.css",
    "assets/alert-prompt.js",
    "assets/content-density.css",
    "assets/pro-access.js",
    "assets/pro-license-state.mjs",
    "data/forecast.json",
  ]) {
    assert.equal(fs.existsSync(path.join(deployRoot, relativePath)), true, relativePath);
  }
});
