#!/usr/bin/env node

import readline from "node:readline";
import { ControlPlane } from "./lib/control-plane.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { NATIVE_THREAD_TOOLS, PREPARABLE_THREAD_TOOLS } from "./lib/native-thread-tools.mjs";
import { startDashboardServer } from "./lib/dashboard-server.mjs";

const protocolVersion = "2024-11-05";
const controlPlane = new ControlPlane({
  ledger: new Ledger(process.env.CODEX_SESSION_CONTROL_PLANE_LEDGER)
});
let dashboard = null;

const tools = new Map([
  [
    "control_plane_preflight",
    {
      description:
        "Validate a local project directory and report whether the complete native Codex task-tool family is available. Pass the exact currently exposed tool names; this server records intents but never invokes those host tools itself.",
      inputSchema: objectSchema(
        {
          cwd: { type: "string", description: "Local project directory to validate." },
          availableTools: {
            type: "array",
            items: { type: "string", enum: [...NATIVE_THREAD_TOOLS] },
            uniqueItems: true,
            description: "Exact native task tools visible to the active Codex controller."
          }
        },
        ["cwd", "availableTools"]
      ),
      handler: (args) => controlPlane.preflight(args)
    }
  ],
  [
    "control_plane_create_run",
    {
      description:
        "Create a durable thread-orchestration run. Dry-run records a plan only; live mode may prepare real native calls when each mutation also has explicit confirmation.",
      inputSchema: objectSchema(
        {
          objective: { type: "string" },
          controllerThreadId: nullableString(),
          controllerHostId: nullableString(),
          executionMode: { type: "string", enum: ["dry-run", "live"], default: "dry-run" },
          maxRoundTrips: { type: "integer", minimum: 1, maximum: 64, default: 8 }
        },
        ["objective"]
      ),
      handler: (args) => controlPlane.createRun(args)
    }
  ],
  [
    "control_plane_add_task",
    {
      description:
        "Add one complete worker-task contract. Model/thinking overrides require explicit user_request authority; Coding Agents mode requires a declared coding scope.",
      inputSchema: taskInputSchema(),
      handler: (args) => controlPlane.addTask(args)
    }
  ],
  [
    "control_plane_prepare_dispatch",
    {
      description:
        "Prepare one visible Codex task launch. The returned nextCall first uses codex_app__list_projects; no native call is executed by this server.",
      inputSchema: runTaskSchema(),
      handler: (args) => controlPlane.prepareDispatch(args)
    }
  ],
  [
    "control_plane_resolve_project",
    {
      description:
        "Resolve an exact list_projects record into a create_thread call. Git projects default to isolated worktrees and non-Git projects to local execution.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          operationId: { type: "string" },
          project: openObject("Exact project record returned by codex_app__list_projects."),
          confirmLiveAction: { type: "boolean", default: false }
        },
        ["runId", "operationId", "project"]
      ),
      handler: (args) => controlPlane.resolveProject(args)
    }
  ],
  [
    "control_plane_record_thread_launch",
    {
      description:
        "Record a create_thread or fork_thread outcome and bind its threadId/hostId, or retain clientThreadId while worktree provisioning is queued.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          operationId: { type: "string" },
          result: openObject("Normalized native launch result."),
          error: openObject("Normalized native launch error.")
        },
        ["runId", "operationId"]
      ),
      handler: (args) => controlPlane.recordThreadLaunch(args)
    }
  ],
  [
    "control_plane_prepare_operation",
    {
      description:
        "Prepare any supported native task operation after launch: list, wait, read, send, fork, handoff/status, title, pin, archive, or navigate. Returns the exact nextCall for the Codex controller.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          tool: { type: "string", enum: [...PREPARABLE_THREAD_TOOLS] },
          input: openObject("Tool-specific semantic input; validated by the operation builder."),
          confirmLiveAction: { type: "boolean", default: false }
        },
        ["runId", "tool"]
      ),
      handler: (args) => controlPlane.prepareOperation(args)
    }
  ],
  [
    "control_plane_complete_operation",
    {
      description:
        "Record a normalized native tool result. Wait/read observations drive task state; list bindings resolve queued worktrees; handoff status, metadata, and UI operations remain auditable.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          operationId: { type: "string" },
          result: openObject("Normalized result for the prepared operation.")
        },
        ["runId", "operationId", "result"]
      ),
      handler: (args) => controlPlane.completeOperation(args)
    }
  ],
  [
    "control_plane_decide",
    {
      description:
        "Record the controller's acceptance decision for a task in review: accept, continue in the same visible task, or fail.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          taskId: { type: "string" },
          decision: { type: "string", enum: ["accept", "continue", "fail"] },
          note: { type: "string" }
        },
        ["runId", "taskId", "decision"]
      ),
      handler: (args) => controlPlane.decideTask(args)
    }
  ],
  [
    "control_plane_request_cancel",
    {
      description:
        "Record a cancellation request. Because the native task family exposes no direct stop call, a running visible task still requires the user to stop it in Codex before a terminal observation is recorded.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          taskId: { type: "string" },
          reason: { type: "string" }
        },
        ["runId", "taskId", "reason"]
      ),
      handler: (args) => controlPlane.requestCancel(args)
    }
  ],
  [
    "control_plane_simulate_task",
    {
      description:
        "Complete one dry-run task simulation without creating or modifying a Codex task.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          taskId: { type: "string" },
          summary: { type: "string" },
          artifacts: stringArray(),
          verification: stringArray()
        },
        ["runId", "taskId", "summary"]
      ),
      handler: (args) => controlPlane.simulateTask(args)
    }
  ],
  [
    "control_plane_snapshot",
    {
      description:
        "Read the complete durable ledger or one run, including tasks, native thread bindings, operation intents, messages, decisions, and events.",
      inputSchema: objectSchema({ runId: nullableString() }),
      handler: (args) => controlPlane.snapshot(args)
    }
  ],
  [
    "control_plane_dashboard_start",
    {
      description:
        "Start or return the loopback-only bilingual dashboard. It observes the ledger and prepares intents; the active Codex controller remains the native-tool executor.",
      inputSchema: objectSchema({
        port: { type: "integer", minimum: 0, maximum: 65535, default: 0 }
      }),
      handler: async ({ port = 0 }) => {
        if (!dashboard) dashboard = await startDashboardServer({ controlPlane, port });
        return { ok: true, url: dashboard.url };
      }
    }
  ]
]);

