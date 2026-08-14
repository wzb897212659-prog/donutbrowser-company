import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { CompanyAutomationManager } from "../src/manager.js";
import { verifyRuntimeFromEnvironment } from "../src/runtime.js";
import { EnvironmentStore } from "../src/store.js";

const root = path.resolve(
  process.env.COMPANY_AUTOMATION_SMOKE_ROOT ??
    "F:\\ChatGPT\\Outputs\\2026-08-14\\donutbrowser-company-local-acceptance-v2",
);
await mkdir(root, { recursive: true });
const acceptance = { phase: 1, cookieSeen: false, localStorageSeen: false };
const localSite = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/set") {
    if (acceptance.phase === 1)
      response.setHeader(
        "set-cookie",
        "company_acceptance=present; Path=/; SameSite=Lax",
      );
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><script>
      if (${acceptance.phase} === 1) localStorage.setItem('company_acceptance','present');
      location.replace('/verify');
    </script>`);
    return;
  }
  if (url.pathname === "/verify") {
    acceptance.cookieSeen =
      request.headers.cookie?.includes("company_acceptance=present") ?? false;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Company local acceptance</title><script>fetch('/storage?value='+encodeURIComponent(localStorage.getItem('company_acceptance')||''))</script>验收页面",
    );
    return;
  }
  if (url.pathname === "/storage") {
    acceptance.localStorageSeen = url.searchParams.get("value") === "present";
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise<void>((resolve, reject) => {
  localSite.once("error", reject);
  localSite.listen(0, "127.0.0.1", () => resolve());
});
const address = localSite.address();
if (!address || typeof address === "string")
  throw new Error("local acceptance server did not bind");

const runtime = await verifyRuntimeFromEnvironment(process.env);
const localDataRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "DonutBrowserCompanyAutomationSmoke",
);
const manager = new CompanyAutomationManager(
  new EnvironmentStore(localDataRoot),
  runtime,
);
await manager.initialize();
const created = await manager.create({
  name: "本地自动化验收",
  startupUrl: `http://127.0.0.1:${address.port}/set`,
  seed: 12_345,
});

try {
  const firstOpen = await manager.open(created.id);
  if (firstOpen.status !== "running")
    throw new Error(`unexpected first open status: ${firstOpen.status}`);
  if (
    firstOpen.fingerprint.status !== "consistent" ||
    !firstOpen.fingerprint.baselineCreated
  ) {
    throw new Error(
      "first open did not create a verified fingerprint baseline",
    );
  }
  await waitForPersistenceObservation(acceptance);
  const firstClose = await manager.close(created.id);
  if (firstClose.status !== "closed")
    throw new Error(`unexpected first close status: ${firstClose.status}`);

  acceptance.phase = 2;
  acceptance.cookieSeen = false;
  acceptance.localStorageSeen = false;
  const secondOpen = await manager.open(created.id);
  if (secondOpen.status !== "running")
    throw new Error(`unexpected second open status: ${secondOpen.status}`);
  if (
    secondOpen.fingerprint.status !== "consistent" ||
    secondOpen.fingerprint.baselineCreated
  ) {
    throw new Error(
      "second open did not reuse the verified fingerprint baseline",
    );
  }
  await waitForPersistenceObservation(acceptance);
  const screenshotPath = (await manager.screenshot(created.id)).path;
  const secondClose = await manager.close(created.id);
  if (secondClose.status !== "closed")
    throw new Error(`unexpected second close status: ${secondClose.status}`);

  const report = {
    schemaVersion: 1,
    result: "passed",
    environmentId: created.id,
    runtimeSha256: runtime.sha256,
    runtimeSize: runtime.size,
    screenshotPath,
    firstCloseStatus: firstClose.status,
    finalStatus: secondClose.status,
    cookiePersisted: acceptance.cookieSeen,
    localStoragePersisted: acceptance.localStorageSeen,
    profileReopened: true,
    fingerprintPolicyVersion: secondOpen.fingerprint.policyVersion,
    fingerprintConsistentAcrossReopen: true,
    nativePersonaApplied: secondOpen.fingerprint.nativePersona,
    webrtcPolicy: secondOpen.fingerprint.webrtcPolicy,
    cloudEnabled: false,
    testedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(root, "LOCAL-ACCEPTANCE.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  console.log(JSON.stringify(report));
} finally {
  await manager.closeAll();
  await new Promise<void>((resolve) => localSite.close(() => resolve()));
}

async function waitForPersistenceObservation(state: {
  cookieSeen: boolean;
  localStorageSeen: boolean;
}): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (state.cookieSeen && state.localStorageSeen) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `profile persistence not observed: cookie=${state.cookieSeen}, localStorage=${state.localStorageSeen}`,
  );
}
