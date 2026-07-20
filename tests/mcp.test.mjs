import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(
  new URL("../scripts/control-plane-mcp.mjs", import.meta.url)
);

test("MCP surface discovers tools and creates a dry-run ledger", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-mcp-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_SESSION_CONTROL_PLANE_LEDGER: path.join(root, "ledger.json")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  const requests = createRequestClient(child);

  const initialized = await requests.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" }
  });
  assert.equal(initialized.serverInfo.name, "codex-session-control-plane");

  const listed = await requests.call("tools/list", {});
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("control_plane_dispatch"));
  assert.ok(names.includes("control_plane_relay"));
  assert.ok(names.includes("control_plane_dashboard_start"));
  assert.ok(names.includes("control_plane_decide"));

  const created = await requests.call("tools/call", {
    name: "control_plane_create_run",
    arguments: {
      objective: "MCP protocol smoke",
      executionMode: "dry-run"
    }
  });
  assert.equal(created.isError, false);
  assert.equal(created.structuredContent.objective, "MCP protocol smoke");
});

function createRequestClient(child) {
  let sequence = 0;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    call(method, params) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return promise;
    }
  };
}
