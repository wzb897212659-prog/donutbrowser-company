import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(kitRoot, "MANIFEST-SHA256SUMS");
const temporaryPath = `${manifestPath}.new`;
const lines = listFiles(kitRoot)
  .filter(
    (path) =>
      path !== "MANIFEST-SHA256SUMS" && path !== "MANIFEST-SHA256SUMS.new",
  )
  .map((path) => {
    const bytes = readFileSync(join(kitRoot, ...path.split("/")));
    return `${sha256(bytes)}  ${path}`;
  });

writeFileSync(temporaryPath, `${lines.join("\n")}\n`, { flag: "wx" });
renameSync(temporaryPath, manifestPath);
console.log(`Wrote ${lines.length} source-kit manifest entries.`);
