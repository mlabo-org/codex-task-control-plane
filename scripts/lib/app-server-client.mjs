import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 30_000;

export class AppServerClient extends EventEmitter {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #stderr = "";
  #startPromise = null;

  constructor({
    executable = process.env.CODEX_BIN || "codex",
    args = ["app-server", "--listen", "stdio://"],
    cwd = process.cwd(),
    env = process.env,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    clientInfo = {
      name: "codex_session_control_plane",
      title: "Codex Session Control Plane",
      version: "0.1.0"
    }
  } = {}) {
    super();
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = clientInfo;
  }

  get running() {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  get stderrTail() {
    return this.#stderr.slice(-8_000);
  }

  async start() {
    if (this.running) return;
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#spawnAndInitialize();
    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async #spawnAndInitialize() {
    this.#child = spawn(this.executable, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const lines = readline.createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#onLine(line));
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-32_000);
    });
    this.#child.once("error", (error) => this.#onExit(error));
    this.#child.once("exit", (code, signal) => {
      this.#onExit(new Error(`codex app-server exited code=${code} signal=${signal}`));
    });

    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: false
      }
    });
    this.notify("initialized", {});
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (method !== "initialize") {
      await this.start();
    }
    if (!this.#child?.stdin?.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }

    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    this.#write({ id, method, params });
    return promise;
  }

  notify(method, params = {}) {
    if (!this.#child?.stdin?.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.#write({ method, params });
  }

  async listModels() {
    return this.request("model/list", {});
  }

  async listThreads(params = {}) {
    return this.request("thread/list", params);
  }

  async startThread(params) {
    return this.request("thread/start", params);
  }

  async startTurn(params) {
    return this.request("turn/start", params);
  }

  async readThread(threadId, includeTurns = true) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  async interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async archiveThread(threadId) {
    return this.request("thread/archive", { threadId });
  }

  async setThreadName(threadId, name) {
    return this.request("thread/name/set", { threadId, name });
  }

  async stop() {
    if (!this.#child) return;
    const child = this.#child;
    this.#child = null;
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`App Server stopped before ${pending.method} completed`));
      this.#pending.delete(id);
    }
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error(`Invalid App Server JSON: ${line.slice(0, 200)}`));
      return;
    }

    if (Object.hasOwn(message, "id") && (message.result !== undefined || message.error)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `App Server error for ${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.#write({
        id: message.id,
        error: {
          code: -32601,
          message: `Client-side server request is not supported: ${message.method}`
        }
      });
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      this.emit(message.method, message.params);
    }
  }

  #onExit(error) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      const wrapped = new Error(`${error.message}; stderr=${this.stderrTail}`);
      pending.reject(wrapped);
      this.#pending.delete(id);
    }
    this.emit("closed", error);
  }
}