function taskInputSchema() {
  return objectSchema(
    {
      runId: { type: "string" },
      title: { type: "string" },
      prompt: { type: "string" },
      role: { type: "string" },
      cwd: { type: "string" },
      environment: { type: "string", enum: ["auto", "local", "worktree"], default: "auto" },
      startingState: openObject("Optional worktree starting state."),
      model: { type: "string" },
      thinking: {
        type: "string",
        enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
      },
      profileAuthority: { type: "string" },
      workerMode: { type: "string", enum: ["direct", "coding-agents"], default: "direct" },
      codingAgentsScope: { type: "string" },
      codingAgentsDeliveryMode: {
        type: "string",
        enum: ["ITERATIVE_DELIVERY", "ONE_SHOT_QUALITY"],
        default: "ITERATIVE_DELIVERY"
      },
      deliveryModeAuthority: { type: "string" },
      maxDelegationDepth: { type: "integer", minimum: 0, maximum: 8, default: 0 },
      delegationAuthority: { type: "string" },
      acceptanceCriteria: stringArray()
    },
    ["runId", "title", "prompt", "role", "cwd"]
  );
}

function runTaskSchema() {
  return objectSchema(
    { runId: { type: "string" }, taskId: { type: "string" } },
    ["runId", "taskId"]
  );
}

function objectSchema(properties, required = []) {
  return { type: "object", additionalProperties: false, properties, required };
}

function openObject(description) {
  return { type: "object", additionalProperties: true, description };
}

function nullableString() {
  return { type: ["string", "null"] };
}

function stringArray() {
  return { type: "array", items: { type: "string" }, default: [] };
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function sendResult(id, result) {
  send({ id, result });
}

function sendError(id, code, message, data) {
  send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function toolResult(name, payload) {
  return {
    content: [{ type: "text", text: `${payload?.ok === false ? "failed" : "ok"} ${name}` }],
    structuredContent: payload,
    isError: payload?.ok === false
  };
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion,
      serverInfo: {
        name: "codex-session-control-plane",
        title: "Codex Thread Orchestration Control Plane",
        version: "0.2.0"
      },
      capabilities: { tools: {} }
    });
    return;
  }
  if (method === "tools/list") {
    sendResult(id, {
      tools: [...tools.entries()].map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const tool = tools.get(name);
    if (!tool) {
      sendError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    try {
      const payload = await tool.handler(params?.arguments || {});
      sendResult(id, toolResult(name, payload));
    } catch (error) {
      sendResult(
        id,
        toolResult(name, {
          ok: false,
          error: {
            code: error.code || "CONTROL_PLANE_ERROR",
            message: error.message,
            details: error.details || null
          }
        })
      );
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    await handleRequest(JSON.parse(line));
  } catch (error) {
    sendError(null, -32700, error.message);
  }
});

async function shutdown() {
  await dashboard?.close().catch(() => null);
  await controlPlane.close().catch(() => null);
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
