import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type { CompanyPersona } from "./persona.js";
import { hardenSingleUserFile } from "./windows-security.js";

export const FINGERPRINT_POLICY_VERSION = "company-windows-native-v1" as const;
export const FINGERPRINT_BASELINE_BASENAME =
  ".company-browser-fingerprint-baseline-v1.json" as const;

export interface FingerprintIdentity {
  schemaVersion: 1;
  policyVersion: typeof FINGERPRINT_POLICY_VERSION;
  userAgent: string;
  userAgentData: {
    brands: Array<{ brand: string; version: string }>;
    mobile: boolean;
    platform: string;
  } | null;
  platform: string;
  webdriver: boolean;
  hardwareConcurrency: number;
  deviceMemoryGiB: number | null;
  timezone: string;
  locale: string;
  languages: string[];
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };
  webgl: {
    vendor: string;
    renderer: string;
    version: string;
    shadingLanguageVersion: string;
  } | null;
  canvasSha256: string;
  audio: {
    sampleRate: number | null;
    maxChannelCount: number | null;
  };
  fonts: Array<{
    family: string;
    available: boolean;
    width: number;
  }>;
}

export interface FingerprintVerification {
  status: "consistent";
  policyVersion: typeof FINGERPRINT_POLICY_VERSION;
  baselineCreated: boolean;
  nativePersona: true;
  webrtcPolicy: "disable_non_proxied_udp";
}

interface BrowserObservation {
  userAgent: string;
  userAgentData: FingerprintIdentity["userAgentData"];
  platform: string;
  webdriver: boolean;
  hardwareConcurrency: number;
  deviceMemoryGiB: number | null;
  timezone: string;
  locale: string;
  languages: string[];
  screen: FingerprintIdentity["screen"];
  webgl: FingerprintIdentity["webgl"];
  canvasDataUrl: string;
  audio: FingerprintIdentity["audio"];
  fonts: FingerprintIdentity["fonts"];
}

const FONT_FAMILIES = [
  "Arial",
  "Calibri",
  "Cambria",
  "Consolas",
  "Microsoft YaHei",
  "Segoe UI",
  "SimSun",
] as const;

export async function captureFingerprintIdentity(
  page: Page,
): Promise<FingerprintIdentity> {
  const observation = await page.evaluate(
    async (fontFamilies): Promise<BrowserObservation> => {
      const navigatorWithHints = navigator as Navigator & {
        deviceMemory?: number;
        userAgentData?: {
          brands: Array<{ brand: string; version: string }>;
          mobile: boolean;
          platform: string;
        };
      };
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 80;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is unavailable");
      context.textBaseline = "alphabetic";
      context.fillStyle = "#f4f7fb";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#16233a";
      context.font = "18px 'Segoe UI', Arial, sans-serif";
      context.fillText("CompanyBrowser 指纹基线 Aa123", 11, 32);
      context.strokeStyle = "rgba(49,94,251,0.63)";
      context.beginPath();
      context.arc(238.25, 37.75, 21.5, 0, Math.PI * 1.73);
      context.stroke();

      const glCanvas = document.createElement("canvas");
      const gl = glCanvas.getContext("webgl2") ?? glCanvas.getContext("webgl");
      let webgl: BrowserObservation["webgl"] = null;
      if (gl) {
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as {
          UNMASKED_VENDOR_WEBGL: number;
          UNMASKED_RENDERER_WEBGL: number;
        } | null;
        webgl = {
          vendor: String(
            gl.getParameter(debugInfo?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
          ),
          renderer: String(
            gl.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
          ),
          version: String(gl.getParameter(gl.VERSION)),
          shadingLanguageVersion: String(
            gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          ),
        };
      }

      const audioConstructor =
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).AudioContext ??
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;
      let audio: BrowserObservation["audio"] = {
        sampleRate: null,
        maxChannelCount: null,
      };
      if (audioConstructor) {
        const audioContext = new audioConstructor();
        audio = {
          sampleRate: audioContext.sampleRate,
          maxChannelCount: audioContext.destination.maxChannelCount,
        };
        await audioContext.close();
      }

      const measureContext = document.createElement("canvas").getContext("2d");
      if (!measureContext) throw new Error("Canvas measurement is unavailable");
      const fonts = fontFamilies.map((family) => {
        measureContext.font = `72px '${family}', monospace`;
        return {
          family,
          available: document.fonts.check(`16px '${family}'`),
          width: Number(
            measureContext
              .measureText("CompanyBrowser指纹0123456789")
              .width.toFixed(4),
          ),
        };
      });

      return {
        userAgent: navigator.userAgent,
        userAgentData: navigatorWithHints.userAgentData
          ? {
              brands: navigatorWithHints.userAgentData.brands.map((entry) => ({
                brand: entry.brand,
                version: entry.version,
              })),
              mobile: navigatorWithHints.userAgentData.mobile,
              platform: navigatorWithHints.userAgentData.platform,
            }
          : null,
        platform: navigator.platform,
        webdriver: navigator.webdriver,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGiB: navigatorWithHints.deviceMemory ?? null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        languages: [...navigator.languages],
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
          pixelDepth: screen.pixelDepth,
          devicePixelRatio: window.devicePixelRatio,
        },
        webgl,
        canvasDataUrl: canvas.toDataURL("image/png"),
        audio,
        fonts,
      };
    },
    [...FONT_FAMILIES],
  );

  return {
    schemaVersion: 1,
    policyVersion: FINGERPRINT_POLICY_VERSION,
    userAgent: observation.userAgent,
    userAgentData: observation.userAgentData,
    platform: observation.platform,
    webdriver: observation.webdriver,
    hardwareConcurrency: observation.hardwareConcurrency,
    deviceMemoryGiB: observation.deviceMemoryGiB,
    timezone: observation.timezone,
    locale: observation.locale,
    languages: observation.languages,
    screen: observation.screen,
    webgl: observation.webgl,
    canvasSha256: createHash("sha256")
      .update(observation.canvasDataUrl, "utf8")
      .digest("hex"),
    audio: observation.audio,
    fonts: observation.fonts,
  };
}

