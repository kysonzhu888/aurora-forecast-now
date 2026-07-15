import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployRoot = path.join(root, ".deploy");

execFileSync("sh", ["deploy.sh", "package"], { cwd: root, stdio: "pipe" });

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
    "assets/pro-access.js",
    "assets/pro-license-state.mjs",
    "data/forecast.json",
  ]) {
    assert.equal(fs.existsSync(path.join(deployRoot, relativePath)), true, relativePath);
  }
});
