import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function listFiles(current) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(full));
    } else if (entry.isFile()) {
      result.push(full);
    } else {
      throw new Error(`Non-ordinary source-kit entry: ${full}`);
    }
  }
  return result;
}

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let changed = 0;
for (const path of listFiles(kitRoot)) {
  const input = readFileSync(path);
  if (input.includes(0)) {
    throw new Error(`Source-kit text file contains a NUL byte: ${path}`);
  }
  const output = Buffer.from(
    input.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
    "utf8",
  );
  if (!input.equals(output)) {
    writeFileSync(path, output);
    changed += 1;
  }
}

console.log(`Normalized ${changed} source-kit files to LF.`);
