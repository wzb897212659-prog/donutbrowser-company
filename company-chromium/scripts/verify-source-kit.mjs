import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(root, full));
    } else if (entry.isFile()) {
      result.push(relative(root, full).split(sep).join("/"));
    } else {
      throw new Error(`Non-ordinary source-kit entry: ${full}`);
    }
  }
  return result.sort();
}

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(
  readFileSync(join(kitRoot, "SOURCE-LOCK.json"), "utf8"),
);
if (
  lock.schemaVersion !== 1 ||
  lock.upstream?.baseCommit !== "031bfd60f544af71d8dd7246970d1af3e1acf3ad" ||
  lock.upstream?.chromiumVersion !== "151.0.7922.76" ||
  lock.upstream?.repository !==
    "https://chromium.googlesource.com/chromium/src.git"
) {
  throw new Error("SOURCE-LOCK upstream identity is invalid");
}
if (lock.patch?.modifiedFiles !== 38 || lock.patch?.addedFiles !== 14) {
  throw new Error("SOURCE-LOCK changed-file counts are invalid");
}
if (!Array.isArray(lock.changedFiles) || lock.changedFiles.length !== 52) {
  throw new Error("SOURCE-LOCK must contain exactly 52 changed paths");
}

const manifestText = readFileSync(join(kitRoot, "MANIFEST-SHA256SUMS"), "utf8");
const manifestEntries = new Map();
for (const line of manifestText.trimEnd().split("\n")) {
  const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._/-]+)$/.exec(line);
  if (!match || manifestEntries.has(match[2])) {
    throw new Error(`Invalid or duplicate manifest line: ${line}`);
  }
  manifestEntries.set(match[2], match[1]);
}
const actualFiles = listFiles(kitRoot).filter(
  (path) => path !== "MANIFEST-SHA256SUMS",
);
if (!sameSet(actualFiles, manifestEntries.keys())) {
  throw new Error(
    "MANIFEST-SHA256SUMS does not describe the exact source-kit file set",
  );
}
for (const path of actualFiles) {
  const bytes = readFileSync(join(kitRoot, ...path.split("/")));
  if (sha256(bytes) !== manifestEntries.get(path)) {
    throw new Error(`Source-kit manifest hash mismatch: ${path}`);
  }
}

for (const binding of [lock.patch, lock.buildArgs, lock.chromiumLicense]) {
  const bytes = readFileSync(join(kitRoot, ...binding.path.split("/")));
  if (bytes.length !== binding.size || sha256(bytes) !== binding.sha256) {
    throw new Error(`SOURCE-LOCK binding mismatch: ${binding.path}`);
  }
}

const sourceArgument = process.argv.indexOf("--chromium-src");
if (sourceArgument !== -1) {
  const sourceValue = process.argv[sourceArgument + 1];
  if (!sourceValue || process.argv[sourceArgument + 2]) {
    throw new Error("Usage: verify-source-kit.mjs [--chromium-src <path>]");
  }
  const chromiumSource = resolve(sourceValue);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: chromiumSource,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const head = git(["rev-parse", "HEAD"]).toString("utf8").trim();
  if (head !== lock.upstream.baseCommit) {
    throw new Error(`Patched source HEAD mismatch: ${head}`);
  }
  for (const entry of lock.changedFiles) {
    const current = readFileSync(
      join(chromiumSource, ...entry.path.split("/")),
    );
    if (
      current.length !== entry.patchedSize ||
      sha256(current) !== entry.patchedSha256
    ) {
      throw new Error(`Patched source file binding mismatch: ${entry.path}`);
    }
    if (entry.kind === "modified") {
      const base = git(["show", `${lock.upstream.baseCommit}:${entry.path}`]);
      if (sha256(base) !== entry.baseSha256) {
        throw new Error(`Upstream base file binding mismatch: ${entry.path}`);
      }
    } else if (entry.kind !== "added" || entry.baseSha256 !== null) {
      throw new Error(
        `Invalid changed-file kind in SOURCE-LOCK: ${entry.path}`,
      );
    }
  }
}
if (
  lock.acceptedRuntime?.sha256 !==
    "acaf2d06d60d938cb335c4d9cc71814817c0a25926086bdefb6ca613d69f7bf9" ||
  lock.acceptedRuntime?.size !== 3_870_720
) {
  throw new Error(
    "Accepted runtime identity is not the locally validated build",
  );
}

const patchText = readFileSync(
  join(kitRoot, ...lock.patch.path.split("/")),
  "utf8",
);
const patchPaths = [];
for (const match of patchText.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
  if (match[1] !== match[2]) {
    throw new Error(
      `Patch unexpectedly renames a path: ${match[1]} -> ${match[2]}`,
    );
  }
  patchPaths.push(match[1]);
}
const lockedPaths = lock.changedFiles.map((entry) => entry.path);
if (new Set(patchPaths).size !== 52 || !sameSet(patchPaths, lockedPaths)) {
  throw new Error("Patch path coverage does not match SOURCE-LOCK");
}
for (const prefix of lock.excludedUntrackedPrefixes ?? []) {
  if (patchPaths.some((path) => path.startsWith(prefix))) {
    throw new Error(`Excluded toolchain path entered the patch: ${prefix}`);
  }
}

const requiredMarkers = [
  "company-persona-config",
  ".company-browser-native-hardware.json",
  ".company-browser-portable-os-crypt.json",
  "CompanyPortableKeyProviderWin",
  "CompanyPersona::IsLocked",
];
for (const marker of requiredMarkers) {
  if (!patchText.includes(marker)) {
    throw new Error(`Required implementation marker is absent: ${marker}`);
  }
}

const forbiddenPatterns = [
  new RegExp("F:" + "\\\\" + "Chat" + "GPT", "i"),
  new RegExp("C:" + "\\\\" + "Users" + "\\\\" + "汪泽" + "波", "i"),
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /(?:password|token|secret)\s*[=:]\s*["'][^"']{8,}["']/i,
];
for (const path of actualFiles) {
  const text = readFileSync(join(kitRoot, ...path.split("/")), "utf8");
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      throw new Error(
        `Forbidden local or secret material in ${path}: ${pattern}`,
      );
    }
  }
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      sourceKitFiles: actualFiles.length + 1,
      patchFiles: patchPaths.length,
      patchSha256: lock.patch.sha256,
      acceptedRuntimeSha256: lock.acceptedRuntime.sha256,
    },
    null,
    2,
  ),
);
