import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  captureStableFingerprintIdentity,
  FINGERPRINT_POLICY_VERSION,
  type FingerprintVerification,
  verifyFingerprintIdentity,
} from "./fingerprint.js";
import {
  createEnvironment,
  type EnvironmentRecord,
  type EnvironmentStatus,
  normalizeStartupUrl,
  type PublicEnvironment,
} from "./model.js";
import { ensurePortableOsCryptConfig } from "./os-crypt.js";
import { serializePersona } from "./persona.js";
import type { VerifiedRuntime } from "./runtime.js";
import { assertUuid, EnvironmentStore } from "./store.js";
import { hardenSingleUserFile } from "./windows-security.js";

interface RunningSession {
  environmentId: string;
  status: Exclude<EnvironmentStatus, "closed">;
  process: ChildProcess;
  browser: Browser | null;
  page: Page | null;
  currentUrl: string | null;
  closePromise: Promise<void> | null;
  fingerprint: FingerprintVerification | null;
}

export class CompanyAutomationManager {
  private readonly sessions = new Map<string, RunningSession>();

  constructor(
    private readonly store: EnvironmentStore,
    private readonly runtime: VerifiedRuntime,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }
  async list(): Promise<PublicEnvironment[]> {
    return (await this.store.list()).map((record) => this.publicRecord(record));
  }
  async create(input: {
    name: unknown;
    startupUrl?: unknown;
    seed?: unknown;
  }): Promise<PublicEnvironment> {
    const record = createEnvironment(input);
    await this.store.put(record);
    return this.publicRecord(record);
  }
  async delete(environmentId: string): Promise<void> {
    assertUuid(environmentId);
    if (this.sessions.has(environmentId))
      throw new Error("请先关闭正在运行的环境");
    await this.store.delete(environmentId);
  }

  async open(environmentId: string): Promise<PublicEnvironment> {
    const record = await this.requiredRecord(environmentId);
    const existing = this.sessions.get(environmentId);
    if (existing) {
      if (existing.status === "running") return this.publicRecord(record);
      throw new Error("环境正在启动或关闭，请稍候");
    }
    const profilePath = this.store.profilePath(environmentId);
    await mkdir(profilePath, { recursive: true });
    await ensurePersonaFile(profilePath, record);
    await ensurePortableOsCryptConfig(
      profilePath,
      record.persona.environmentId,
      record.persona.portableKeyId,
    );
    const port = await allocateLoopbackPort();
    const child = spawn(
      this.runtime.executablePath,
      createChromiumArguments(profilePath, port),
      {
        cwd: path.dirname(this.runtime.executablePath),
        windowsHide: false,
        stdio: "ignore",
      },
    );
    const session: RunningSession = {
      environmentId,
      status: "starting",
      process: child,
      browser: null,
      page: null,
      currentUrl: null,
      closePromise: null,
      fingerprint: null,
    };
    this.sessions.set(environmentId, session);
    child.once("exit", () => this.releaseSession(environmentId));
    child.once("error", () => this.releaseSession(environmentId));
    try {
      await waitForDevTools(port, child, 20_000);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      session.browser = browser;
      browser.once("disconnected", () => this.releaseSession(environmentId));
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chromium 没有可用的浏览器上下文");
      const page = context.pages()[0] ?? (await context.newPage());
      session.page = page;
      if (record.startupUrl !== "about:blank") {
        await page.goto(record.startupUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
      session.fingerprint = await verifyFingerprintIdentity(
        profilePath,
        record.persona,
        await captureStableFingerprintIdentity(page),
      );
      session.status = "running";
      session.currentUrl = page.url();
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) session.currentUrl = frame.url();
      });
      return this.publicRecord(record);
    } catch (error) {
      await terminateProcess(child);
      this.releaseSession(environmentId);
      throw error;
    }
  }

  async navigate(
    environmentId: string,
    rawUrl: unknown,
  ): Promise<PublicEnvironment> {
    const record = await this.requiredRecord(environmentId);
    const session = this.requiredRunningSession(environmentId);
    const url = normalizeStartupUrl(rawUrl);
    await session.page?.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    session.currentUrl = session.page?.url() ?? url;
    return this.publicRecord(record);
  }
  async screenshot(environmentId: string): Promise<{ path: string }> {
    const session = this.requiredRunningSession(environmentId);
    const target = path.join(
      this.store.screenshotsRoot,
      `${environmentId}-${Date.now()}.png`,
    );
    await session.page?.screenshot({ path: target, fullPage: true });
    return { path: target };
  }
  async close(environmentId: string): Promise<PublicEnvironment> {
    const record = await this.requiredRecord(environmentId);
    const session = this.sessions.get(environmentId);
    if (!session) return this.publicRecord(record);
    if (!session.closePromise) {
      session.status = "closing";
      session.closePromise = this.closeSession(session);
    }
    await session.closePromise;
    return this.publicRecord(record);
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.closeSession(session)),
    );
  }

  private async closeSession(session: RunningSession): Promise<void> {
    try {
      if (session.browser?.isConnected()) {
        const context = session.browser.contexts()[0];
        const page = session.page ?? context?.pages()[0];
        if (context && page) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Browser.close");
        }
      }
    } catch {
      await terminateProcess(session.process);
    }
    await waitForExit(session.process, 2_000).catch(async () =>
      terminateProcess(session.process),
    );
    this.releaseSession(session.environmentId);
  }
  private releaseSession(environmentId: string): void {
    this.sessions.delete(environmentId);
  }
  private async requiredRecord(
    environmentId: string,
  ): Promise<EnvironmentRecord> {
    assertUuid(environmentId);
    const record = (await this.store.list()).find(
      (candidate) => candidate.id === environmentId,
    );
    if (!record) throw new Error("环境不存在");
    return record;
  }
  private requiredRunningSession(environmentId: string): RunningSession {
    assertUuid(environmentId);
    const session = this.sessions.get(environmentId);
    if (session?.status !== "running" || !session.page)
      throw new Error("环境未运行");
    return session;
  }
  private publicRecord(record: EnvironmentRecord): PublicEnvironment {
    const session = this.sessions.get(record.id);
    return {
      ...record,
      status: session?.status ?? "closed",
      currentUrl: session?.currentUrl ?? null,
      fingerprint: session?.fingerprint ?? {
        status: "not-checked",
        policyVersion: FINGERPRINT_POLICY_VERSION,
        nativePersona: true,
        webrtcPolicy: "disable_non_proxied_udp",
      },
    };
  }
}

export function createChromiumArguments(
  profilePath: string,
  port: number,
): string[] {
  return [
    `--user-data-dir=${profilePath}`,
    "--profile-directory=Default",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=http://127.0.0.1",
    `--company-persona-config=${path.join(profilePath, ".company-browser-native-hardware.json")}`,
    "--accept-lang=zh-CN,zh",
    "--lang=zh-CN",
    "--window-position=32,32",
    "--window-size=1280,900",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

async function ensurePersonaFile(
  profilePath: string,
  record: EnvironmentRecord,
): Promise<void> {
  const target = path.join(
    profilePath,
    ".company-browser-native-hardware.json",
  );
  const expected = serializePersona(record.persona);
  try {
    if ((await readFile(target, "utf8")) !== expected)
      throw new Error("本地环境指纹文件与环境记录不一致");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    await writeFile(target, expected, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  await hardenSingleUserFile(target);
}
async function allocateLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地调试端口"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
async function waitForDevTools(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Company Chromium 提前退出，代码 ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待 Company Chromium 启动超时");
}
async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("浏览器关闭超时")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function terminateProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.once("exit", () => resolve());
    killer.once("error", () => resolve());
  });
}