export async function captureStableFingerprintIdentity(
  page: Page,
  attempts = 10,
  intervalMs = 150,
): Promise<FingerprintIdentity> {
  let previous: FingerprintIdentity | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await page.waitForTimeout(intervalMs);
    const current = await captureFingerprintIdentity(page);
    if (previous && collectMismatches(previous, current).length === 0) {
      return current;
    }
    previous = current;
  }
  throw new Error("浏览器原生指纹在启动阶段未能稳定");
}

export async function verifyFingerprintIdentity(
  profilePath: string,
  persona: CompanyPersona,
  actual: FingerprintIdentity,
): Promise<FingerprintVerification> {
  const personaMismatches = expectedPersonaMismatches(persona, actual);
  if (personaMismatches.length > 0) {
    throw new Error(`原生指纹配置未生效：${personaMismatches.join("、")}`);
  }
  if (actual.webdriver) {
    throw new Error("浏览器报告了自动化 webdriver 标记");
  }
  if (
    !actual.userAgent.includes("Windows NT 10.0") ||
    !actual.userAgent.includes("Chrome/151.")
  ) {
    throw new Error("User-Agent 与固定 Windows Chromium 151 runtime 不一致");
  }
  if (
    actual.userAgentData &&
    (actual.userAgentData.mobile || actual.userAgentData.platform !== "Windows")
  ) {
    throw new Error("User-Agent Client Hints 与 Windows 桌面身份不一致");
  }

  const baselinePath = path.join(profilePath, FINGERPRINT_BASELINE_BASENAME);
  let baselineCreated = false;
  try {
    const text = await readFile(baselinePath, "utf8");
    const parsed = parseFingerprintIdentity(text);
    const mismatches = collectMismatches(parsed, actual);
    if (mismatches.length > 0) {
      throw new Error(`本机原生指纹与环境基线不一致：${mismatches.join("、")}`);
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await writeFile(baselinePath, serializeFingerprintIdentity(actual), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    baselineCreated = true;
  }
  await hardenSingleUserFile(baselinePath);
  return {
    status: "consistent",
    policyVersion: FINGERPRINT_POLICY_VERSION,
    baselineCreated,
    nativePersona: true,
    webrtcPolicy: "disable_non_proxied_udp",
  };
}

export function serializeFingerprintIdentity(
  value: FingerprintIdentity,
): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseFingerprintIdentity(text: string): FingerprintIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("本地指纹基线格式无效");
  }
  if (
    !isFingerprintIdentity(parsed) ||
    text !== serializeFingerprintIdentity(parsed)
  ) {
    throw new Error("本地指纹基线格式无效");
  }
  return parsed;
}

