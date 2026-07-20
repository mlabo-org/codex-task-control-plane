import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SCHEMA_VERSION = "control-plane-ledger/v1";

export function defaultLedgerPath() {
  const root =
    process.env.CODEX_SESSION_CONTROL_PLANE_HOME ||
    path.join(os.homedir(), ".codex", "session-control-plane");
  return path.join(root, "ledger.json");
}

export function emptyLedger() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    runs: {}
  };
}

export class Ledger {
  #queue = Promise.resolve();

  constructor(filePath = defaultLedgerPath()) {
    this.filePath = path.resolve(filePath);
  }

  async read() {
    try {
      const bytes = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(bytes);
      if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.runs !== "object") {
        throw new Error(`Unsupported ledger schema at ${this.filePath}`);
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyLedger();
      }
      throw error;
    }
  }

  async update(mutator) {
    const operation = this.#queue.then(async () => {
      const current = await this.read();
      const draft = structuredClone(current);
      const result = await mutator(draft);
      draft.revision = current.revision + 1;
      draft.updatedAt = new Date().toISOString();
      await this.#writeAtomic(draft);
      return {
        ledger: structuredClone(draft),
        result: result === undefined ? null : structuredClone(result)
      };
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async replace(next) {
    return this.update((draft) => {
      draft.runs = structuredClone(next.runs || {});
      return { replaced: true };
    });
  }

  async #writeAtomic(value) {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, this.filePath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}
