import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hardenSingleUserFile } from "./windows-security.js";

const FILENAME = ".company-browser-portable-os-crypt.json";
const REQUEST_MAGIC = Buffer.from("CBPOC001", "ascii");
const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$request=$null",
  "$plaintext=$null",
  "$entropy=$null",
  "try {",
  "  $memory=New-Object IO.MemoryStream",
  "  [Console]::OpenStandardInput().CopyTo($memory)",
  "  $request=$memory.ToArray()",
  "  if ($request.Length -lt 16 -or [Text.Encoding]::ASCII.GetString($request,0,8) -ne 'CBPOC001') { throw 'invalid request' }",
  "  if (-not [BitConverter]::IsLittleEndian) { throw 'unsupported host' }",
  "  $plaintextLength=[int][BitConverter]::ToUInt32($request,8)",
  "  $entropyLength=[int][BitConverter]::ToUInt32($request,12)",
  "  if ($plaintextLength -ne 32 -or $entropyLength -lt 1 -or (16+$plaintextLength+$entropyLength) -ne $request.Length) { throw 'invalid request' }",
  "  $plaintext=[byte[]]::new($plaintextLength)",
  "  $entropy=[byte[]]::new($entropyLength)",
  "  [Buffer]::BlockCopy($request,16,$plaintext,0,$plaintextLength)",
  "  [Buffer]::BlockCopy($request,(16+$plaintextLength),$entropy,0,$entropyLength)",
  "  $protected=[Security.Cryptography.ProtectedData]::Protect($plaintext,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "  [Console]::Out.Write([Convert]::ToBase64String($protected))",
  "} finally {",
  "  if ($null -ne $plaintext) { [Array]::Clear($plaintext,0,$plaintext.Length) }",
  "  if ($null -ne $entropy) { [Array]::Clear($entropy,0,$entropy.Length) }",
  "  if ($null -ne $request) { [Array]::Clear($request,0,$request.Length) }",
  "}",
].join(";");

interface PortableConfig {
  schemaVersion: 1;
  environmentId: string;
  keyId: string;
  algorithm: "AES-256-GCM";
  wrapping: "windows-dpapi-current-user";
  encryptedKeyBase64: string;
}

export async function ensurePortableOsCryptConfig(
  profilePath: string,
  environmentId: string,
  keyId: string,
): Promise<void> {
  const target = path.join(profilePath, FILENAME);
  try {
    const existing = await readFile(target, "utf8");
    const parsed = parseConfig(existing);
    if (parsed.environmentId !== environmentId || parsed.keyId !== keyId)
      throw new Error("本地 Cookie 加密身份不匹配");
    await hardenSingleUserFile(target);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const rawKey = randomBytes(32);
  const entropy = Buffer.from(
    `CompanyBrowser.PortableOSCrypt.v1\0${environmentId}\0${keyId}`,
    "utf8",
  );
  let encrypted: Buffer | null = null;
  try {
    encrypted = await protectCurrentUser(rawKey, entropy);
    const config: PortableConfig = {
      schemaVersion: 1,
      environmentId,
      keyId,
      algorithm: "AES-256-GCM",
      wrapping: "windows-dpapi-current-user",
      encryptedKeyBase64: encrypted.toString("base64"),
    };
    await writeFile(target, serializeConfig(config), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await hardenSingleUserFile(target);
    const reread = parseConfig(await readFile(target, "utf8"));
    if (reread.environmentId !== environmentId || reread.keyId !== keyId)
      throw new Error("本地 Cookie 加密配置校验失败");
  } finally {
    rawKey.fill(0);
    entropy.fill(0);
    encrypted?.fill(0);
  }
}

function serializeConfig(config: PortableConfig): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    environmentId: config.environmentId,
    keyId: config.keyId,
    algorithm: "AES-256-GCM",
    wrapping: "windows-dpapi-current-user",
    encryptedKeyBase64: config.encryptedKeyBase64,
  })}\n`;
}

function parseConfig(serialized: string): PortableConfig {
  if (
    serialized.includes("\r") ||
    !serialized.endsWith("\n") ||
    serialized.slice(0, -1).includes("\n")
  ) {
    throw new Error("本地 Cookie 加密配置格式无效");
  }
  const value = JSON.parse(serialized.slice(0, -1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("本地 Cookie 加密配置格式无效");
  const config = value as Partial<PortableConfig>;
  if (
    Object.keys(value).sort().join(",") !==
      "algorithm,encryptedKeyBase64,environmentId,keyId,schemaVersion,wrapping" ||
    config.schemaVersion !== 1 ||
    config.algorithm !== "AES-256-GCM" ||
    config.wrapping !== "windows-dpapi-current-user" ||
    typeof config.environmentId !== "string" ||
    typeof config.keyId !== "string" ||
    typeof config.encryptedKeyBase64 !== "string" ||
    !isUuid(config.environmentId) ||
    !isUuid(config.keyId) ||
    Buffer.from(config.encryptedKeyBase64, "base64").toString("base64") !==
      config.encryptedKeyBase64
  )
    throw new Error("本地 Cookie 加密配置格式无效");
  const validated = config as PortableConfig;
  if (serializeConfig(validated) !== serialized)
    throw new Error("本地 Cookie 加密配置不是规范编码");
  return validated;
}

async function protectCurrentUser(
  plaintext: Buffer,
  entropy: Buffer,
): Promise<Buffer> {
  const request = Buffer.allocUnsafe(16 + plaintext.length + entropy.length);
  REQUEST_MAGIC.copy(request, 0);
  request.writeUInt32LE(plaintext.length, 8);
  request.writeUInt32LE(entropy.length, 12);
  plaintext.copy(request, 16);
  entropy.copy(request, 16 + plaintext.length);
  return await new Promise<Buffer>((resolve, reject) => {
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        PROTECT_SCRIPT,
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      request.fill(0);
      child.kill();
      reject(new Error("Windows DPAPI 加密失败"));
    };
    const timer = setTimeout(fail, 15_000);
    child.once("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 131_072) fail();
      else output.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 131_072) fail();
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      request.fill(0);
      if (settled) return;
      settled = true;
      const encoded = Buffer.concat(output).toString("ascii");
      if (
        code !== 0 ||
        errorBytes !== 0 ||
        encoded.length < 4 ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      ) {
        reject(new Error("Windows DPAPI 加密失败"));
        return;
      }
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length < 40 || decoded.toString("base64") !== encoded) {
        decoded.fill(0);
        reject(new Error("Windows DPAPI 密文无效"));
        return;
      }
      resolve(decoded);
    });
    child.stdin.on("error", fail);
    child.stdin.end(request, () => request.fill(0));
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}
