import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_COMMIT = "031bfd60f544af71d8dd7246970d1af3e1acf3ad";
const CHROMIUM_VERSION = "151.0.7922.76";
const UPSTREAM = "https://chromium.googlesource.com/chromium/src.git";

const TRACKED_PATHS = [
  "chrome/BUILD.gn",
  "chrome/app/BUILD.gn",
  "chrome/app/chrome_main_delegate.cc",
  "chrome/browser/browser_process_impl.cc",
  "chrome/browser/chrome_content_browser_client.cc",
  "chrome/browser/chrome_content_browser_client_unittest.cc",
  "chrome/browser/devtools/protocol/devtools_protocol_browsertest.cc",
  "chrome/browser/devtools/protocol/emulation_handler.cc",
  "chrome/browser/net/profile_network_context_service.cc",
  "chrome/browser/os_crypt/BUILD.gn",
  "chrome/browser/renderer_preferences_util.cc",
  "chrome/browser/renderer_preferences_util_unittest.cc",
  "components/embedder_support/BUILD.gn",
  "components/embedder_support/user_agent_utils.cc",
  "components/embedder_support/user_agent_utils_unittest.cc",
  "content/browser/devtools/devtools_url_loader_interceptor.cc",
  "content/browser/devtools/protocol/device_orientation_handler.cc",
  "content/browser/devtools/protocol/devtools_protocol_browsertest.cc",
  "content/browser/devtools/protocol/emulation_handler.cc",
  "content/browser/devtools/protocol/fetch_handler.cc",
  "content/browser/devtools/protocol/network_handler.cc",
  "content/browser/web_contents/web_contents_impl.cc",
  "content/browser/web_contents/web_contents_impl_browsertest.cc",
  "content/renderer/BUILD.gn",
  "content/renderer/renderer_main.cc",
  "third_party/blink/common/BUILD.gn",
  "third_party/blink/common/device_memory/approximated_device_memory.cc",
  "third_party/blink/common/device_memory/approximated_device_memory_unittest.cc",
  "third_party/blink/public/common/BUILD.gn",
  "third_party/blink/renderer/core/execution_context/navigator_base.cc",
  "third_party/blink/renderer/core/frame/build.gni",
  "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc",
  "third_party/blink/renderer/core/frame/navigator_language.cc",
  "third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc",
  "third_party/blink/renderer/core/inspector/inspector_emulation_agent_test.cc",
  "third_party/blink/renderer/core/inspector/locale_controller.cc",
  "third_party/blink/renderer/core/timezone/timezone_controller.cc",
  "third_party/blink/renderer/core/timezone/timezone_controller.h",
];

const NEW_PATHS = [
  "chrome/app/company_persona_config.h",
  "chrome/app/company_persona_config_win.cc",
  "chrome/app/company_persona_config_win_unittest.cc",
  "chrome/browser/os_crypt/company_portable_key_provider_win.cc",
  "chrome/browser/os_crypt/company_portable_key_provider_win.h",
  "chrome/browser/os_crypt/company_portable_key_provider_win_unittest.cc",
  "content/renderer/company_persona_init.cc",
  "content/renderer/company_persona_init.h",
  "content/renderer/company_persona_init_unittest.cc",
  "docs/company_persona_display_coherence.md",
  "third_party/blink/common/company_persona/company_persona.cc",
  "third_party/blink/common/company_persona/company_persona_unittest.cc",
  "third_party/blink/public/common/company_persona/company_persona.h",
  "third_party/blink/renderer/core/frame/navigator_concurrent_hardware_test.cc",
];

const EXCLUDED_UNTRACKED_PREFIXES = [
  "third_party/disarm/",
  "third_party/fadec/",
  "third_party/llvm-libclang/",
];

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Expected --chromium-src <path> --runtime-exe <path>");
    }
    values[key.slice(2)] = value;
  }
  if (!values["chromium-src"] || !values["runtime-exe"]) {
    throw new Error("Both --chromium-src and --runtime-exe are required");
  }
  if (values.refresh && values.refresh !== "true") {
    throw new Error("--refresh only accepts true");
  }
  return values;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(source, args, options = {}) {
  return execFileSync("git", args, {
    cwd: source,
    encoding: options.encoding ?? null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitNoIndex(source, path) {
  try {
    git(source, [
      "diff",
      "--no-index",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--",
      "/dev/null",
      path,
    ]);
    throw new Error(`New file unexpectedly produced an empty diff: ${path}`);
  } catch (error) {
    if (error?.status !== 1 || !error.stdout?.length) {
      throw error;
    }
    return Buffer.from(error.stdout);
  }
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
      throw new Error(`Source kit contains a non-ordinary entry: ${full}`);
    }
  }
  return result.sort();
}

function writeOutput(path, bytes, refresh) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: refresh ? "w" : "wx" });
}

const args = parseArgs(process.argv.slice(2));
const chromiumSource = resolve(args["chromium-src"]);
const runtimeExe = resolve(args["runtime-exe"]);
const refresh = args.refresh === "true";
const scriptPath = fileURLToPath(import.meta.url);
const kitRoot = resolve(dirname(scriptPath), "..");
const patchPath = join(
  kitRoot,
  "patches",
  "0001-company-persona-and-portable-os-crypt.patch",
);
const lockPath = join(kitRoot, "SOURCE-LOCK.json");
const licensePath = join(kitRoot, "LICENSE.chromium");
const manifestPath = join(kitRoot, "MANIFEST-SHA256SUMS");

