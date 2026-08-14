import { createHmac, randomInt, randomUUID } from "node:crypto";

export interface CompanyPersona {
  schemaVersion: 3;
  environmentId: string;
  portableKeyId: string;
  hardwareConcurrency: number;
  deviceMemoryGiB: number;
  timezone: "Asia/Shanghai";
  locale: "zh-CN";
  languages: ["zh-CN", "zh"];
}

const WINDOWS_HARDWARE_CATALOG = [
  [4, 4],
  [4, 8],
  [6, 8],
  [8, 8],
  [8, 16],
  [12, 16],
  [16, 16],
  [16, 32],
  [20, 32],
  [24, 32],
] as const;
const HMAC_KEY = "company-browser/native-hardware/windows-catalog/v1";

export function createSeed(): number {
  return randomInt(10_000, 100_000);
}

export function deriveWindowsHardware(
  seed: number,
  personaVersion = 1,
): {
  hardwareConcurrency: number;
  deviceMemoryGiB: number;
} {
  if (!Number.isInteger(seed) || seed < 10_000 || seed > 99_999) {
    throw new Error("seed must be a five-digit integer");
  }
  if (!Number.isInteger(personaVersion) || personaVersion < 1) {
    throw new Error("personaVersion must be a positive integer");
  }
  const digest = createHmac("sha256", HMAC_KEY)
    .update("platform=windows\0")
    .update(`personaVersion=${personaVersion}\0`)
    .update(`seed=${seed}`)
    .digest();
  const selected =
    WINDOWS_HARDWARE_CATALOG[
      digest.readUInt32BE(0) % WINDOWS_HARDWARE_CATALOG.length
    ];
  if (!selected) throw new Error("hardware catalog selection failed");
  return { hardwareConcurrency: selected[0], deviceMemoryGiB: selected[1] };
}

export function createPersona(
  environmentId: string,
  seed: number,
): CompanyPersona {
  const hardware = deriveWindowsHardware(seed);
  return {
    schemaVersion: 3,
    environmentId,
    portableKeyId: randomUUID(),
    ...hardware,
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    languages: ["zh-CN", "zh"],
  };
}

export function serializePersona(persona: CompanyPersona): string {
  return `${JSON.stringify(persona)}\n`;
}
