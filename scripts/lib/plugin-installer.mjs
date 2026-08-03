import fs from "node:fs/promises";
import path from "node:path";

export const PLUGIN_NAME = "codex-thread-orchestration";
export const PLUGIN_SOURCE_PATH = `./plugins/${PLUGIN_NAME}`;
export const DEFAULT_MARKETPLACE_NAME = "personal";
export const FALLBACK_MARKETPLACE_NAME = `${PLUGIN_NAME}-local`;

export function canonicalSourceRoot(homeDir) {
  return path.join(path.resolve(homeDir), "plugins", PLUGIN_NAME);
}

export function personalMarketplacePath(homeDir) {
  return path.join(path.resolve(homeDir), ".agents", "plugins", "marketplace.json");
}

export function createInstallPlan({
  repoRoot,
  homeDir,
  manifest,
  marketplaceDocument = null,
  configuredMarketplaces = [],
  nodeVersion = process.versions.node
}) {
  const sourceRoot = canonicalSourceRoot(homeDir);
  const marketplacePath = personalMarketplacePath(homeDir);
  const blockers = [];

  if (path.resolve(repoRoot) !== sourceRoot) {
    blockers.push({
      code: "SOURCE_PATH_MISMATCH",
      message: `Clone or move the authoritative checkout to ${sourceRoot} before installation.`,
      expected: sourceRoot,
      actual: path.resolve(repoRoot)
    });
  }

  const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    blockers.push({
      code: "NODE_VERSION_UNSUPPORTED",
      message: "Node.js 22 or later is required.",
      actual: String(nodeVersion)
    });
  }

  if (!manifest || manifest.name !== PLUGIN_NAME) {
    blockers.push({
      code: "MANIFEST_NAME_MISMATCH",
      message: `Expected manifest name ${PLUGIN_NAME}.`,
      actual: manifest?.name ?? null
    });
  }
  if (!manifest || typeof manifest.version !== "string" || manifest.version.length === 0) {
    blockers.push({
      code: "MANIFEST_VERSION_MISSING",
      message: "The plugin manifest must contain a non-empty version."
    });
  }

  let marketplace = null;
  try {
    marketplace = planMarketplace({
      marketplaceDocument,
      configuredMarketplaces,
      homeDir
    });
  } catch (error) {
    blockers.push({
      code: error.code || "MARKETPLACE_INVALID",
      message: error.message
    });
  }

  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    plugin: {
      name: manifest?.name ?? null,
      version: manifest?.version ?? null
    },
    sourceRoot,
    marketplacePath,
    marketplaceName: marketplace?.name ?? null,
    marketplaceWrite: marketplace?.changed ?? false,
    marketplaceEntryState: marketplace?.entryState ?? null,
    installSelector: marketplace ? `${PLUGIN_NAME}@${marketplace.name}` : null,
    nextCommand: marketplace ? `codex plugin add ${PLUGIN_NAME}@${marketplace.name}` : null,
    blockers,
    marketplaceDocument: marketplace?.document ?? null
  };
}

export function planMarketplace({ marketplaceDocument, configuredMarketplaces, homeDir }) {
  const expectedRoot = path.resolve(homeDir);
  const configured = normalizeConfiguredMarketplaces(configuredMarketplaces);
  let document;

  if (marketplaceDocument === null) {
    const name = chooseNewMarketplaceName(configured, expectedRoot);
    document = {
      name,
      interface: { displayName: name === DEFAULT_MARKETPLACE_NAME ? "Personal" : "Codex Thread Orchestration Local" },
      plugins: []
    };
  } else {
    validateMarketplaceDocument(marketplaceDocument);
    document = structuredClone(marketplaceDocument);
    const collision = configured.find(
      (entry) => entry.name === document.name && path.resolve(entry.root) !== expectedRoot
    );
    if (collision) {
      throw installError(
        "MARKETPLACE_NAME_COLLISION",
        `Marketplace name ${document.name} is already configured from ${collision.root}.`
      );
    }
  }

  const matches = document.plugins
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry?.name === PLUGIN_NAME);
  if (matches.length > 1) {
    throw installError(
      "DUPLICATE_PLUGIN_ENTRY",
      `Marketplace ${document.name} contains more than one ${PLUGIN_NAME} entry.`
    );
  }

  const expectedEntry = {
    name: PLUGIN_NAME,
    source: { source: "local", path: PLUGIN_SOURCE_PATH },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity"
  };
  let entryState = "created";

  if (matches.length === 0) {
    document.plugins.push(expectedEntry);
  } else {
    const current = matches[0].entry;
    if (current?.source?.source !== "local" || current?.source?.path !== PLUGIN_SOURCE_PATH) {
      throw installError(
        "PLUGIN_SOURCE_CONFLICT",
        `${PLUGIN_NAME} already points to a different marketplace source.`
      );
    }
    entryState = "matched";
  }

  const before = marketplaceDocument === null ? null : JSON.stringify(marketplaceDocument);
  return {
    name: document.name,
    document,
    entryState,
    changed: before !== JSON.stringify(document)
  };
}

export async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, document) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function findInstalledPlugin(listResult, pluginName = PLUGIN_NAME) {
  if (!listResult || !Array.isArray(listResult.installed)) return null;
  return listResult.installed.find((entry) => entry?.name === pluginName) ?? null;
}

function chooseNewMarketplaceName(configured, expectedRoot) {
  const personal = configured.find((entry) => entry.name === DEFAULT_MARKETPLACE_NAME);
  if (!personal || path.resolve(personal.root) === expectedRoot) return DEFAULT_MARKETPLACE_NAME;

  const fallback = configured.find((entry) => entry.name === FALLBACK_MARKETPLACE_NAME);
  if (!fallback || path.resolve(fallback.root) === expectedRoot) return FALLBACK_MARKETPLACE_NAME;
  throw installError(
    "MARKETPLACE_NAME_COLLISION",
    `Marketplace names ${DEFAULT_MARKETPLACE_NAME} and ${FALLBACK_MARKETPLACE_NAME} are already configured elsewhere.`
  );
}

function normalizeConfiguredMarketplaces(value) {
  const entries = Array.isArray(value) ? value : value?.marketplaces;
  if (!Array.isArray(entries)) {
    throw installError(
      "MARKETPLACE_LIST_INVALID",
      "codex plugin marketplace list --json did not return a marketplaces array."
    );
  }
  return entries.filter(
    (entry) => typeof entry?.name === "string" && typeof entry?.root === "string"
  );
}

function validateMarketplaceDocument(document) {
  if (!document || Array.isArray(document) || typeof document !== "object") {
    throw installError("MARKETPLACE_INVALID", "Personal marketplace must be a JSON object.");
  }
  if (typeof document.name !== "string" || document.name.trim().length === 0) {
    throw installError("MARKETPLACE_INVALID", "Personal marketplace must have a non-empty name.");
  }
  if (!Array.isArray(document.plugins)) {
    throw installError("MARKETPLACE_INVALID", "Personal marketplace plugins must be an array.");
  }
}

function installError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
