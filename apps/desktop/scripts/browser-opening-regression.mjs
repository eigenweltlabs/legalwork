import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BaseWindow, BrowserWindow, WebContentsView, clipboard, session } from "electron";
import { OpenCode } from "@opencode/client";
import { BrowserPasswordStore } from "../../server/dist/browser-passwords.js";
import { OAuthVault } from "../../server/dist/file-storage/oauth/vault.js";
import { createBrowserPanel } from "../electron/browser-panel.mjs";

// Actual panel IPC -> native controller -> released engine tools, with synthetic
// credentials and no visible windows, personal profile or model inference.
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
if (!binary) throw new Error("Set LEGALWORK_TEST_OPENCODE_BIN to the released v2 binary.");
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
app.on("window-all-closed", () => {});
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "legalwork-browser-opening-")));
app.setPath("userData", path.join(root, "profile"));
const secret = "synthetic-opening-password", checks = [];
let engine, panel, window, output = "";
const site = createServer((request, response) => {
  if (request.url === "/signed-in") return response.writeHead(200, { "content-type": "text/html" }).end("<h1>Signed in successfully</h1>");
  response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Opening fixture</title>
    <form onsubmit="event.preventDefault();if(document.querySelector('[name=username]').value==='lawyer' && document.querySelector('[name=password]').value==='${secret}') location.href='/signed-in'; else document.body.append('Invalid credentials')"><label>Username<input autocomplete="username" name="username"></label>
    <label>Password<input type="password" autocomplete="current-password" name="password"></label>
    <button type="submit">Sign in</button></form>`);
});
const watchdog = setTimeout(() => { engine?.kill("SIGKILL"); console.error("Browser opening regression timed out"); app.exit(1); }, 45000);
async function until(test) {
  const end = Date.now() + 10000;
  while (!await test()) {
    if (Date.now() > end) throw new Error("Released engine did not become ready: " + output);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

app.whenReady().then(async () => {
  let status = 0;
  try {
    for (const name of ["matter", "home", "config", "data", "cache", "state", "plugin"]) mkdirSync(path.join(root, name));
    const entry = path.join(root, "fixture.ts"), rpcID = "legalwork.browser.opening.fixture";
    writeFileSync(entry, `import {Plugin} from "@opencode/plugin";
      export default Plugin.define({id:"${rpcID}",async setup(ctx){
        await ctx.rpc.register({id:"${rpcID}",methods:{run:{input:{type:"object",properties:{sessionID:{type:"string"},name:{type:"string"},input:{type:"object"}},required:["sessionID","name","input"]},output:{}}},events:{}},
        {run:async(input,call)=>{const tool=(await ctx.tool.list()).find(t=>[t.options?.namespace,t.name].filter(Boolean).join(".")===input.name);
          if(!tool)throw new Error("Missing native tool "+input.name);
          try{return (await tool.execute(input.input,{sessionID:input.sessionID,agent:"legalwork",messageID:"msg_opening_fixture",id:"call_opening_fixture",signal:call.signal,progress:async()=>{}})).output;}catch(error){return {fixtureError:error.message};}}});
      }});`);
    const build = spawnSync("pnpm", ["--filter", "legalwork-server", "exec", "bun", "build", entry, "--outfile", path.join(root, "plugin", "index.mjs"), "--target", "node", "--format", "esm", "--external", "@opencode/plugin", "--external", "@opencode/plugin/*", "--external", "effect", "--external", "effect/*"], { cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8" });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const password = "isolated-opening-engine";
    engine = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: path.join(root, "matter"), env: {
      PATH: process.env.PATH, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "engine.db"), OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [path.join(root, "plugin")], permissions: [{ action: "*", resource: "*", effect: "allow" }], agents: { legalwork: { system: "Browser fixture", mode: "primary" } } }),
    }, stdio: ["ignore", "pipe", "pipe"] });
    engine.stdout.on("data", value => output += value); engine.stderr.on("data", value => output += value);
    await until(() => /^server listening on (http[^\s]+)/m.test(output));
    const baseUrl = /^server listening on (http[^\s]+)/m.exec(output)[1];
    const client = OpenCode.make({ baseUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
    site.listen(0, "127.0.0.1"); await once(site, "listening");
    const origin = `http://127.0.0.1:${site.address().port}`;
    const store = new BrowserPasswordStore(new OAuthVault(path.join(root, "synthetic.vault")));
    const saved = await store.save({ label: "Opening fixture", origin, username: "lawyer", password: secret });
    window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true });
    await window.loadURL("about:blank");
    panel = createBrowserPanel({ app, BaseWindow, WebContentsView, clipboard, session,
      getWindow: () => window, getWindowForEvent: () => window,
      resolveEngine: async () => ({ running: true, baseUrl, opencodeUsername: "opencode", opencodePassword: password }),
      authorizeBrowserAutomation: async () => {}, resolveDownloadDirectory: async () => path.join(root, "matter"),
      loadBrowserPasswords: async () => store, isAllowedAppNavigation: value => value === "about:blank", safeOpen: { openExternal: async () => false },
    });
    const handlers = new Map(); panel.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on: () => {} });
    const invoke = (name, ...args) => handlers.get(`legalwork:browser:${name}`)({ sender: window.webContents }, ...args);
    const chat = await client.session.create({ agent: "legalwork", location: { directory: path.join(root, "matter") } });
    const context = { workspaceId: "matter", sessionId: chat.id };
    const run = async (name, input) => {
      const value = (await client.rpc.call({ rpcID, method: "run", input: { sessionID: chat.id, name: `browser.${name}`, input }, location: { directory: path.join(root, "matter") } })).output;
      if (value?.fixtureError) throw new Error(value.fixtureError);
      return value;
    };
    const opened = await invoke("openUrl", origin, "builtin", context);
    assert.equal(opened.snapshot.tab.id, opened.tab_id);
    assert.ok(opened.snapshot.tab.generation > 0);
    assert.equal(opened.snapshot.truncated, false);
    assert.equal(opened.snapshot.elements, undefined);
    assert.equal(opened.snapshot.controls, undefined);
    const ref = (observation, label) => {
      const line = observation.content.split("\n").find(line => line.includes(`"${label}"`) && line.includes("@"));
      const value = line?.match(/@e\d+/)?.[0]; assert.ok(value, `Missing native ${label} ref`); return value;
    };
    const oldUsername = ref(opened.snapshot, "Username");
    await run("fill", { tabID: opened.tab_id, ref: oldUsername, text: "opening ref works" });
    assert.equal((await run("evaluate", { tabID: opened.tab_id, ref: oldUsername, script: "element => element.value" })).value, "opening ref works");
    checks.push("Opening returns one native observation whose refs work immediately through released browser.fill");
    const connected = await invoke("connection", opened.tab_id, context);
    assert.equal(connected.tab_id, opened.tab_id);
    await assert.rejects(run("fill", { tabID: opened.tab_id, ref: oldUsername, text: "must fail" }), /stale|newest snapshot/i);
    await assert.rejects(invoke("connection", opened.tab_id, { ...context, sessionId: "another-chat" }), /does not belong/);
    assert.equal((await run("evaluate", { tabID: opened.tab_id, ref: ref(connected.snapshot, "Username"), script: "element => element.value" })).value, "opening ref works");
    checks.push("Reconnect refreshes refs and retains exact chat ownership");
    const beforeReload = connected.snapshot.tab;
    await run("evaluate", { tabID: opened.tab_id, script: "window.unsavedBrowserDraft = 'must survive renderer reload'" });
    const reloaded = once(window.webContents, "did-finish-load");
    window.webContents.reload(); await reloaded;
    await invoke("attachSession", context);
    const retained = await run("evaluate", { tabID: opened.tab_id, ref: ref(connected.snapshot, "Username"), script: "element => ({value:element.value,draft:window.unsavedBrowserDraft})" });
    assert.deepEqual(retained.value, { value: "opening ref works", draft: "must survive renderer reload" });
    assert.equal(retained.tab.generation, beforeReload.generation);
    assert.equal((await invoke("connection", opened.tab_id, context)).tab_id, opened.tab_id);
    checks.push("Reloading the trusted LegalWork renderer preserves the exact browser page, unsaved input, refs and generation");
    const login = await invoke("openUrl", origin, "builtin", context);
    const headers = { "x-legalwork-browser-session": chat.id, "content-type": "application/json" };
    const listed = await (await fetch(`${login.browser_url}/passwords`, { headers })).json();
    assert.equal(listed.passwords[0].id, saved.id);
    // One sequential program; no extra observation between the known form steps.
    await run("fill", { tabID: login.tab_id, ref: ref(login.snapshot, "Username"), text: listed.passwords[0].username });
    const fill = await fetch(`${login.browser_url}/fill-password`, { method: "POST", headers, body: JSON.stringify({ password_id: saved.id, ref: ref(login.snapshot, "Password") }) });
    assert.equal(fill.status, 200); assert.equal((await fill.text()).includes(secret), false);
    assert.equal((await run("evaluate", { tabID: login.tab_id, ref: ref(login.snapshot, "Username"), script: "element => element.value" })).value, "lawyer");
    // Hidden Chromium mouse/keyboard submission needs a compositor surface on
    // macOS. Use the native evaluate tool on the observed button for this test.
    await run("evaluate", { tabID: login.tab_id, ref: ref(login.snapshot, "Sign in"), script: "element => { setTimeout(() => element.click(), 0); return true; }" });
    await run("wait", { tabID: login.tab_id, condition: "text", text: "Signed in successfully" });
    const after = await run("snapshot", { tabID: login.tab_id });
    assert.ok(after.content.includes("Signed in successfully"));
    assert.equal(JSON.stringify(after).includes(secret), false);
    assert.ok(after.tab.generation > login.snapshot.tab.generation);
    checks.push("Username, vault password and authorized submit compose without an intermediate snapshot; condition wait verifies navigation");

    // Exercise the released native tools, not just the legacy openUrl bridge.
    // Agent focus must remain independent of the user's visible workspace.
    for (const input of [{ url: origin, focus: true }, { url: origin }, { url: origin, focus: false }]) {
      const tab = await run("tabs.open", input);
      assert.equal(invoke("state").activeTabId, null, "Agent opening must not select a user tab");
      assert.equal(invoke("state").tabs.find(candidate => candidate.id === tab.id).background, true);
      assert.equal(window.contentView.children.length, 0);
    }
    await run("tabs.focus", { tabID: opened.tab_id });
    assert.equal((await run("tabs.list", {})).focusedTabID, opened.tab_id);
    assert.equal(invoke("state").activeTabId, null);
    checks.push("Native opening with explicit, default or disabled focus and tabs.focus keep agent tabs in the background");

    const foreground = await invoke("createTab", origin);
    const bounds = { x: 0, y: 0, width: 900, height: 700 };
    invoke("show", bounds, foreground.tabId);
    const visibleView = window.contentView.children[0];
    const agentTab = await run("tabs.open", { url: origin, focus: true });
    await run("tabs.focus", { tabID: opened.tab_id });
    assert.equal((await run("tabs.list", {})).focusedTabID, opened.tab_id);
    assert.equal(invoke("state").activeTabId, foreground.tabId);
    assert.deepEqual(window.contentView.children, [visibleView]);

    invoke("selectTab", agentTab.id);
    invoke("hide", foreground.tabId);
    invoke("show", bounds, agentTab.id);
    assert.equal(invoke("state").activeTabId, agentTab.id);
    assert.equal(invoke("state").tabs.find(candidate => candidate.id === agentTab.id).background, false);
    assert.notEqual(window.contentView.children[0], visibleView);
    invoke("closeTab", agentTab.id);
    assert.equal(invoke("state").tabs.find(candidate => candidate.id === agentTab.id).background, true);
    invoke("selectTab", foreground.tabId);
    invoke("show", bounds, foreground.tabId);
    await run("tabs.focus", { tabID: agentTab.id });
    assert.equal((await run("tabs.list", {})).focusedTabID, agentTab.id);
    assert.equal(invoke("state").activeTabId, foreground.tabId);
    assert.deepEqual(window.contentView.children, [visibleView]);
    checks.push("User selection reveals an agent tab; closing returns it to the background and later agent focus cannot reopen it");
    invoke("closeTab", foreground.tabId);

    await window.loadURL("data:text/html,<title>Untrusted host navigation</title>");
    await until(() => invoke("state").tabs.length === 0);
    checks.push("Navigating the host outside the trusted app still closes its browser attachment");
    assert.equal(BrowserWindow.getAllWindows().some(win => win.isVisible() || win.isFocused()), false);
    checks.push("All windows remained hidden and unfocused");
    console.log(JSON.stringify({ passed: true, checks, openingSnapshotChars: opened.snapshot.content.length, submitMethod: "native-evaluate-on-observed-button", modelCalls: 0, realCredentials: false }, null, 2));
  } catch (error) { status = 1; console.error(error); }
  finally {
    clearTimeout(watchdog); panel?.destroy(); window?.destroy();
    if (engine?.exitCode === null) { const exited = once(engine, "exit"); engine.kill("SIGTERM"); await exited; }
    site.close(); site.closeAllConnections();
    rmSync(root, { recursive: true, force: true }); app.exit(status);
  }
});
