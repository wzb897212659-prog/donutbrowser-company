import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_RUNTIME_PATH =
  "F:\\ChatGPT\\Outputs\\2026-08-11\\company-browser-runtime-v2-admitted-qualification-pending\\files\\chrome.exe";
export const DEFAULT_RUNTIME_SHA256 =
  "acaf2d06d60d938cb335c4d9cc71814817c0a25926086bdefb6ca613d69f7bf9";
export const DEFAULT_RUNTIME_SIZE = 3_870_720;
export interface VerifiedRuntime {
  executablePath: string;
  sha256: string;
  size: number;
}

export async function verifyRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<VerifiedRuntime> {
  const executablePath = path.resolve(
    environment.COMPANY_CHROMIUM_EXE ?? DEFAULT_RUNTIME_PATH,
  );
  const expectedSha256 = (
    environment.COMPANY_CHROMIUM_SHA256 ?? DEFAULT_RUNTIME_SHA256
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256))
    throw new Error("COMPANY_CHROMIUM_SHA256 必须是 64 位十六进制 SHA-256");
  const info = await stat(executablePath);
  if (!info.isFile()) throw new Error("Company Chromium 路径不是普通文件");
  if (!environment.COMPANY_CHROMIUM_EXE && info.size !== DEFAULT_RUNTIME_SIZE)
    throw new Error("Company Chromium 文件大小与固定版本不一致");
  const actualSha256 = await sha256File(executablePath);
  if (actualSha256 !== expectedSha256)
    throw new Error("Company Chromium SHA-256 校验失败");
  return { executablePath, sha256: actualSha256, size: info.size };
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}
