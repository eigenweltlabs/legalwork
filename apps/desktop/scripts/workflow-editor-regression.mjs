// Real Electron, production rich-text editor and workflow store, using a synthetic profile.
// Check opening/selection/view changes separately from actual content edits.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.env.LEGALWORK_EDITOR_TEST_OUTPUT;
if (!process.versions.electron) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-editor-"));
  const appRoot = fileURLToPath(new URL("../../app/", import.meta.url));
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const { build } = appRequire("esbuild");
  const result = await build({ entryPoints: [path.join(appRoot, "tests/fixtures/workflow-editor-dirty.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.join(appRoot, "tsconfig.json"), define: { "import.meta.env": "{}", "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.hot": "undefined", "process.env.NODE_ENV": '"production"' }, loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".css": "empty" }, logLevel: "silent" });
  const assets = path.join(appRoot, "dist/assets");
  const cssFiles = (await readdir(assets)).filter(name => /^(app|index)-.*\.css$/.test(name));
  assert.ok(cssFiles.length, "Run pnpm --filter @legalwork/app build first");
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript; charset=utf-8"); response.end(result.outputFiles[0].text); return; }
      if (request.url.startsWith("/assets/")) {
        const name = path.basename(request.url); response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "application/octet-stream"); response.end(await readFile(path.join(assets, name))); return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">${cssFiles.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join("")}</head><body class="bg-background"><script src="/fixture.js"></script></body></html>`);
    } catch { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    if (output) await mkdir(output, { recursive: true });
    const binary = process.env.LEGALWORK_ELECTRON_BINARY ?? (await import("electron")).default;
    const child = spawn(binary, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, LEGALWORK_EDITOR_PROFILE: root, LEGALWORK_EDITOR_FIXTURE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const [code, signal] = await once(child, "exit"); clearTimeout(timeout);
    assert.equal(code, 0, `Electron regression failed (${signal ?? code}): ${log}`);
    console.log(log.trim());
  } finally { server.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
} else {
  const { app, BrowserWindow } = await import("electron");
  app.setName("LegalWork Workflow Editor Verification"); app.setPath("userData", process.env.LEGALWORK_EDITOR_PROFILE);
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, focusable: false, width: 1000, height: 800, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
    await window.loadURL(process.env.LEGALWORK_EDITOR_FIXTURE_URL);
    const evaluate = expression => window.webContents.executeJavaScript(expression, true);
    const waitFor = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(20); }
      throw new Error(`Timed out: ${expression}`);
    };
    const snapshot = () => evaluate("window.workflowEditorFixture.snapshot()");
    await waitFor("Boolean(window.workflowEditorFixture)");
    await evaluate("window.workflowEditorFixture.load()");
    await waitFor('Boolean(document.querySelector("[contenteditable=true]"))');
    await delay(150);
    let state = await snapshot();
    if (output) { await mkdir(output, { recursive: true }); await writeFile(path.join(output, "initial-state.json"), JSON.stringify(state, null, 2)); }
    assert.equal(state.dirty, false, "Opening a workflow must not mark it unsaved");
    assert.equal(state.changes, 0, "Loading must preserve the original Markdown without publishing edits");
    assert.equal(state.body, state.savedBody);
    await evaluate(`(() => {
      const content = document.querySelector('[contenteditable=true]');
      content.focus();
      const text = content.querySelector('strong').firstChild;
      const range = document.createRange(); range.setStart(text, 1); range.collapse(true);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`);
    await delay(100);
    state = await snapshot();
    if (output) await writeFile(path.join(output, "focus-state.json"), JSON.stringify(state, null, 2));
    assert.equal(state.dirty, false, "Focusing and selecting formatted workflow text must not mark it unsaved");
    const results = ["opening formatted workflow preserves exact Markdown and stays saved", "focusing bold text stays saved"];
    const ready = async options => {
      await evaluate(`window.workflowEditorFixture.load(${JSON.stringify(options)})`);
      await waitFor('Boolean(document.querySelector(".lw-markdown-page"))');
      await delay(80);
    };
    const assertClean = async label => {
      const current = await snapshot();
      assert.equal(current.dirty, false, label);
      assert.equal(current.changes, 0, label);
      assert.equal(current.body, current.savedBody, label);
      assert.equal(current.unsaved, 0, label);
    };
    await evaluate('window.workflowEditorFixture.mode("source")');
    await waitFor('Boolean(document.querySelector(".cm-content"))');
    await delay(80); await assertClean("Switching to Source must preserve the exact workflow");
    await evaluate('window.workflowEditorFixture.mode("diff")');
    await delay(80); await assertClean("Switching to Diff must not publish an edit");
    await evaluate('window.workflowEditorFixture.mode("rich-text")');
    await waitFor('Boolean(document.querySelector(".lw-markdown-page"))');
    await delay(80); await assertClean("Returning to rich text must not publish an edit");
    results.push("Source, Diff and rich-text switching stay saved");

    await evaluate(`(() => {
      const content = document.querySelector('.lw-markdown-page'); content.focus();
      const range = document.createRange(); range.selectNodeContents(content.querySelector('h1')); range.collapse(false);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`);
    await window.webContents.insertText(" USEREDIT");
    await waitFor("window.workflowEditorFixture.snapshot().dirty");
    state = await snapshot(); assert.ok(state.body.includes("USEREDIT")); assert.equal(state.unsaved, 1);
    results.push("typing marks the workflow dirty and activates shutdown protection");

    await ready({ strict: true }); await assertClean("StrictMode reopening must stay saved");
    results.push("StrictMode mount and reopen stay saved");
    await evaluate("window.workflowEditorFixture.format()");
    await waitFor("window.workflowEditorFixture.snapshot().dirty");
    state = await snapshot(); assert.ok(state.body.includes("**Rev**")); assert.equal(state.unsaved, 1);
    results.push("formatting existing text is a real edit and activates shutdown protection");

    await ready({ readOnly: true }); await assertClean("Read-only opening must stay saved");
    results.push("read-only workflows stay saved");
    await ready({});
    const replacement = "# Refreshed workflow\n\n- **Loaded**: Preserve source formatting.\n";
    await evaluate(`window.workflowEditorFixture.replace(${JSON.stringify(replacement)})`);
    await delay(100); await assertClean("External refresh must not publish a user edit");
    results.push("external refresh preserves exact Markdown and stays saved");

    await evaluate('window.workflowEditorFixture.mode("source")');
    await waitFor('Boolean(document.querySelector(".cm-content"))');
    await evaluate('document.querySelector(".cm-content").focus()');
    await window.webContents.insertText("SOURCEEDIT");
    await waitFor("window.workflowEditorFixture.snapshot().dirty");
    state = await snapshot(); assert.ok(state.body.includes("SOURCEEDIT")); assert.equal(state.unsaved, 1);
    results.push("Source typing remains a real edit");
    for (const result of results) console.log(`PASS ${result}`);
    if (output) await writeFile(path.join(output, "results.json"), JSON.stringify({ electron: process.versions.electron, results }, null, 2));
    window.destroy(); app.quit();
  }).catch(error => { console.error(error.stack); app.exit(1); });
}
