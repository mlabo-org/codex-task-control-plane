#!/usr/bin/env node

import readline from "node:readline";

let threadSequence = 0;
let turnSequence = 0;
const threads = new Map();

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  handle(request);
});

function handle({ id, method, params = {} }) {
  if (method === "initialize") {
    respond(id, {
      userAgent: "fake-codex-app-server",
      platformFamily: "test",
      platformOs: "test",
      platformArch: "test"
    });
    return;
  }
  if (method === "model/list") {
    respond(id, {
      data: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          supportedReasoningEfforts: ["low", "medium", "high"]
        }
      ]
    });
    return;
  }
  if (method === "thread/start") {
    const threadId = `fake-thread-${++threadSequence}`;
    threads.set(threadId, {
      id: threadId,
      name: null,
      archived: false,
      params,
      turns: []
    });
    respond(id, { thread: threadView(threads.get(threadId)) });
    return;
  }
  if (method === "thread/name/set") {
    const thread = requireThread(params.threadId);
    thread.name = params.name;
    respond(id, {});
    return;
  }
  if (method === "turn/start") {
    const thread = requireThread(params.threadId);
    const turnId = `fake-turn-${++turnSequence}`;
    const output = {
      status: "completed",
      summary: `fake worker completed ${turnId}`,
      artifacts: ["tests/fixtures/fake-app-server.mjs"],
      verification: ["fake App Server end-to-end path passed"],
      blockers: [],
      unknowns: []
    };
    const turn = {
      id: turnId,
      status: "completed",
      items: [
        {
          id: `fake-item-${turnSequence}`,
          type: "agentMessage",
          text: JSON.stringify(output)
        }
      ]
    };
    thread.turns.push(turn);
    respond(id, { turn: { id: turnId, status: "inProgress", items: [] } });
    return;
  }
  if (method === "thread/read") {
    respond(id, { thread: threadView(requireThread(params.threadId)) });
    return;
  }
  if (method === "turn/interrupt") {
    requireThread(params.threadId);
    respond(id, {});
    return;
  }
  if (method === "thread/archive") {
    const thread = requireThread(params.threadId);
    thread.archived = true;
    respond(id, {});
    return;
  }
  respondError(id, -32601, `Unsupported fake method: ${method}`);
}

function requireThread(threadId) {
  const thread = threads.get(threadId);
  if (!thread) throw new Error(`Unknown fake thread: ${threadId}`);
  return thread;
}

function threadView(thread) {
  return {
    id: thread.id,
    name: thread.name,
    status: { type: thread.archived ? "notLoaded" : "idle" },
    turns: structuredClone(thread.turns)
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