function expectedPersonaMismatches(
  persona: CompanyPersona,
  actual: FingerprintIdentity,
): string[] {
  const mismatches: string[] = [];
  if (actual.hardwareConcurrency !== persona.hardwareConcurrency) {
    mismatches.push("hardwareConcurrency");
  }
  if (actual.deviceMemoryGiB !== persona.deviceMemoryGiB) {
    mismatches.push("deviceMemory");
  }
  if (actual.timezone !== persona.timezone) mismatches.push("timezone");
  if (actual.locale !== persona.locale) mismatches.push("locale");
  if (JSON.stringify(actual.languages) !== JSON.stringify(persona.languages)) {
    mismatches.push("languages");
  }
  return mismatches;
}

function collectMismatches(
  expected: FingerprintIdentity,
  actual: FingerprintIdentity,
): string[] {
  const mismatches: string[] = [];
  compareValue(expected, actual, "fingerprint", mismatches);
  return mismatches.slice(0, 12);
}

function compareValue(
  expected: unknown,
  actual: unknown,
  pathName: string,
  mismatches: string[],
): void {
  if (mismatches.length >= 12) return;
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      mismatches.push(`${pathName}.length`);
      return;
    }
    expected.forEach((entry, index) =>
      compareValue(entry, actual[index], `${pathName}[${index}]`, mismatches),
    );
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      compareValue(
        expected[key],
        actual[key],
        `${pathName}.${key}`,
        mismatches,
      );
    }
    return;
  }
  mismatches.push(pathName);
}

function isFingerprintIdentity(value: unknown): value is FingerprintIdentity {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    value.policyVersion !== FINGERPRINT_POLICY_VERSION ||
    typeof value.userAgent !== "string" ||
    !(value.userAgentData === null || isUserAgentData(value.userAgentData)) ||
    typeof value.platform !== "string" ||
    typeof value.webdriver !== "boolean" ||
    !isFiniteNumber(value.hardwareConcurrency) ||
    !(
      value.deviceMemoryGiB === null || isFiniteNumber(value.deviceMemoryGiB)
    ) ||
    typeof value.timezone !== "string" ||
    typeof value.locale !== "string" ||
    !isStringArray(value.languages) ||
    !isScreen(value.screen) ||
    !(value.webgl === null || isWebGl(value.webgl)) ||
    typeof value.canvasSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.canvasSha256) ||
    !isAudio(value.audio) ||
    !Array.isArray(value.fonts)
  ) {
    return false;
  }
  const exactKeys = [
    "schemaVersion",
    "policyVersion",
    "userAgent",
    "userAgentData",
    "platform",
    "webdriver",
    "hardwareConcurrency",
    "deviceMemoryGiB",
    "timezone",
    "locale",
    "languages",
    "screen",
    "webgl",
    "canvasSha256",
    "audio",
    "fonts",
  ];
  return hasExactKeys(value, exactKeys) && value.fonts.every(isFontObservation);
}

function isUserAgentData(
  value: unknown,
): value is NonNullable<FingerprintIdentity["userAgentData"]> {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["brands", "mobile", "platform"]) &&
    Array.isArray(value.brands) &&
    value.brands.every(
      (entry) =>
        isPlainObject(entry) &&
        hasExactKeys(entry, ["brand", "version"]) &&
        typeof entry.brand === "string" &&
        typeof entry.version === "string",
    ) &&
    typeof value.mobile === "boolean" &&
    typeof value.platform === "string"
  );
}

function isScreen(value: unknown): value is FingerprintIdentity["screen"] {
  const keys = [
    "width",
    "height",
    "availWidth",
    "availHeight",
    "colorDepth",
    "pixelDepth",
    "devicePixelRatio",
  ];
  return (
    isPlainObject(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => isFiniteNumber(value[key]))
  );
}

function isWebGl(
  value: unknown,
): value is NonNullable<FingerprintIdentity["webgl"]> {
  const keys = ["vendor", "renderer", "version", "shadingLanguageVersion"];
  return (
    isPlainObject(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => typeof value[key] === "string")
  );
}

function isAudio(value: unknown): value is FingerprintIdentity["audio"] {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["sampleRate", "maxChannelCount"]) &&
    (value.sampleRate === null || isFiniteNumber(value.sampleRate)) &&
    (value.maxChannelCount === null || isFiniteNumber(value.maxChannelCount))
  );
}

function isFontObservation(
  value: unknown,
): value is FingerprintIdentity["fonts"][number] {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["family", "available", "width"]) &&
    typeof value.family === "string" &&
    typeof value.available === "boolean" &&
    isFiniteNumber(value.width)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}
