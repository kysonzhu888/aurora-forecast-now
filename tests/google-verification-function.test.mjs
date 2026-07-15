import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verificationFilename = "google1089c0cca1aa4f0a.html";
const verificationFunctionPath = path.join(
  root,
  "functions",
  `${verificationFilename}.js`,
);

test("the exact Google verification .html route returns the verification file with status 200", async () => {
  const verificationFunction = await import(pathToFileURL(verificationFunctionPath));
  const response = await verificationFunction.onRequestGet();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/plain\b/i);
  assert.equal(
    await response.text(),
    fs.readFileSync(path.join(root, verificationFilename), "utf8"),
  );
});
