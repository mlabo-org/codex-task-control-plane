#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "creator-contract.json",
  "skills/control-codex-sessions/SKILL.md",
  "skills/control-codex-sessions/agents/openai.yaml",
  "scripts/control-plane-mcp.mjs",
  "scripts/control-plane-cli.mjs",
  "scripts/lib/app-server-client.mjs",
  "scripts/lib/control-plane.mjs",
  "scripts/lib/dashboard-server.mjs",
  "scripts/lib/ledger.mjs",
  "scripts/lib/state-machine.mjs",
  "schemas/run.schema.json",
  "schemas/message.schema.json",
  "assets/dashboard/index.html",
  "assets/dashboard/app.js",
  "assets/dashboard/control-plane.css",
  "assets/dashboard/macos-local-html.css"
];

for (const relative of requiredFiles) {
  const stat = await fs.stat(path.join(root, relative));
  assert.ok(stat.isFile(), `${relative} must be a file`);
}

for (const relative of [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "creator-contract.json",
  "schemas/run.schema.json",
  "schemas/message.schema.json"
]) {
  JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
}

const plugin = JSON.parse(
  await fs.readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8")
);
assert.equal(plugin.name, "codex-session-control-plane");
assert.equal(plugin.skills, "./skills/");
assert.equal(plugin.mcpServers, "./.mcp.json");

const mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
assert.equal(
  mcp.mcpServers?.codex_session_control_plane?.command,
  "node",
  "MCP server command must be configured"
);

const combined = (
  await Promise.all(
    requiredFiles.map((relative) => fs.readFile(path.join(root, relative), "utf8"))
  )
).join("\n");
assert.doesNotMatch(combined, /\bTODO\b|\[TODO:/, "Scaffold placeholders must be removed");
assert.match(combined, /confirmLiveDispatch/);
assert.match(combined, /thread\/start/);
assert.match(combined, /turn\/start/);
assert.match(combined, /Japanese|日本語/);
assert.match(combined, /Light/);
assert.match(combined, /Dark/);
assert.match(combined, /System/);

process.stdout.write("control-plane source validation passed\n");
