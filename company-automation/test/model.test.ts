import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironment,
  normalizeEnvironmentName,
  normalizeStartupUrl,
} from "../src/model.js";

test("startup URL accepts only HTTP, HTTPS, and about:blank", () => {
  assert.equal(normalizeStartupUrl(""), "about:blank");
  assert.equal(
    normalizeStartupUrl("https://example.com/path"),
    "https://example.com/path",
  );
  assert.throws(() => normalizeStartupUrl("file:///c:/windows/win.ini"));
  assert.throws(() => normalizeStartupUrl("javascript:alert(1)"));
});
test("environment records bind persona to the generated environment id", () => {
  const record = createEnvironment({
    name: " 本地环境 ",
    startupUrl: "https://example.com",
    seed: 12_345,
  });
  assert.equal(record.name, "本地环境");
  assert.equal(record.startupUrl, "https://example.com/");
  assert.equal(record.persona.environmentId, record.id);
  assert.equal(record.seed, 12_345);
});
test("environment names are bounded", () => {
  assert.equal(normalizeEnvironmentName(" A "), "A");
  assert.throws(() => normalizeEnvironmentName(""));
  assert.throws(() => normalizeEnvironmentName("x".repeat(81)));
});
