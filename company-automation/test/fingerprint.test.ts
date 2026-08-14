import assert from "node:assert/strict";
import test from "node:test";
import {
  FINGERPRINT_POLICY_VERSION,
  type FingerprintIdentity,
  parseFingerprintIdentity,
  serializeFingerprintIdentity,
} from "../src/fingerprint.js";
import { createChromiumArguments } from "../src/manager.js";

const identity: FingerprintIdentity = {
  schemaVersion: 1,
  policyVersion: FINGERPRINT_POLICY_VERSION,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0",
  userAgentData: {
    brands: [{ brand: "Chromium", version: "151" }],
    mobile: false,
    platform: "Windows",
  },
  platform: "Win32",
  webdriver: false,
  hardwareConcurrency: 8,
  deviceMemoryGiB: 16,
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  languages: ["zh-CN", "zh"],
  screen: {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 1,
  },
  webgl: {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA)",
    version: "WebGL 2.0",
    shadingLanguageVersion: "WebGL GLSL ES 3.00",
  },
  canvasSha256: "a".repeat(64),
  audio: { sampleRate: 48_000, maxChannelCount: 2 },
  fonts: [{ family: "Segoe UI", available: true, width: 123.4567 }],
};

test("fingerprint baseline is strict canonical JSON", () => {
  const serialized = serializeFingerprintIdentity(identity);
  assert.deepEqual(parseFingerprintIdentity(serialized), identity);
  assert.throws(() => parseFingerprintIdentity(JSON.stringify(identity)));
  assert.throws(() =>
    parseFingerprintIdentity(
      `${JSON.stringify({ ...identity, unexpected: true })}\n`,
    ),
  );
});

test("managed launch enables non-proxied WebRTC UDP protection", () => {
  const args = createChromiumArguments("C:\\profiles\\environment", 45_123);
  assert.ok(
    args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
  );
  assert.equal(
    args.some((arg) => arg.includes("--enable-automation")),
    false,
  );
  assert.equal(
    args.some((arg) => arg.includes("--no-sandbox")),
    false,
  );
});