for (const output of [patchPath, lockPath, licensePath, manifestPath]) {
  if (!refresh && existsSync(output)) {
    throw new Error(`Refusing to overwrite source-kit output: ${output}`);
  }
}
if (!statSync(runtimeExe).isFile()) {
  throw new Error(`Runtime executable is not an ordinary file: ${runtimeExe}`);
}

const head = git(chromiumSource, ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== BASE_COMMIT) {
  throw new Error(`Chromium HEAD mismatch: ${head}`);
}

const versionLines = readFileSync(
  join(chromiumSource, "chrome", "VERSION"),
  "utf8",
)
  .trim()
  .split(/\r?\n/)
  .map((line) => line.split("=", 2));
const version = Object.fromEntries(versionLines);
const fullVersion = `${version.MAJOR}.${version.MINOR}.${version.BUILD}.${version.PATCH}`;
if (fullVersion !== CHROMIUM_VERSION) {
  throw new Error(`Chromium version mismatch: ${fullVersion}`);
}

const actualTracked = git(
  chromiumSource,
  ["diff", "--name-only", "HEAD", "--"],
  {
    encoding: "utf8",
  },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();
if (
  JSON.stringify(actualTracked) !== JSON.stringify([...TRACKED_PATHS].sort())
) {
  throw new Error("Tracked Chromium delta does not match the frozen path set");
}

const actualUntracked = git(
  chromiumSource,
  ["ls-files", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const relevantUntracked = actualUntracked
  .filter(
    (path) =>
      !EXCLUDED_UNTRACKED_PREFIXES.some((prefix) => path.startsWith(prefix)),
  )
  .sort();
if (
  JSON.stringify(relevantUntracked) !== JSON.stringify([...NEW_PATHS].sort())
) {
  throw new Error(
    "Untracked Chromium delta does not match the frozen path set",
  );
}

execFileSync("git", ["diff", "--check", "HEAD", "--"], {
  cwd: chromiumSource,
  stdio: "inherit",
});

const trackedPatch = git(chromiumSource, [
  "diff",
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "HEAD",
  "--",
  ...TRACKED_PATHS,
]);
const patchParts = [Buffer.from(trackedPatch)];
for (const path of NEW_PATHS) {
  patchParts.push(gitNoIndex(chromiumSource, path));
}
const patchBytes = Buffer.concat(patchParts);
if (!patchBytes.length) {
  throw new Error("Generated patch is empty");
}
writeOutput(patchPath, patchBytes, refresh);

writeOutput(
  licensePath,
  readFileSync(join(chromiumSource, "LICENSE")),
  refresh,
);

const changedFiles = [];
for (const path of TRACKED_PATHS) {
  const current = readFileSync(join(chromiumSource, ...path.split("/")));
  const base = git(chromiumSource, ["show", `${BASE_COMMIT}:${path}`]);
  changedFiles.push({
    path,
    kind: "modified",
    baseSha256: sha256(base),
    patchedSha256: sha256(current),
    patchedSize: current.length,
  });
}
for (const path of NEW_PATHS) {
  const current = readFileSync(join(chromiumSource, ...path.split("/")));
  changedFiles.push({
    path,
    kind: "added",
    baseSha256: null,
    patchedSha256: sha256(current),
    patchedSize: current.length,
  });
}
changedFiles.sort((left, right) => left.path.localeCompare(right.path));

const argsBytes = readFileSync(join(kitRoot, "build", "args.gn"));
const licenseBytes = readFileSync(licensePath);
const runtimeBytes = readFileSync(runtimeExe);
const sourceLock = {
  schemaVersion: 1,
  upstream: {
    repository: UPSTREAM,
    baseCommit: BASE_COMMIT,
    chromiumVersion: CHROMIUM_VERSION,
  },
  target: {
    operatingSystem: "windows",
    cpu: "x64",
    output: "out/Company/chrome.exe",
  },
  patch: {
    path: "patches/0001-company-persona-and-portable-os-crypt.patch",
    sha256: sha256(patchBytes),
    size: patchBytes.length,
    modifiedFiles: TRACKED_PATHS.length,
    addedFiles: NEW_PATHS.length,
  },
  buildArgs: {
    path: "build/args.gn",
    sha256: sha256(argsBytes),
    size: argsBytes.length,
  },
  chromiumLicense: {
    path: "LICENSE.chromium",
    sha256: sha256(licenseBytes),
    size: licenseBytes.length,
  },
  acceptedRuntime: {
    executable: "chrome.exe",
    sha256: sha256(runtimeBytes),
    size: runtimeBytes.length,
  },
  excludedUntrackedPrefixes: EXCLUDED_UNTRACKED_PREFIXES,
  changedFiles,
};
writeOutput(lockPath, `${JSON.stringify(sourceLock, null, 2)}\n`, refresh);

const manifestEntries = listFiles(kitRoot)
  .filter((path) => path !== "MANIFEST-SHA256SUMS")
  .map((path) => {
    const bytes = readFileSync(join(kitRoot, ...path.split("/")));
    return `${sha256(bytes)}  ${path}`;
  });
writeOutput(manifestPath, `${manifestEntries.join("\n")}\n`, refresh);

console.log(
  JSON.stringify(
    {
      patchSha256: sourceLock.patch.sha256,
      changedFiles: changedFiles.length,
      runtimeSha256: sourceLock.acceptedRuntime.sha256,
      manifestMembers: manifestEntries.length,
    },
    null,
    2,
  ),
);
