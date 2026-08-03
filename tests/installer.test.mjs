import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PLUGIN_NAME,
  PLUGIN_SOURCE_PATH,
  canonicalSourceRoot,
  createInstallPlan,
  findInstalledPlugin,
  planMarketplace,
  writeJsonAtomic
} from "../scripts/lib/plugin-installer.mjs";

const manifest = { name: PLUGIN_NAME, version: "0.2.0+codex.test" };

test("first install creates a complete personal marketplace entry", () => {
  const homeDir = path.join(path.sep, "home", "reader");
  const plan = createInstallPlan({
    repoRoot: canonicalSourceRoot(homeDir),
    homeDir,
    manifest,
    marketplaceDocument: null,
    configuredMarketplaces: { marketplaces: [] },
    nodeVersion: "24.0.0"
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.marketplaceName, "personal");
  assert.equal(plan.marketplaceEntryState, "created");
  assert.equal(plan.installSelector, `${PLUGIN_NAME}@personal`);
  assert.deepEqual(plan.marketplaceDocument.plugins[0], {
    name: PLUGIN_NAME,
    source: { source: "local", path: PLUGIN_SOURCE_PATH },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity"
  });
});

test("existing marketplace entries are preserved and a matching install is idempotent", () => {
  const homeDir = path.join(path.sep, "home", "reader");
  const existing = {
    name: "reader-local",
    interface: { displayName: "Reader Local" },
    plugins: [
      {
        name: "other-plugin",
        source: { source: "local", path: "./plugins/other-plugin" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity"
      }
    ]
  };
  const added = planMarketplace({
    marketplaceDocument: existing,
    configuredMarketplaces: { marketplaces: [{ name: "reader-local", root: homeDir }] },
    homeDir
  });

  assert.equal(added.entryState, "created");
  assert.equal(added.document.plugins[0].name, "other-plugin");
  assert.equal(added.document.plugins[1].name, PLUGIN_NAME);

  const repeated = planMarketplace({
    marketplaceDocument: added.document,
    configuredMarketplaces: { marketplaces: [{ name: "reader-local", root: homeDir }] },
    homeDir
  });
  assert.equal(repeated.entryState, "matched");
  assert.equal(repeated.changed, false);
});

test("a conflicting plugin source blocks installation without replacement", () => {
  const homeDir = path.join(path.sep, "home", "reader");
  const marketplaceDocument = {
    name: "personal",
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "local", path: "./plugins/different-source" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity"
      }
    ]
  };
  const plan = createInstallPlan({
    repoRoot: canonicalSourceRoot(homeDir),
    homeDir,
    manifest,
    marketplaceDocument,
    configuredMarketplaces: { marketplaces: [{ name: "personal", root: homeDir }] },
    nodeVersion: "22.0.0"
  });

  assert.equal(plan.status, "blocked");
  assert.equal(plan.blockers[0].code, "PLUGIN_SOURCE_CONFLICT");
  assert.equal(plan.marketplaceDocument, null);
});

test("noncanonical source and unsupported Node are explicit blockers", () => {
  const homeDir = path.join(path.sep, "home", "reader");
  const plan = createInstallPlan({
    repoRoot: path.join(path.sep, "tmp", PLUGIN_NAME),
    homeDir,
    manifest,
    marketplaceDocument: null,
    configuredMarketplaces: { marketplaces: [] },
    nodeVersion: "20.19.0"
  });

  assert.equal(plan.status, "blocked");
  assert.deepEqual(
    plan.blockers.map((blocker) => blocker.code),
    ["SOURCE_PATH_MISMATCH", "NODE_VERSION_UNSUPPORTED"]
  );
});

test("marketplace persistence is atomic-shaped and installed lookup is exact", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-orchestration-installer-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".agents", "plugins", "marketplace.json");
  const document = { name: "personal", plugins: [] };

  await writeJsonAtomic(target, document);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), document);
  assert.equal(
    findInstalledPlugin({
      installed: [
        { name: "other", version: "1.0.0" },
        { name: PLUGIN_NAME, version: manifest.version, enabled: true }
      ]
    }).version,
    manifest.version
  );
  assert.equal(findInstalledPlugin({ installed: [] }), null);
});
