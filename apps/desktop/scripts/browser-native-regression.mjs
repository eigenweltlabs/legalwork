import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BaseWindow, BrowserWindow, WebContentsView, clipboard, nativeImage, session } from "electron";
import { OpenCode } from "@opencode/client";
import { createBrowserPanel } from "../electron/browser-panel.mjs";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
if (!binary) throw new Error("Set LEGALWORK_TEST_OPENCODE_BIN to the isolated released2.1.4 binary.");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "legalwork-native-browser-")));
app.setPath("userData", path.join(root, "profile"));
setTimeout(() => { console.error("Native browser regression timed out."); for (const process of [serverChild, child]) process?.kill("SIGKILL"); app.exit(1); }, 90000).unref();
let child, serverChild, panel, main, detached;
const large = Buffer.alloc(6 * 1024 * 1024, 97);
const fixture = createServer((request, response) => {
  if (request.url === "/download") return response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="large-record.bin"', "content-length": large.length }).end(large);
  if (request.url === "/viewport") return response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Viewport edge fixture</title><style>body{margin:0;min-height:1400px;background:white}#edge{position:fixed;right:0;top:0;bottom:0;width:12px;background:rgb(196,32,212)}</style><div id="edge"></div>`);
  response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Native browser fixture</title><style>body{font:18px sans-serif;padding:24px}label{display:block;margin:12px}</style><h1>Native browser fixture</h1><label>Name<input id="name"></label><button onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button><p id="result">Not saved</p><input type="file" id="upload"><a href="/download">Download record</a><script>console.log('native fixture console');window.sharedValue=localStorage.getItem('shared');</script>`);
});
const rpcID = "legalwork.browser.fixture";
let output = "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error(typeof message === "function" ? message() : message); await sleep(30); } }
app.whenReady().then(async () => {
  let status = 0;
  try {
    for (const name of ["a", "b", "home", "config", "data", "cache", "state", "plugin"]) mkdirSync(path.join(root, name));
    const entry = path.join(root, "fixture.ts");
    writeFileSync(entry, `import {Plugin} from "@opencode/plugin";export default Plugin.define({id:"${rpcID}",async setup(ctx){await ctx.rpc.register({id:"${rpcID}",methods:{run:{input:{type:"object",properties:{sessionID:{type:"string"},name:{type:"string"},input:{type:"object"}},required:["sessionID","name","input"]},output:{}},catalog:{input:{type:"object"},output:{type:"array",items:{type:"string"}}}},events:{}},{catalog:async()=> (await ctx.tool.list()).filter(t=>t.options?.namespace?.startsWith("browser")).map(t=>t.id),run:async(input,call)=>{const tool=(await ctx.tool.list()).find(t=>t.id===input.name||[t.options?.namespace,t.name].filter(Boolean).join(".")===input.name);if(!tool)throw new Error("Missing native tool "+input.name);try{const value=await tool.execute(input.input,{sessionID:input.sessionID,agent:"legalwork",messageID:"msg_browser_fixture",id:"call_browser_fixture",signal:call.signal,progress:async()=>{}});return value.output??value;}catch(error){return {fixtureError:error.message};}}});}});`);
    const build = spawnSync("pnpm", ["--filter", "legalwork-server", "exec", "bun", "build", entry, "--outfile", path.join(root, "plugin", "index.mjs"), "--target", "node", "--format", "esm", "--external", "@opencode/plugin", "--external", "@opencode/plugin/*", "--external", "effect", "--external", "effect/*"], { cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8" });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const password = "isolated-browser-fixture-password";
    child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: path.join(root, "a"), env: {
      PATH: process.env.PATH, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "engine.db"), OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [path.join(root, "plugin")], permissions: [{ action: "*", resource: "*", effect: "allow" }], agents: { legalwork: { system: "Browser fixture", mode: "primary" } } }),
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", value => output += value); child.stderr.on("data", value => output += value);
    await until(() => /^server listening on (http[^\s]+)/m.test(output), "Engine did not listen: " + output);
    const url = /^server listening on (http[^\s]+)/m.exec(output)[1];
    const client = OpenCode.make({ baseUrl: url, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
    fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const serverConfig = { configPath: path.join(root, "server.json"), host: "127.0.0.1", port: 0, token: "manual-browser-client", hostToken: "manual-browser-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: ["a", "b"].map(id => ({ id, name: id, path: path.join(root, id), preset: "starter", workspaceType: "local" })), authorizedRoots: [path.join(root, "a"), path.join(root, "b")], readOnly: false, agentSandboxEnabled: true, engineProjectTrustRequired: true, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, opencodeBaseUrl: url, opencodeUsername: "opencode", opencodePassword: password };
    const configFile = path.join(root, "server-fixture.json"); writeFileSync(configFile, JSON.stringify(serverConfig), { mode: 0o600 });
    const bun = spawnSync("pnpm", ["--filter", "legalwork-server", "exec", "which", "bun"], { cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8" }).stdout.trim();
    let serverOutput = "";
    serverChild = spawn(bun, ["scripts/browser-native-server-fixture.ts", configFile], { cwd: path.resolve(import.meta.dirname, "../../server"), env: { PATH: process.env.PATH, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") }, stdio: ["ignore", "pipe", "pipe"] });
    serverChild.stdout.on("data", value => serverOutput += value); serverChild.stderr.on("data", value => serverOutput += value);
    await until(() => /BROWSER_FIXTURE_SERVER=(http[^\s]+)/.test(serverOutput), () => "Real LegalWork server did not listen: " + serverOutput);
    const manualURL = /BROWSER_FIXTURE_SERVER=(http[^\s]+)/.exec(serverOutput)[1];
    main = new BrowserWindow({ show: true, width: 1300, height: 900 }); detached = new BrowserWindow({ show: false });
    await main.loadURL("about:blank"); await detached.loadURL("about:blank");
    const blocked = new Set();
    panel = createBrowserPanel({ app, BaseWindow, WebContentsView, clipboard, session,
      getWindow: () => main, getWindowForEvent: event => BrowserWindow.fromWebContents(event.sender),
      resolveEngine: async () => ({ running: true, baseUrl: url, opencodeUsername: "opencode", opencodePassword: password }),
      authorizeBrowserAutomation: async context => { if (blocked.has(context.sessionId)) throw new Error("Browser tools are disabled."); },
      resolveDownloadDirectory: async context => path.join(root, context.workspaceId), isAllowedAppNavigation: value => value === "about:blank", safeOpen: { openExternal: async () => false },
    });
    const handlers = new Map(); panel.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler), on: () => {} });
    const invoke = (owner, name, ...args) => handlers.get(`legalwork:browser:${name}`)({ sender: owner.webContents }, ...args);
    const a = await client.session.create({ agent: "legalwork", location: { directory: path.join(root, "a") } });
    const b = await client.session.create({ agent: "legalwork", location: { directory: path.join(root, "b") } });
    const contextA = { workspaceId: "a", sessionId: a.id }, contextB = { workspaceId: "b", sessionId: b.id };
    await invoke(main, "attachSession", contextA); await invoke(main, "attachSession", contextB);
    const run = async (sessionID, name, input = {}) => {
      const value = (await client.rpc.call({ rpcID, method: "run", input: { sessionID, name: `browser.${name}`, input }, location: { directory: sessionID === a.id ? path.join(root, "a") : path.join(root, "b") } }, { signal: AbortSignal.timeout(15000) })).output;
      if (value?.fixtureError) throw new Error(value.fixtureError); return value;
    };
    const catalog = (await client.rpc.call({ rpcID, method: "catalog", input: {}, location: { directory: path.join(root, "a") } })).output;
    assert.ok(catalog.length >= 40, "Every native browser operation must remain registered: " + JSON.stringify(catalog));
    const tabA = await run(a.id, "tabs.open", { url: origin, focus: false });
    assert.match(tabA.id, /^tab_[a-f0-9-]{36}$/);
    await run(a.id, "evaluate", { tabID: tabA.id, script: "localStorage.setItem('shared','present');document.cookie='shared=yes';true" });
    const tabB = await run(b.id, "tabs.open", { url: origin, focus: false });
    assert.equal((await run(b.id, "evaluate", { tabID: tabB.id, script: "({value:localStorage.getItem('shared'),cookie:document.cookie})" })).value.value, "present");
    assert.ok((await run(b.id, "evaluate", { tabID: tabB.id, script: "document.cookie" })).value.includes("shared=yes"));
    await assert.rejects(run(a.id, "snapshot", { tabID: tabB.id }), /unavailable|not found|owned/i);
    const snapshot = await run(a.id, "snapshot", { tabID: tabA.id });
    assert.ok(JSON.stringify(snapshot).includes("Native browser fixture"));
    const connection = await invoke(main, "connection", tabA.id, contextA);
    await fetch(`${connection.browser_url}/batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ steps: [{ action: "fill", selector: "#name", value: "Alice" }, { action: "click", selector: "button" }] }) }).then(async response => assert.equal(response.status, 200, await response.text()));
    assert.equal((await run(a.id, "evaluate", { tabID: tabA.id, script: "document.querySelector('#result').textContent" })).value, "Saved Alice");
    const headers = { "content-type": "application/json", "x-legalwork-browser-session": a.id };
    const upload = await fetch(`${connection.browser_url}/upload`, { method: "POST", headers, body: JSON.stringify({ selector: "#upload", files: [{ name: "large-upload.bin", data: large.toString("base64") }] }) });
    assert.equal(upload.status, 200, await upload.text());
    assert.equal((await run(a.id, "evaluate", { tabID: tabA.id, script: "document.querySelector('#upload').files[0].size" })).value, large.length);
    const capture = await fetch(`${connection.browser_url}/capture`, { method: "POST", headers, body: JSON.stringify({ format: "png" }) });
    assert.equal(capture.status, 200); const image = await capture.json(); assert.ok(Buffer.from(image.data, "base64").length > 1000);
    assert.equal((await fetch(`${connection.browser_url}/capture`, { method: "POST", headers: { ...headers, "x-legalwork-browser-session": b.id }, body: "{}" })).status, 403);

    const generation = (await run(a.id, "tabs.list")).tabs[0].generation;
    await run(a.id, "navigate", { tabID: tabA.id, url: origin + "/changed" });
    assert.ok((await run(a.id, "tabs.list")).tabs[0].generation > generation);
    await run(a.id, "evaluate", { tabID: tabA.id, script: "document.querySelector('a').click();true" });
    let downloaded;
    await until(async () => { downloaded = (await (await fetch(`${connection.browser_url}/downloads`)).json()).downloads.find(file => file.name === "large-record.bin"); return downloaded?.state === "completed"; }, "A >5MiB download was cancelled or lost.");
    assert.equal(downloaded.receivedBytes, large.length); assert.equal(downloaded.relativePath, "Downloads/large-record.bin"); assert.deepEqual(readFileSync(downloaded.path), large);
    assert.ok((await run(a.id, "files.list", { tabID: tabA.id })).files.some(file => file.bytes === large.length));
    await assert.rejects(run(a.id, "files.get", { tabID: tabA.id, fileID: downloaded.id }), /5 MiB|exceeds/);
    await assert.rejects(invoke(main, "connection", tabB.id, contextA), /does not belong/);
    invoke(main, "show", { x: 0, y: 0, width: 1100, height: 750 }, tabA.id);
    const screenshot = await run(a.id, "screenshot", { tabID: tabA.id, maxWidth: 1000 }); assert.ok(screenshot.files[0].path);
    await run(a.id, "navigate", { tabID: tabA.id, url: origin + "/viewport" });
    const viewportWidth = async () => (await run(a.id, "evaluate", { tabID: tabA.id, script: "document.documentElement.clientWidth" })).value;
    const widthBefore = await viewportWidth();
    const viewport = await run(a.id, "screenshot", { tabID: tabA.id, format: "png", maxWidth: 4000 });
    const pixels = nativeImage.createFromPath(viewport.files[0].path);
    assert.equal(pixels.isEmpty(), false);
    const size = pixels.getSize(), bitmap = pixels.toBitmap();
    let purple = 0;
    for (let x = Math.max(0, size.width - 50); x < size.width; x++) {
      const offset = (Math.floor(size.height / 2) * size.width + x) * 4;
      if (bitmap[offset] === 212 && bitmap[offset + 1] === 32 && bitmap[offset + 2] === 196 && bitmap[offset + 3] === 255) purple++;
    }
    assert.ok(purple > 0, "Native viewport screenshot lost the right-edge marker when a scrollbar was present.");
    assert.equal(await viewportWidth(), widthBefore, "Viewport capture must not resize page content.");
    await run(a.id, "navigate", { tabID: tabA.id, url: origin + "/changed" });
    await run(a.id, "evaluate", { tabID: tabA.id, script: "console.log('after-download fixture');true" });
    const consoleMessages = await run(a.id, "console", { tabID: tabA.id }); assert.ok(consoleMessages.messages.length);
    const network = await run(a.id, "network.list", { tabID: tabA.id }); assert.ok(Array.isArray(network.requests));
    // A separate real LegalWork process owns the server filesystem; main has only its user client token.
    const registration = await invoke(main, "registerConnection", { baseUrl: manualURL, token: "manual-browser-client" });
    const c = await client.session.create({ agent: "legalwork", location: { directory: path.join(root, "a") } });
    const contextC = { workspaceId: "a", sessionId: c.id, connectionId: registration.connectionId };
    const manualHeaders = { authorization: "Bearer manual-browser-client", "content-type": "application/json" };
    const gate = `${manualURL}/workspace/a/browser/${c.id}/api/session/${c.id}`;
    const projectA = await fetch(`${manualURL}/workspace/a/engine-project`, { headers: manualHeaders });
    assert.equal(projectA.status, 200); assert.equal((await projectA.json()).state, "ready");
    const actors = { viewer: "owt_retired_browser_viewer", other: "owt_retired_browser_collaborator" };
    assert.equal((await fetch(gate, { headers: { authorization: `Bearer ${actors.viewer}` } })).status, 401, "Retired viewer tokens must not authorize browser access.");
    await invoke(main, "attachSession", contextC);
    const remoteRun = async (name, input = {}) => { const result = (await client.rpc.call({ rpcID, method: "run", input: { sessionID: c.id, name: `browser.${name}`, input }, location: { directory: path.join(root, "a") } }, { signal: AbortSignal.timeout(15000) })).output; if (result?.fixtureError) throw new Error(result.fixtureError); return result; };
    const remoteTab = await remoteRun("tabs.open", { url: origin, focus: false });
    assert.equal((await remoteRun("evaluate", { tabID: remoteTab.id, script: "document.title" })).value, "Native browser fixture");
    await assert.rejects(invoke(detached, "attachSession", contextC), /another app window/);
    const remoteConnection = await invoke(main, "connection", remoteTab.id, contextC);
    assert.ok(remoteConnection.browser_url.startsWith(manualURL + "/workspace/a/browser/")); assert.equal(remoteConnection.download_directory, null);
    const remoteHeaders = { authorization: "Bearer manual-browser-client", "content-type": "application/json", "x-legalwork-browser-session": c.id };
    const transferred = await fetch(`${remoteConnection.browser_url}/upload`, { method: "POST", headers: remoteHeaders, body: JSON.stringify({ selector: "#upload", files: [{ name: "remote-large.bin", data: large.toString("base64") }] }) });
    assert.equal(transferred.status, 200, await transferred.text()); assert.equal((await remoteRun("evaluate", { tabID: remoteTab.id, script: "document.querySelector('#upload').files[0].size" })).value, large.length);
    const remoteCapture = await fetch(`${remoteConnection.browser_url}/capture`, { method: "POST", headers: remoteHeaders, body: JSON.stringify({ format: "png" }) }); assert.equal(remoteCapture.status, 200, await remoteCapture.text());
    await remoteRun("evaluate", { tabID: remoteTab.id, script: "document.querySelector('a').click();true" });
    let remoteDownload;
    await until(async () => { const response = await fetch(`${remoteConnection.browser_url}/downloads`, { headers: remoteHeaders }); const result = await response.json(); remoteDownload = result.downloads?.find(file => file.name === "large-record.bin" && file.state === "completed"); return Boolean(remoteDownload); }, "Manual server download did not complete.");
    assert.equal(remoteDownload.path, null); assert.equal(remoteDownload.transferRequired, true);
    const remoteBytes = await fetch(`${remoteConnection.browser_url}/download`, { method: "POST", headers: remoteHeaders, body: JSON.stringify({ id: remoteDownload.id }) }); assert.equal(remoteBytes.status, 200); assert.deepEqual(Buffer.from((await remoteBytes.json()).data, "base64"), large);
    assert.equal((await fetch(`${remoteConnection.browser_url}/download`, { method: "POST", headers: { ...remoteHeaders, "x-legalwork-browser-session": a.id }, body: JSON.stringify({ id: remoteDownload.id }) })).status, 403);
    assert.equal((await fetch(`${manualURL}/workspace/b/browser/${c.id}/api/session/${c.id}`, { headers: remoteHeaders })).status, 404, "A forged chat must not activate another project.");
    const projectB = await fetch(`${manualURL}/workspace/b/engine-project`, { headers: manualHeaders });
    assert.equal(projectB.status, 200); assert.equal((await projectB.json()).state, "ready");
    assert.equal((await fetch(`${manualURL}/workspace/b/browser/${c.id}/api/session/${c.id}`, { headers: remoteHeaders })).status, 404);
    assert.equal((await fetch(`${manualURL}/workspace/a/browser/${c.id}/api/rpc/admin/anything`, { method: "POST", headers: remoteHeaders, body: "{}" })).status, 404);
    const cancelled = new AbortController();
    const delivered = fetch(`${remoteConnection.browser_url}/batch`, { method: "POST", headers: remoteHeaders, body: JSON.stringify({ steps: [{ action: "click", selector: "button" }, { action: "wait_for", text: "never-present-fixture" }], timeout_ms: 30000 }), signal: cancelled.signal }).catch(error => error);
    await until(async () => (await remoteRun("evaluate", { tabID: remoteTab.id, script: "window.clicks||0" })).value === 1, "Remote batch never reached its mutation.");
    cancelled.abort(); await delivered; await sleep(150);
    assert.equal((await remoteRun("evaluate", { tabID: remoteTab.id, script: "window.clicks" })).value, 1, "Cancelled delivered mutations must never replay.");
    const security = await client.session.create({ agent: "legalwork", location: { directory: path.join(root, "a") } });
    const securityBase = `${manualURL}/workspace/a/browser/${security.id}/api`, connectionID = "security-fixture-connection";
    const securityAbort = new AbortController();
    const attachment = fetch(`${securityBase}/rpc/experimental.browser/attach`, { method: "POST", headers: manualHeaders, body: JSON.stringify({ input: { sessionID: security.id, connectionID, version: 4 } }), signal: securityAbort.signal }).catch(error => error);
    await sleep(100);
    const other = await fetch(`${securityBase}/rpc/experimental.browser/state`, { method: "POST", headers: { ...manualHeaders, authorization: `Bearer ${actors.other}` }, body: JSON.stringify({ input: { sessionID: security.id, connectionID, state: { tabs: [], focusedTabID: null } } }) }); assert.equal(other.status, 401, "Retired shared collaborator tokens must not hijack a desktop attachment.");
    securityAbort.abort(); await attachment;
    const worker = await client.session.create({ agent: "document-extractor", metadata: { legalworkReviewWorker: true }, location: { directory: path.join(root, "a") } });
    assert.equal((await fetch(`${manualURL}/workspace/a/browser/${worker.id}/api/session/${worker.id}`, { headers: manualHeaders })).status, 403);

    await invoke(detached, "attachSession", contextA); await sleep(100);
    await assert.rejects(invoke(main, "attachSession", contextA), /another app window/);
    await invoke(main, "attachSession", { ...contextA, takeControl: true });
    assert.ok((await run(b.id, "evaluate", { tabID: tabB.id, script: "1+1" })).value === 2, "Replacing A must not break B's shared-profile networking.");
    blocked.add(b.id);
    await until(() => !invoke(main, "state").tabs.some(tab => tab.id === tabB.id), "Idle policy revocation did not close the native page.");
    console.log(`PASS: ${catalog.length} native operations registered; RPCv4/CDP navigation, snapshots, eval, legacy batch, session ownership, generation, shared cookies/storage, >5MiB project downloads, screenshot, diagnostics, replacement, idle policy revocation, separate manual LWserver browser gateway and full remote file/capture channel; zero model calls.`);
  } catch (error) { status = 1; console.error(error); console.error(output); }
  finally {
    panel?.destroy();
    if (serverChild) { const exited = once(serverChild, "exit"); serverChild.kill("SIGTERM"); await Promise.race([exited, sleep(3000)]); if (serverChild.exitCode === null) { serverChild.kill("SIGKILL"); await exited; } }
    if (child) { const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, sleep(3000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await exited; } }
    fixture.close(); await sleep(100); rmSync(root, { recursive: true, force: true }); main?.destroy(); detached?.destroy(); app.exit(status);
  }
});
