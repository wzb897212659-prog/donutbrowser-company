import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { CompanyAutomationManager } from "./manager.js";
import { verifyRuntimeFromEnvironment } from "./runtime.js";
import { EnvironmentStore } from "./store.js";
import { renderUi } from "./ui.js";

const HOST = "127.0.0.1";
const PORT = readPort(process.env.COMPANY_AUTOMATION_PORT);
const DATA_ROOT = path.resolve(
  process.env.COMPANY_AUTOMATION_DATA_ROOT ??
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "DonutBrowserCompanyAutomation",
    ),
);
const token = randomBytes(32).toString("base64url");
const runtime = await verifyRuntimeFromEnvironment(process.env);
const manager = new CompanyAutomationManager(
  new EnvironmentStore(DATA_ROOT),
  runtime,
);
await manager.initialize();

const server = createServer(async (request, response) => {
  try {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        runtime: { sha256: runtime.sha256, size: runtime.size },
        cloudEnabled: false,
      });
    }
    if (request.method === "GET" && url.pathname === "/")
      return sendHtml(response, 200, renderUi(token));
    authorizeLocalRequest(request, token, PORT);
    if (request.method === "GET" && url.pathname === "/v1/environments") {
      return sendJson(response, 200, { environments: await manager.list() });
    }
    if (request.method === "POST" && url.pathname === "/v1/environments") {
      const body = await readJson(request);
      return sendJson(response, 201, {
        environment: await manager.create({
          name: body.name,
          startupUrl: body.startupUrl,
          seed: body.seed,
        }),
      });
    }
    const match =
      /^\/v1\/environments\/([0-9a-f-]+)\/(open|close|navigate|screenshot|delete)$/i.exec(
        url.pathname,
      );
    if (request.method === "POST" && match) {
      const environmentId = match[1];
      const action = match[2];
      if (!environmentId || !action) throw new HttpError(400, "请求路径无效");
      if (action === "open")
        return sendJson(response, 200, {
          environment: await manager.open(environmentId),
        });
      if (action === "close")
        return sendJson(response, 200, {
          environment: await manager.close(environmentId),
        });
      if (action === "navigate") {
        const body = await readJson(request);
        return sendJson(response, 200, {
          environment: await manager.navigate(environmentId, body.url),
        });
      }
      if (action === "screenshot")
        return sendJson(response, 200, await manager.screenshot(environmentId));
      await manager.delete(environmentId);
      return sendJson(response, 200, { deleted: true });
    }
    throw new HttpError(404, "接口不存在");
  } catch (error) {
    sendJson(response, error instanceof HttpError ? error.status : 400, {
      error: error instanceof Error ? error.message : "本地服务发生未知错误",
    });
  }
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://${HOST}:${PORT}`;
  console.log(`Company Chromium 本地验收服务：${localUrl}`);
  console.log(`数据目录：${DATA_ROOT}`);
  console.log(`Runtime SHA-256：${runtime.sha256}`);
  if (process.env.COMPANY_AUTOMATION_OPEN_UI === "1") {
    const opener = spawn(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", localUrl],
      {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    opener.unref();
  }
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await manager.closeAll();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function authorizeLocalRequest(
  request: IncomingMessage,
  expectedToken: string,
  port: number,
): void {
  if (request.headers.host !== `${HOST}:${port}`)
    throw new HttpError(403, "Host 不受信");
  const origin = request.headers.origin;
  if (origin && origin !== `http://${HOST}:${port}`)
    throw new HttpError(403, "Origin 不受信");
  if (request.headers["x-company-automation-token"] !== expectedToken)
    throw new HttpError(401, "本地令牌无效");
}
async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "请求必须使用 application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new HttpError(413, "请求内容过大");
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON 请求格式无效");
  }
}
function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
}
function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}
function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}
function readPort(value: string | undefined): number {
  if (value === undefined) return 45_110;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error("COMPANY_AUTOMATION_PORT 无效");
  return port;
}
