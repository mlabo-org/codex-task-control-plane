#!/usr/bin/env node

import readline from "node:readline";
import { ControlPlane } from "./lib/control-plane.mjs";
import { Ledger } from "./lib/ledger.mjs";
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
        "Verify the Codex Session Control Plane runtime, project cwd, live-dispatch guard, and optionally the local Codex app-server model surface before creating any session.",
      inputSchema: objectSchema({
        cwd: { type: "string", description: "Absolute project working directory to verify." },
        connect: {
          type: "boolean",
          description: "When true, connect to codex app-server and list its advertised models."
        }
      }),
      handler: (args) => controlPlane.preflight(args)
    }
  ],
  [
    "control_plane_create_run",
    {
      description:
        "Create a persistent upper-control run. Use dry-run for planning. Use live only after an explicit user request to create and operate independent Codex sessions.",
      inputSchema: objectSchema(
        {
          objective: { type: "string", description: "Concrete whole-run objective." },
          controllerThreadId: {
            type: ["string", "null"],
            description: "Known controller Codex thread id for reciprocal addressing."
          },
          controllerHostId: {
            type: ["string", "null"],
            description: "Optional host id paired with the controller thread id."
          },
          executionMode: {
            type: "string",
            enum: ["dry-run", "live"],
            description: "Whether the run may create real Codex sessions."
          },
          maxRoundTrips: {
            type: "integer",
            minimum: 1,
            maximum: 64,
            description: "Maximum controller/worker turn starts per task."
          }
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
        "Add one bounded task with a role, project cwd, model, reasoning effort, and sandbox profile to an existing control run.",
      inputSchema: taskInputSchema(),
      handler: (args) => controlPlane.addTask(args)
    }
  ],
  [
    "control_plane_preview_dispatch",
    {
      description:
        "Preview the exact thread/start and turn/start intent for one task without creating a Codex session or changing task state.",
      inputSchema: runTaskSchema(),
      handler: (args) => controlPlane.previewDispatch(args)
    }
  ],
  [
    "control_plane_dispatch",
    {
      description:
        "Create and start a real independent Codex worker session through app-server. Requires a live run and confirmLiveDispatch=true from an explicit user request.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          taskId: { type: "string" },
          confirmLiveDispatch: {
            const: true,
            description: "Explicit one-call confirmation for real thread creation."
          }
        },
        ["runId", "taskId", "confirmLiveDispatch"]
      ),
      handler: (args) => controlPlane.dispatchTask(args)
    }
  ],
  [
    "control_plane_poll",
    {
      description:
        "Read one assigned Codex session through app-server, synchronize runtime status, and move a completed worker result into controller review.",
      inputSchema: runTaskSchema(),
      handler: (args) => controlPlane.pollTask(args)
    }
  ],
  [
    "control_plane_send",
    {
      description:
        "Send a correlated follow-up turn to a worker session with an explicit or task-default model and reasoning effort. Requires live confirmation.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          taskId: { type: "string" },
          text: { type: "string" },
          type: {
            type: "string",
            enum: ["QUESTION", "PROPOSAL", "REVIEW", "DECISION", "CANCEL"]
          },
          model: { type: "string" },
          effort: { type: "string" },
          confirmLiveDispatch: { const: true }
        },
        ["runId", "taskId", "text", "confirmLiveDispatch"]
      ),
      handler: (args) => controlPlane.sendMessage(args)
    }
  ],
  [
    "control_plane_relay",
    {
      description:
        "Relay a correlated message from one controlled independent Codex session to another through the controller. Both sessions must exist, the recipient must be idle, and live confirmation is required.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          fromTaskId: {
            type: "string",
            description: "Task whose assigned session is the message source."
          },
          toTaskId: {
            type: "string",
            description: "Task whose assigned session receives a new turn."
          },
          text: { type: "string" },
          type: {
            type: "string",
            enum: ["QUESTION", "PROPOSAL", "STATUS", "REVIEW", "DECISION", "CANCEL"]
          },
          confirmLiveDispatch: { const: true }
        },
        ["runId", "fromTaskId", "toTaskId", "text", "confirmLiveDispatch"]
      ),
      handler: (args) => controlPlane.relayMessage(args)
    }
  ],
  [
    "control_plane_decide",
    {
      description:
        "Accept, reject for another turn, or fail a worker result in controller review. Only the controller decision can complete a task.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          taskId: { type: "string" },
          decision: { type: "string", enum: ["accept", "reject", "fail"] },
          note: { type: "string" }
        },
        ["runId", "taskId", "decision"]
      ),
      handler: (args) => controlPlane.decideTask(args)
    }
  ],
  [
    "control_plane_stop",
    {
      description:
        "Interrupt and cancel one active controlled task. A live task requires confirmLiveDispatch=true.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          taskId: { type: "string" },
          confirmLiveDispatch: { type: "boolean" }
        },
        ["runId", "taskId"]
      ),
      handler: (args) => controlPlane.stopTask(args)
    }
  ],
  [
    "control_plane_archive",
    {
      description:
        "Archive one controlled Codex session after work is complete or stopped. A live thread requires confirmLiveDispatch=true.",
      inputSchema: objectSchema(
        {
          runId: { type: "string" },
          threadId: { type: "string" },
          confirmLiveDispatch: { type: "boolean" }
        },
        ["runId", "threadId"]
      ),
      handler: (args) => controlPlane.archiveSession(args)
    }
  ],
  [
    "control_plane_snapshot",
    {
      description:
        "Read the persistent control-plane ledger or one run, including sessions, tasks, correlated messages, artifacts, verification, and events.",
      inputSchema: objectSchema({
        runId: { type: ["string", "null"] }
      }),
      handler: (args) => controlPlane.snapshot(args)
    }
  ],
  [
    "control_plane_dashboard_start",
    {
      description:
        "Start or return the loopback-only Codex Session Control Plane dashboard for live status, review, stop, retry, reassign, approval, and archive operations.",
      inputSchema: objectSchema({
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description: "Loopback port. Use 0 to select an available port."
        }
      }),
      handler: async ({ port = 0 }) => {
        if (!dashboard) {
          dashboard = await startDashboardServer({ controlPlane, port });
        }
        return { ok: true, url: dashboard.url };
      }
    }
  ]
]);

function objectSchema(properties, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

function runTaskSchema() {
  return objectSchema(
    {
      runId: { type: "string" },
      taskId: { type: "string" }
    },
    ["runId", "taskId"]
  );
}

function taskInputSchema() {
  return objectSchema(
    {
      runId: { type: "string" },
      title: { type: "string" },
      prompt: { type: "string" },
      role: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      effort: {
        type: "string",
        enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
      },
      sandbox: {
        type: "string",
        enum: ["read-only", "workspace-write", "danger-full-access"]
      }
    },
    ["runId", "title", "prompt", "role", "cwd", "model"]
  );
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
    content: [
      {
        type: "text",
        text: `${payload?.ok === false ? "failed" : "ok"} ${name}`
      }
    ],
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
        title: "Codex Session Control Plane",
        version: "0.1.0"
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
