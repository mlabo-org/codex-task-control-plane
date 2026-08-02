import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const assetRoot = fileURLToPath(new URL("../assets/dashboard/", import.meta.url));

test("dashboard persists Japanese/English/System and Light/Dark/System choices", async () => {
  const html = await fs.readFile(new URL("index.html", `file://${assetRoot}/`), "utf8");
  const app = await fs.readFile(new URL("app.js", `file://${assetRoot}/`), "utf8");
  const baseCss = await fs.readFile(new URL("macos-local-html.css", `file://${assetRoot}/`), "utf8");

  for (const value of ["system", "ja", "en"]) assert.match(html, new RegExp(`value="${value}"`));
  for (const value of ["system", "light", "dark"]) assert.match(html, new RegExp(`value="${value}"`));
  assert.match(app, /control-plane-language/);
  assert.match(app, /control-plane-theme/);
  assert.match(app, /document\.documentElement\.lang/);
  assert.match(app, /label\.dataset\.i18n = connected/);
  assert.match(baseCss, /prefers-color-scheme:\s*dark/);
});

test("dashboard exposes task, thread, operation, and runtime-boundary views", async () => {
  const html = await fs.readFile(new URL("index.html", `file://${assetRoot}/`), "utf8");
  for (const id of [
    "task-rows",
    "thread-rows",
    "operation-rows",
    "event-list",
    "inspector-content"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-i18n="runtimeBoundary"/);
});
