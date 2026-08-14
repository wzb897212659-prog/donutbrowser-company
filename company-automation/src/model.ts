import { randomUUID } from "node:crypto";
import {
  FINGERPRINT_POLICY_VERSION,
  type FingerprintVerification,
} from "./fingerprint.js";
import { type CompanyPersona, createPersona, createSeed } from "./persona.js";

export interface EnvironmentRecord {
  id: string;
  name: string;
  startupUrl: string;
  seed: number;
  persona: CompanyPersona;
  createdAt: string;
  updatedAt: string;
}
export type EnvironmentStatus = "closed" | "starting" | "running" | "closing";
export interface PublicEnvironment extends EnvironmentRecord {
  status: EnvironmentStatus;
  currentUrl: string | null;
  fingerprint:
    | FingerprintVerification
    | {
        status: "not-checked";
        policyVersion: typeof FINGERPRINT_POLICY_VERSION;
        nativePersona: true;
        webrtcPolicy: "disable_non_proxied_udp";
      };
}

export function normalizeEnvironmentName(value: unknown): string {
  if (typeof value !== "string") throw new Error("环境名称必须是字符串");
  const name = value.trim();
  if (name.length < 1 || name.length > 80)
    throw new Error("环境名称长度必须为 1 到 80 个字符");
  return name;
}

export function normalizeStartupUrl(value: unknown): string {
  if (value === undefined || value === null || value === "")
    return "about:blank";
  if (typeof value !== "string") throw new Error("启动网址必须是字符串");
  const text = value.trim();
  if (text === "about:blank") return text;
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("启动网址只支持 HTTP 或 HTTPS");
  }
  return url.toString();
}

export function createEnvironment(input: {
  name: unknown;
  startupUrl?: unknown;
  seed?: unknown;
}): EnvironmentRecord {
  const seed = input.seed === undefined ? createSeed() : Number(input.seed);
  if (!Number.isInteger(seed) || seed < 10_000 || seed > 99_999)
    throw new Error("指纹种子必须是五位整数");
  const id = randomUUID();
  const now = new Date().toISOString();
  return {
    id,
    name: normalizeEnvironmentName(input.name),
    startupUrl: normalizeStartupUrl(input.startupUrl),
    seed,
    persona: createPersona(id, seed),
    createdAt: now,
    updatedAt: now,
  };
}
