import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSET_ROOT = path.resolve(__dirname, "../../assets/dashboard");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export async function startDashboardServer({
  controlPlane,
  host = "127.0.0.1",
  port = 0,
  assetRoot = DEFAULT_ASSET_ROOT
}) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Dashboard must bind to localhost or loopback");
  }
  const absoluteRoot = path.resolve(assetRoot);
  const token = randomBytes(24).toString("base64url");
  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest({
        request,
        response,
        controlPlane,
        assetRoot: absoluteRoot,
        token
      });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        ok: false,
        error: {
          code: error.code || "DASHBOARD_ERROR",
          message: error.message
        }
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    server,
    token,
    url: `http://${actualHost}:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function handleRequest({ request, response, controlPlane, assetRoot, token }) {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "codex-task-control-plane",
      role: "ledger-and-intent-dashboard"
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/snapshot") {
    const runId = url.searchParams.get("runId");
    sendJson(response, 200, {
      ok: true,
      snapshot: await controlPlane.snapshot({ runId: runId || null })
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/action") {
    if (request.headers["x-control-plane-token"] !== token) {
      sendJson(response, 403, {
        ok: false,
        error: { code: "INVALID_DASHBOARD_TOKEN", message: "Dashboard action token is invalid" }
      });
      return;
    }
    const body = await readJsonBody(request);
    const result = await dispatchAction(controlPlane, body);
    sendJson(response, 200, { ok: true, result });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, {
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" }
    });
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.resolve(assetRoot, relative);
  if (filePath !== assetRoot && !filePath.startsWith(`${assetRoot}${path.sep}`)) {
    sendJson(response, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: "Asset not found" }
    });
    return;
  }
  let bytes = await fs.readFile(filePath);
  if (relative === "index.html") {
    bytes = Buffer.from(bytes.toString("utf8").replace("__CONTROL_PLANE_TOKEN__", token), "utf8");
  }
  response.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  });
  if (request.method === "HEAD") response.end();
  else response.end(bytes);
}

async function dispatchAction(controlPlane, body) {
  switch (body?.action) {
    case "createRun":
      return controlPlane.createRun(body.input || {});
    case "addTask":
      return controlPlane.addTask(body.input || {});
    case "prepareDispatch":
      return controlPlane.prepareDispatch(body.input || {});
    case "resolveProject":
      return controlPlane.resolveProject(body.input || {});
    case "prepareOperation":
      return controlPlane.prepareOperation(body.input || {});
    case "completeOperation":
      return controlPlane.completeOperation(body.input || {});
    case "decide":
      return controlPlane.decideTask(body.input || {});
    case "reconcile":
      if (typeof controlPlane.reconcile !== "function") {
        const error = new Error("Reconciliation is unavailable in the active control plane");
        error.code = "RECONCILIATION_UNAVAILABLE";
        error.statusCode = 409;
        throw error;
      }
      return controlPlane.reconcile(body.input || {});
    case "requestCancel":
      return controlPlane.requestCancel(body.input || {});
    case "simulateTask":
      return controlPlane.simulateTask(body.input || {});
    default: {
      const error = new Error(`Unsupported dashboard action: ${body?.action}`);
      error.code = "UNKNOWN_ACTION";
      error.statusCode = 400;
      throw error;
    }
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error("Dashboard request body is too large");
      error.code = "BODY_TOO_LARGE";
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Dashboard request body must be valid JSON");
    error.code = "INVALID_JSON";
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, status, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
