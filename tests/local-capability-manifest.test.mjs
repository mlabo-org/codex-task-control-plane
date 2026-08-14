import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "local-capability-manifest.json");
const serverPath = path.join(root, "scripts", "control-plane-mcp.mjs");

test("Local Capability Broker manifest represents every public leaf exactly once", async (context) => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const plugin = JSON.parse(await fs.readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

  assert.equal(manifest.manifestVersion, "local-capability-manifest/v1");
  assert.equal(manifest.publisher, "suzuki-makoto");
  assert.equal(manifest.packageKind, "plugin");
  assert.equal(manifest.packageId, plugin.name);
  assert.equal(manifest.descriptorVersion, packageJson.version);

  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thread-orchestration-surface-"));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_SESSION_CONTROL_PLANE_LEDGER: path.join(runtimeRoot, "ledger.json")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  const requests = createRequestClient(child);
  const listed = await requests.call("tools/list", {});
  const publicTools = listed.tools.map((tool) => tool.name).sort();

  const directLeaves = manifest.capabilities.filter(
    (capability) => capability.runtimeBinding.kind === "mcp_tool"
  );
  assert.equal(directLeaves.length, 13);
  assert.deepEqual(
    directLeaves.map((capability) => capability.runtimeBinding.tool).sort(),
    publicTools
  );
  assert.ok(
    directLeaves.every(
      (capability) => capability.runtimeBinding.mcpServer === "codex_session_control_plane"
    )
  );

  const hostLeaves = manifest.capabilities.filter(
    (capability) => capability.runtimeBinding.kind !== "mcp_tool"
  );
  assert.equal(hostLeaves.length, 1);
  assert.equal(hostLeaves[0].leafId, "control-codex-sessions");
  assert.equal(hostLeaves[0].executionClass, "host_coordinator");
  assert.equal(hostLeaves[0].runtimeBinding.kind, "host_coordinator");
  assert.match(hostLeaves[0].runtimeBinding.instruction, /active Codex host/i);

  const expectedClass = new Map(
    publicTools.map((tool) => [
      tool,
      tool === "control_plane_preflight" ? "server_deterministic" : "server_stateful"
    ])
  );
  for (const capability of directLeaves) {
    assert.equal(capability.executionClass, expectedClass.get(capability.runtimeBinding.tool));
  }

  assert.equal(new Set(manifest.capabilities.map((capability) => capability.leafId)).size, 14);
  const schemaIds = manifest.capabilities.flatMap((capability) => [
    capability.inputSchema.schemaId,
    capability.outputSchema.schemaId
  ]);
  assert.equal(new Set(schemaIds).size, 28);
  assert.doesNotMatch(JSON.stringify(manifest), /invoke_skill/);
});

test("manifest schemas and artifact declarations are package-contained and leaf-complete", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const canonicalRoot = await fs.realpath(root);

  for (const capability of manifest.capabilities) {
    assert.ok(Array.isArray(capability.authorityRequests));
    assert.deepEqual(capability.artifactRoots, []);
    assert.deepEqual(capability.inputPorts, []);
    assert.deepEqual(capability.outputPorts, []);

    for (const source of [capability.inputSchema, capability.outputSchema]) {
      assert.equal(source.schemaVersion, "local-capability-schema/v1");
      assert.equal(path.isAbsolute(source.path), false);
      assert.equal(source.path.split(path.sep).includes(".."), false);
      const canonicalSchema = await fs.realpath(path.resolve(root, source.path));
      assert.ok(canonicalSchema.startsWith(`${canonicalRoot}${path.sep}`));
      const schema = JSON.parse(await fs.readFile(canonicalSchema, "utf8"));
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(schema.$id, source.schemaId);
      assert.ok(
        schema.type === "object" || typeof schema.$ref === "string" || Array.isArray(schema.oneOf)
      );
      if (schema.type === "object") {
        assert.equal(schema.additionalProperties, false);
        assert.ok(Object.keys(schema.properties || {}).length > 0);
      } else {
        assert.ok(Object.keys(schema.$defs || {}).length > 0);
      }
      if (source === capability.outputSchema) {
        assert.ok(
          (Array.isArray(schema.required) && schema.required.length > 0) ||
            typeof schema.$ref === "string" ||
            Array.isArray(schema.oneOf)
        );
      }
    }
  }
});

function createRequestClient(child) {
  let sequence = 0;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
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
