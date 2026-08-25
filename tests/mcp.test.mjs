import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NATIVE_THREAD_TOOLS } from "../scripts/lib/native-thread-tools.mjs";

const serverPath = fileURLToPath(new URL("../scripts/control-plane-mcp.mjs", import.meta.url));

test("MCP exposes the complete ledger/intent lifecycle and creates a dry-run", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-control-mcp-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, CODEX_TASK_CONTROL_PLANE_LEDGER: path.join(root, "ledger.json") },
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  const requests = createRequestClient(child);

  const initialized = await requests.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" }
  });
  assert.equal(initialized.serverInfo.name, "codex-task-control-plane");
  assert.equal(initialized.serverInfo.version, "0.2.0");

  const listed = await requests.call("tools/list", {});
  const names = listed.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "control_plane_preflight",
    "control_plane_create_run",
    "control_plane_add_task",
    "control_plane_prepare_dispatch",
    "control_plane_resolve_project",
    "control_plane_record_thread_launch",
    "control_plane_prepare_operation",
    "control_plane_complete_operation",
    "control_plane_decide",
    "control_plane_request_cancel",
    "control_plane_simulate_task",
    "control_plane_snapshot",
    "control_plane_reconcile",
    "control_plane_record_settlement",
    "control_plane_cleanup_settlement",
    "control_plane_dashboard_start"
  ]);

  const preflight = await requests.call("tools/call", {
    name: "control_plane_preflight",
    arguments: { cwd: root, availableTools: NATIVE_THREAD_TOOLS }
  });
  assert.equal(preflight.isError, false);
  assert.equal(preflight.structuredContent.capabilities.complete, true);

  const created = await requests.call("tools/call", {
    name: "control_plane_create_run",
    arguments: { objective: "MCP protocol smoke", executionMode: "dry-run" }
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
