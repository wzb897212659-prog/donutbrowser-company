import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyRuntimeFromEnvironment } from "../src/runtime.js";

test("runtime verification rejects an unpinned executable", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "company-automation-runtime-"),
  );
  const executablePath = path.join(root, "chrome.exe");
  await writeFile(executablePath, "not chromium");
  await assert.rejects(
    verifyRuntimeFromEnvironment({
      COMPANY_CHROMIUM_EXE: executablePath,
      COMPANY_CHROMIUM_SHA256: "0".repeat(64),
    }),
    /SHA-256/,
  );
});
