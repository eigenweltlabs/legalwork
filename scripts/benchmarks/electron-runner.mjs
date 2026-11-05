import { verifyPaidRunBudget } from "./budget-ceiling.mjs";
import { verifyPackagedRendererIdentity } from "./packaged-renderer.mjs";
import { toolExecutionCoverage, reconcileToolTrace } from "./tool-coverage.mjs";
import { assertTaskSession, selectedModelEvidence, primaryMessageIntegrity, providerWireIntegrity, observeNativeModelCatalog, assertNativeModelCatalogUnchanged } from "./admission-invariants.mjs";
import {detectEngineProtocol,skillCatalogIdentity,engineEventIdentity,observeSessionActivity,observeSessionInteractions,sessionTreeIDs} from "./engine-evidence.mjs";
import {fileURLToPath} from "node:url";
import { StringDecoder } from "node:string_decoder";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { evaluateAssertions, fingerprintTree, inside, privateWrite, readJson, sha256, summarizeMessages } from "./evidence.mjs";
import { browserDownloadKey, evaluateBrowserRegisterExecution } from "./browser-register-evidence.mjs";
import { extractFullArtifact, makeWordFixture } from "./artifacts.mjs";
import { snapshotTaskInputs } from "./source-inputs.mjs";
import { externalDirectoryDecision, permissionReplyEvent } from "./permission-policy.mjs";
import { focusNormalUiSession, assertEmptyCreatedTaskHistory } from "./normal-ui-focus.mjs";
import { refreshDelegationTree } from "./delegation-evidence.mjs";
import { openEventStream, eventStreamErrorEvidence } from "./event-stream.mjs";

export async function discoverElectron(profile, workspacePath) {
  const [ui, state, tokens] = await Promise.all([readJson(join(profile, "legalwork-ui-control.json")), readJson(join(profile, "legalwork-server-state.json")), readJson(join(profile, "legalwork-server-tokens.json"))]);
  const key = workspacePath.toLowerCase();
  const port = state.workspacePorts?.[key];
  const token = tokens.workspaces?.[key]?.clientToken;
  const hostToken = tokens.workspaces?.[key]?.hostToken;
  if (!port || !token) throw new Error("The isolated Electron profile has not started its workspace server");
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/workspaces`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Workspace discovery HTTP ${response.status}`);
  const workspaces = await response.json();
  const workspace = workspaces.items?.find(item => resolve(item.path) === resolve(workspacePath));
  if (!workspace) throw new Error("Isolated workspace is absent from Electron's embedded server");
  for (const endpoint of [base, ui.baseUrl]) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("Regression harness only connects to isolated loopback services");
  }
  const focus=await readJson(join(profile,"legalwork-benchmark-ui-control.json")).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
  if(focus && !/^http:\/\/127\.0\.0\.1:\d+$/.test(focus.baseUrl))throw new Error("Benchmark focus must be an isolated loopback service");
  return { ui, base, token, hostToken, workspace, focus };
}

export function createDriver(connection, evidence, { uiReadyTimeoutMs = 30000 } = {}) {
  let sequence = 0;
  async function request(surface, path, body, signal) {
    const id = `${String(++sequence).padStart(6, "0")}-${surface}`;
    const url = surface === "host-root" ? `${connection.base}${path}` : surface === "host" ? `${connection.base}/workspace/${connection.workspace.id}${path}` : surface === "ui" ? `${connection.ui.baseUrl}${path}` : `${connection.base}/workspace/${connection.workspace.id}/opencode${path}${path.startsWith("/api/") ? "":`${path.includes("?") ? "&":"?"}directory=${encodeURIComponent(connection.workspace.path)}`}`;
    const started = performance.now();
    await privateWrite(join(evidence, "api", `${id}.request.json`), { path, surface, method: body === undefined ? "GET" : "POST", body, startedAt: new Date().toISOString() });
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${surface === "ui" ? connection.ui.token : connection.token}`, "content-type": "application/json", ...(["host","host-root"].includes(surface) ? { "x-legalwork-host-token": connection.hostToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    const raw = await response.text();
    await privateWrite(join(evidence, "api", `${id}.response.json`), { status: response.status, elapsedMs: performance.now() - started, raw });
    if (!response.ok) {const error=new Error(`${surface} ${path}: HTTP ${response.status}; full response preserved in private evidence`);error.status=response.status;try { const code=JSON.parse(raw).code; if (typeof code === "string") error.code=code; } catch { /* Complete raw response remains in private evidence. */ }throw error;}
    try { return raw ? JSON.parse(raw) : null; }
    catch (cause) {
      const error = new Error(`${surface} ${path}: non-JSON response; full response preserved in private evidence`, { cause });
      error.code = response.headers.get("content-type")?.includes("text/html") ? "html-fallback-response" : "invalid-json-response";
      throw error;
    }
  }
  return {
    engine: (path, body, signal) => request("engine", path, body, signal),
    pendingHostApprovals: async () => {
      if(!connection.hostToken)throw new Error("Host approval observation requires the isolated host credential");
      const response=await request("host-root","/approvals");
      if(!Array.isArray(response.items))throw new Error("Invalid complete host approval list");
      return response.items.filter(request=>request.workspaceId===connection.workspace.id);
    },
    observerCatalog: () => { if (!connection.hostToken) throw new Error("The isolated host observer credential is unavailable"); return request("host", "/benchmarks/observer/catalog"); },
    modelTransport: modelID => { if (!connection.hostToken) throw new Error("The isolated host observer credential is unavailable"); return request("host", `/benchmarks/observer/model-transport?${new URLSearchParams({modelID})}`); },
    focusChat: async sessionID => {
      if (connection.focus?.kind === "normal-ui-control") {
        const result = await focusNormalUiSession({ connection, sessionID, request, uiReadyTimeoutMs });
        await privateWrite(join(evidence,"api",`${String(++sequence).padStart(6,"0")}-normal-ui-focus.json`), result);
        return result;
      }
      if(!connection.focus)throw new Error("Restart the benchmark launcher to enable its explicit chat-tab focus hook");
      if(connection.focus.kind)throw new Error("Unknown explicit focus mechanism; no fallback hook or Send was used");
      const response=await fetch(`${connection.focus.baseUrl}/focus-chat`,{method:"POST",headers:{authorization:`Bearer ${connection.focus.token}`,"content-type":"application/json"},body:JSON.stringify({sessionID})});
      const result=await response.json();
      await privateWrite(join(evidence,"api",`${String(++sequence).padStart(6,"0")}-benchmark-focus.json`),{sessionID,status:response.status,result});
      if(!response.ok || !result.focused)throw new Error("Actual owned chat tab could not be focused before composer admission");
      return result;
    },
    snapshot: () => request("ui", "/snapshot"),
    actions: () => request("ui", "/actions"),
    action: async (actionId, args = {}) => {
      const result = await request("ui", "/execute", { actionId, args });
      if (!result.ok) throw new Error(`Electron action ${actionId} failed: ${result.error}`);
      return result;
    },
  };
}

export async function captureEvents(connection, directory, controller,protocol) {
  const stream = await open(join(directory, "engine-events.sse"), "wx", 0o600);
  const index = await open(join(directory, "engine-event-chunks.jsonl"), "wx", 0o600);
  const events=await open(join(directory,"engine-event-index.jsonl"),"wx",0o600);
  const started = performance.now();
  const lifecycle = { kind: "benchmark-event-stream-lifecycle", transport: "node-http", startedAt: new Date().toISOString(), bodyIdleTimeoutMs: null, reconnects: 0, bytes: 0, lastChunkAt: null, lastChunkElapsedMs: null };
  let response;
  try {
    response = await openEventStream(`${connection.base}/workspace/${connection.workspace.id}/opencode${protocol.eventPath}`, { headers: { authorization: `Bearer ${connection.token}` }, signal: controller.signal });
  } catch (error) {
    await stream.close(); await index.close();await events.close();
    await privateWrite(join(directory,"engine-event-stream-lifecycle.json"), { ...lifecycle, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started, aborted: controller.signal.aborted, error: eventStreamErrorEvidence(error) });
    throw error;
  }
  let failure;
  const permissionReplies = [];
  const done = (async () => {
    let offset = 0;let eventOffset=0;let buffered="";const decoder=new StringDecoder("utf8");
    try {
      for await (const chunk of response) {
        await stream.writeFile(chunk);
        lifecycle.lastChunkAt = new Date().toISOString();
        lifecycle.lastChunkElapsedMs = performance.now() - started;
        await index.writeFile(`${JSON.stringify({ elapsedMs: lifecycle.lastChunkElapsedMs, observedAt: lifecycle.lastChunkAt, offset, bytes: chunk.byteLength })}\n`);
        offset += chunk.byteLength;
        lifecycle.bytes = offset;
        buffered+=decoder.write(chunk);
        let boundary;
        while((boundary=/\r?\n\r?\n/.exec(buffered))) {
          const consumed=buffered.slice(0,boundary.index+boundary[0].length);const frame=buffered.slice(0,boundary.index);
          const data=frame.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
          if(data) {let identity;let parseError;try{const parsed=JSON.parse(data);identity=engineEventIdentity(parsed);const reply=permissionReplyEvent(parsed);if(reply)permissionReplies.push({...reply,eventOffset,eventBytes:Buffer.byteLength(consumed),observedAt:new Date().toISOString()});}catch(error){parseError=String(error);failure=new Error("Malformed engine event; complete raw frame retained but parsed event coverage is incomplete");}
            await events.writeFile(`${JSON.stringify({elapsedMs:performance.now()-started,eventOffset,eventBytes:Buffer.byteLength(consumed),identity,parseError})}\n`);}
          eventOffset+=Buffer.byteLength(consumed);buffered=buffered.slice(consumed.length);
        }
      }
      if (!controller.signal.aborted) failure ??= new Error("Engine event stream disconnected; benchmark evidence is incomplete");
    } catch (error) {
      const ownedAbort = controller.signal.aborted && ["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET"].includes(error.code);
      if (!ownedAbort) failure ??= error;
    }
    finally {
      const finishedAt = new Date().toISOString();
      const elapsedMs = performance.now() - started;
      await stream.close(); await index.close();await events.close();
      await privateWrite(join(directory,"engine-event-stream-lifecycle.json"), { ...lifecycle, finishedAt, elapsedMs, quietMsBeforeFinish: lifecycle.lastChunkElapsedMs === null ? null : elapsedMs - lifecycle.lastChunkElapsedMs, responseComplete: response.complete, aborted: controller.signal.aborted, error: failure ? eventStreamErrorEvidence(failure) : null });
    }
  })();
  return { done, permissionReplies: () => [...permissionReplies], check: () => { if (failure) throw failure; } };
}

export async function preflight({ repo, profile, workspace, evidence, expectedBase, uiReadyTimeoutMs = 30000, environment }) {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const dev = git("rev-parse", "origin/dev");
  if (!environment) execFileSync("git", ["merge-base", "--is-ancestor", dev, "HEAD"], { cwd: repo });
  if (!environment && expectedBase && dev !== expectedBase) throw new Error(`origin/dev changed: expected ${expectedBase}, found ${dev}. Review the new baseline before paid runs.`);
  const patch = await open(join(evidence, "source.patch"), "wx", 0o600);
  try { execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: repo, stdio: ["ignore", patch.fd, "pipe"] }); }
  finally { await patch.close(); }
  const diff = await readFile(join(evidence, "source.patch"));
  const connection = environment ? await environment.discover() : await discoverElectron(profile, workspace);
  const driver = createDriver(connection, evidence, { uiReadyTimeoutMs });
  const protocol=await detectEngineProtocol(driver,connection.workspace.path);
  let [ui,skillItems,catalogs]=await Promise.all([driver.snapshot(),protocol.skills(),protocol.catalogs()]);
  const health=protocol.health;const tools=catalogs.tools;
  const pendingInteractions=await protocol.interactions();
  await privateWrite(join(evidence,"pending-interactions-preflight.json"),pendingInteractions);
  if (!ui.ok || !Array.isArray(ui.actions)) throw new Error("Real Electron renderer control surface is unavailable");
  const uiReadyStarted = performance.now();
  if (!ui.actions.some(action => action.id === "session.create_task") && ui.actions.some(action => action.id === "route.session" && !action.disabled)) {
    await driver.action("route.session");
    ui = await driver.snapshot();
  }
  while (!ui.actions.some(action => action.id === "session.create_task")) {
    if (performance.now() - uiReadyStarted >= uiReadyTimeoutMs) throw new Error("Real Electron task actions did not mount within the explicit UI startup watchdog");
    await delay(100);
    ui = await driver.snapshot();
  }
  if (!ui.actions.some(action => action.id === "composer.set_text")) {
    await driver.action("session.create_task");
    do {
      ui = await driver.snapshot();
      if (ui.actions.some(action => action.id === "composer.set_text")) break;
      await delay(100);
    } while (performance.now() - uiReadyStarted < uiReadyTimeoutMs);
  }
  for (const action of ["composer.set_text", "composer.send", "session.create_task"]) {
    if (!ui.actions.some(item => item.id === action)) throw new Error(`Real Electron renderer lacks ${action}`);
  }
  const catalog={toolIdentityMapping:catalogs.toolCatalog?.tools.map(tool=>({id:tool.id,qualifiedName:tool.options?.namespace ? `${tool.options.namespace}.${tool.name.replace(/[^a-zA-Z0-9_-]/g,"_")}`:tool.name.replace(/[^a-zA-Z0-9_-]/g,"_")})) ?? [],protocol:protocol.id,skillCount:skillItems.length,skillContentsSha256:sha256(skillCatalogIdentity(skillItems)),toolIDs:tools,toolIDsSha256:sha256(JSON.stringify([...tools].sort())),registeredToolSchemasSha256:catalogs.toolCatalog ? sha256(JSON.stringify(catalogs.toolCatalog.tools)):null,pluginInventorySha256:catalogs.plugins ? sha256(JSON.stringify(catalogs.plugins)):null,externalSkills:skillItems.filter(skill=>{const path=skill.location ?? skill.path;return path && !path.startsWith(resolve(profile,"..")) && path!=="<built-in>";}).map(skill=>({name:skill.name,location:skill.location ?? skill.path}))};
  if (protocol.id === "native-v2") catalog.nativeModelCatalog = await observeNativeModelCatalog(driver, connection.workspace.path);
  await privateWrite(join(evidence,"catalog.json"),{catalog,skills:skillItems,...catalogs});
  if (environment) {
    const identity = await environment.identity({ evidence, expectedBase, controllerGit: { head, originDev: dev, branch: git("branch", "--show-current"), trackedDiffSha256: sha256(diff) } });
    verifyPackagedRendererIdentity(identity);
    if (identity.runtime.platform !== "linux" || !identity.build?.serverTreeSha256 || !identity.build?.appTreeSha256 || !identity.git?.head || !identity.isolation?.receiptSha256) throw new Error("Remote preflight requires actual packaged guest source/build/renderer and isolation evidence");
    await privateWrite(join(evidence, "build-manifest.json"), identity);
    const record = { kind: "real-electron-real-engine-preflight", timestamp: new Date().toISOString(), ...identity, catalog, engineHealth: health, pendingInteractionCounts: { permissions: pendingInteractions.permissions.length, forms: pendingInteractions.forms.length, host: pendingInteractions.host.length }, providerIDs: (catalogs.providers.all ?? catalogs.providers.data)?.map(provider => provider.id), activeProviderIDs: catalogs.providers.connected ?? catalogs.providers.data?.map(provider => provider.id) ?? null, ui: { version: ui.version, route: ui.route, actionIDs: ui.actions.map(action => action.id) }, readiness: { uiReadyTimeoutMs, uiReadinessPollMs: 100, reason: "Renderer startup only; no agent deadline." }, paidCalls: 0 };
    await privateWrite(join(evidence, "preflight.json"), record);
    return { connection, driver, record, protocol };
  }
  const appDist=join(repo,"apps/app/dist");
  const appDistPresent=await stat(appDist).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error;});
  const [serverTree, desktopTree,sidecarTree,appTree,appSource,serverSource,typeSource,harnessSource] = await Promise.all([fingerprintTree(join(repo,"apps/server/dist")),fingerprintTree(join(repo,"apps/desktop/electron")),fingerprintTree(join(repo,"apps/desktop/resources/sidecars")),appDistPresent ? fingerprintTree(appDist):null,fingerprintTree(join(repo,"apps/app/src")),fingerprintTree(join(repo,"apps/server/src")),fingerprintTree(join(repo,"packages/types/src")),fingerprintTree(fileURLToPath(new URL(".",import.meta.url)))]);
  const renderer={kind:"vite-source",sourceSha256:appSource.sha256,unusedCompiledArtifactPresent:appDistPresent,note:"The benchmark launcher serves the actual renderer source through Vite; app/dist is optional and is not served by this launch."};
  await privateWrite(join(evidence,"build-manifest.json"),{server:serverTree,desktop:desktopTree,sidecars:sidecarTree,app:appTree,renderer,source:{app:appSource,server:serverSource,types:typeSource,harness:harnessSource}});
  const record = { kind: "real-electron-real-engine-preflight", timestamp: new Date().toISOString(), git: { head, originDev: dev, branch: git("branch", "--show-current"), trackedDiffSha256: sha256(diff), status: git("status", "--short") }, runtime: { node: process.version, platform: process.platform, arch: process.arch, transport: "local-opencode-http-server",renderer,engineProtocol:protocol.id,protocolLimitations:protocol.limitations }, constants: await readJson(join(repo, "constants.json")), build: { serverTreeSha256: serverTree.sha256, desktopTreeSha256: desktopTree.sha256,sidecarTreeSha256:sidecarTree.sha256,appTreeSha256:appTree?.sha256 ?? null,sourceSha256:{app:appSource.sha256,server:serverSource.sha256,types:typeSource.sha256,harness:harnessSource.sha256} }, catalog, engineHealth: health, pendingInteractionCounts: {permissions:pendingInteractions.permissions.length,forms:pendingInteractions.forms.length,host:pendingInteractions.host.length}, providerIDs:(catalogs.providers.all ?? catalogs.providers.data)?.map(provider=>provider.id), activeProviderIDs:catalogs.providers.connected ?? catalogs.providers.data?.map(provider=>provider.id) ?? null, ui: { version: ui.version, route: ui.route, actionIDs: ui.actions.map(action => action.id) }, readiness: { uiReadyTimeoutMs, uiReadinessPollMs: 100, reason: "Only bounds waiting for a renderer to mount before inference; does not cancel or constrain agent tasks." }, paidCalls: 0 };
  await privateWrite(join(evidence, "preflight.json"), record);
  return { connection, driver, record,protocol };
}

export async function runSuite({ suite, repo, profile, workspace, evidence, expectedBase, capture, settings, environment }) {
  const runStartedAt = new Date().toISOString();
  const runStarted = performance.now();
  if (!(settings.pollIntervalMs > 0)) throw new Error("An explicit positive pollIntervalMs is required");
  if (settings.taskTimeoutMs !== null && !(settings.taskTimeoutMs > 0)) throw new Error("taskTimeoutMs must be positive or null (no task deadline)");
  const { connection, driver, record,protocol } = await preflight({ repo, profile, workspace, evidence, expectedBase, uiReadyTimeoutMs: settings.uiReadyTimeoutMs, environment });
  const captureHealth = await fetch(`${capture.baseURL}/health`, { headers: { authorization: `Bearer ${capture.localToken}` } }).then(response => response.json());
  if (!captureHealth.ok || captureHealth.bodyMutation !== false || captureHealth.outputCaps !== false) throw new Error("A transparent capture proxy must be live before paid runs");
  const budget = captureHealth.budgetEvidence;
  await verifyPaidRunBudget(captureHealth, suite);
  if (!suite.model?.providerID || !suite.model?.modelID || !suite.model?.backendModel) throw new Error("Pin the real provider/model/variant and expected backendModel in the suite before paid inference");
  const interactionMode=suite.interactionPolicy?.mode;
  if (suite.interactionPolicy && (!["autonomous","scripted-external-directory-decline"].includes(interactionMode) || !Array.isArray(suite.interactionPolicy.expectedPermissions) || suite.interactionPolicy.expectedPermissions.length || !Array.isArray(suite.interactionPolicy.expectedForms) || suite.interactionPolicy.expectedForms.length)) throw new Error("An explicit empty initial-interaction set and supported declared scenario policy are required");
  if(interactionMode==="scripted-external-directory-decline" && (suite.interactionPolicy.outsideTaskFolder!=="reject" || suite.interactionPolicy.otherRequests!=="hold" || !environment?.declineExternalPermission))throw new Error("The declared outside-task-folder UI rejection policy must be explicit and operational");
  if(interactionMode && Object.values(record.pendingInteractionCounts).some(count=>count>0))throw new Error("Existing scoped permissions/forms/host approvals require review before starting a paid scenario");
  if (!Array.isArray(record.activeProviderIDs) || record.activeProviderIDs.some(id => id !== suite.model.providerID)) throw new Error("The paid isolated profile has an unknown or additional active provider that could bypass the capture/budget route. Resolve test-profile routing before inference; production capabilities are unchanged.");
  if (record.catalog.externalSkills.length && suite.catalogPolicy !== "record-and-lock-observed") throw new Error("The actual engine discovers external host skills. Explicitly approve/pin the observed catalog for a faithful baseline or provide a hermetic OS environment; discovery is not silently disabled.");
  if (environment) await environment.assertModelAdmission(record, { suite });
  const result = { kind: "real-electron-real-engine-regression", startedAt: runStartedAt, preflightElapsedMs: performance.now() - runStarted, preflight: record, identity: { suiteSha256: sha256(JSON.stringify(suite)), model: suite.model }, suite: suite.id, settings, budget, comparisonPolicy:suite.comparisonPolicy, coverage: suite.coverage, evidenceComplete: false, items: [] };
  const runId = randomUUID();
  const ownedSessions=new Set();
  result.runId = runId;
  const providerTrace = async () => {
    const response = await fetch(`${capture.baseURL}/traces`, { headers: { authorization: `Bearer ${capture.localToken}` } });
    if (!response.ok) throw new Error("Provider trace catalog unavailable");
    return response.json();
  };
  const previousTraces = new Set((await providerTrace()).items.map(trace => trace.id));
  await privateWrite(join(evidence, "suite.json"), suite);
  await privateWrite(join(evidence, "result.json"), result);
  const controller = new AbortController();
  const events = await captureEvents(connection, evidence, controller,protocol);
  async function verifyCatalog(stage) {
    const items=await protocol.skills();
    const hash=sha256(skillCatalogIdentity(items));
    const catalogs=await protocol.catalogs();
    const registeredToolSchemasSha256=catalogs.toolCatalog ? sha256(JSON.stringify(catalogs.toolCatalog.tools)):null;
    const pluginInventorySha256=catalogs.plugins ? sha256(JSON.stringify(catalogs.plugins)):null;
    await privateWrite(join(evidence,`catalog-${stage}.json`),{hash,skills:items,registeredToolSchemasSha256,pluginInventorySha256,...catalogs});
    if(hash!==record.catalog.skillContentsSha256 || registeredToolSchemasSha256!==record.catalog.registeredToolSchemasSha256 || pluginInventorySha256!==record.catalog.pluginInventorySha256)throw new Error("Observed skill/tool/plugin catalog changed during the benchmark; new paid tasks stopped and results are not comparable");
  }
  try {
    for (const task of suite.tasks) {
      events.check();
      await verifyCatalog(`before-${task.id}`);
      const started = performance.now();
      const taskRelativePath = `benchmark-runs/${runId}/${task.id}`;
      const directory = inside(workspace, taskRelativePath);
      const executionDirectory = inside(connection.workspace.path, taskRelativePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const [path, text] of Object.entries(task.files ?? {})) await privateWrite(inside(directory, path), text);
      for (const [path, paragraphs] of Object.entries(task.wordFiles ?? {})) await privateWrite(inside(directory, path), makeWordFixture(paragraphs));
      for (const fixture of task.copyFiles ?? []) await cp(fixture.from, inside(directory, fixture.to), { recursive: true, errorOnExist: true, force: false });
      const itemEvidence = inside(evidence, task.id);
      await mkdir(itemEvidence, { recursive: true, mode: 0o700 });
      const item = { id: task.id, identity: { definitionSha256: sha256(JSON.stringify(task)), model: suite.model }, ...(task.evaluation ? { evaluation: task.evaluation } : {}), status: "running", assertions: [], directory: executionDirectory, ...(environment ? { controllerDirectory: directory } : {}), startedAt: new Date().toISOString() };
      result.items.push(item);
      try {
        if (task.browserFixture) {
          if (typeof environment?.browserRegisterRequests !== "function" || typeof environment?.browserDownloads !== "function") throw new Error("Browser tasks require live controller-only fixture and actual download-byte collectors before any inference");
          const before = await environment.browserRegisterRequests({ task, stage: "before", runId });
          if (typeof before?.instanceID !== "string" || !before.instanceID || !Array.isArray(before.requests)
            || before.requests.some(request => typeof request.id !== "string" || request.fixtureInstanceID !== before.instanceID)
            || new Set(before.requests.map(request => request.id)).size !== before.requests.length) throw new Error("Browser fixture request/arm identity is incomplete");
          item.browserFixture = { url: task.browserFixture.url, instanceID: before.instanceID, requestIDsBefore: before.requests.map(request => request.id) };
        }
        if (environment) item.staging = await environment.files.stageTask(directory, taskRelativePath, join(itemEvidence, "remote-source"));
        const previousSession=/\/session\/([^/?#]+)/.exec((await driver.snapshot()).route)?.[1];
        const createStarted=performance.now();
        await driver.action("session.create_task");
        let createdSession;
        do {
          createdSession=/\/session\/([^/?#]+)/.exec((await driver.snapshot()).route)?.[1];
          if(createdSession && createdSession!==previousSession)break;
          if(performance.now()-createStarted>=(settings.uiReadyTimeoutMs??30000))throw new Error("Real new task route did not appear before the explicit UI readiness watchdog; no inference was attempted");
          await delay(100);
        }while(true);
        item.creation={previousSessionID:previousSession ?? null,sessionID:createdSession,elapsedMs:performance.now()-createStarted};
        ownedSessions.add(createdSession);
        if (connection.focus?.kind === "normal-ui-control") item.emptyCreatedTaskHistory = assertEmptyCreatedTaskHistory(await protocol.messages(createdSession), createdSession);
        while(!(await driver.snapshot()).actions.some(action=>action.id==="composer.set_text")) {
          if(performance.now()-createStarted>=(settings.uiReadyTimeoutMs??30000))throw new Error("New task's actual composer did not mount before document preparation; no inference was attempted");
          await delay(100);
        }
        const substitute = value => JSON.parse(JSON.stringify(value).replaceAll("{{TASK_PATH}}", taskRelativePath).replaceAll("{{SESSION_ID}}", createdSession ?? ""));
        for (const step of task.beforePrompt ?? []) await driver.action(step.actionId, substitute(step.args));
        await driver.focusChat(createdSession);
        await delay(100);
        let promptUI=await driver.snapshot();
        assertTaskSession(promptUI,createdSession,"before setting composer text");
        if(!promptUI.actions.some(action=>action.id==="composer.set_text") && createdSession) {
          const focusStarted=performance.now();
          while(!promptUI.actions.some(action=>action.id==="composer.set_text")) {
            if(performance.now()-focusStarted>=(settings.uiReadyTimeoutMs??30000))throw new Error("Real composer did not become available after focusing its actual chat tab");
            // A document-open navigation can reconcile after its action
            // returns. Repeat only this idempotent UI focus, retaining every
            // attempt; no model prompt or permission response is retried.
            await driver.focusChat(createdSession);
            await delay(100);promptUI=await driver.snapshot();
          }
        }
        const prompt = `Use the task folder ${executionDirectory} for this task's inputs and deliverables.\n\n${task.prompt}`;
        await privateWrite(join(itemEvidence, "prompt.txt"), prompt);
        await driver.action("composer.set_text", { text: prompt });
        const sendReadyStarted = performance.now();
        while (true) {
          await driver.focusChat(createdSession);
          await delay(100);
          const state = await driver.snapshot();
          assertTaskSession(state,createdSession,"while waiting for this composer Send");
          if (state.actions.some(action => action.id === "composer.send" && !action.disabled)) break;
          if (performance.now() - sendReadyStarted >= (settings.uiReadyTimeoutMs ?? 30000)) throw new Error("The real composer Send action stayed disabled before inference; verify the visible selected model/provider and app readiness");
          // The product's global focusPrompt event can focus another cached
          // composer while set_text completes. Restore only this exact chat
          // when its actions leave scope; never override an actually disabled
          // Send action or bypass the normal composer.
          if(!state.actions.some(action=>action.id==="composer.send"))await driver.focusChat(createdSession);
          await delay(100);
        }
        item.inputs=await snapshotTaskInputs(directory,itemEvidence);
        if (environment) {
          item.prePromptSourceReceipt = await environment.files.verifyTask(await fingerprintTree(join(itemEvidence,"inputs")), taskRelativePath, join(itemEvidence, "remote-source"));
          if(item.prePromptSourceReceipt.localTreeSha256!==item.inputs.sha256)throw new Error("Immutable controller snapshot does not match exact guest pre-prompt source receipt");
        }
        if(environment?.skillInstallations)item.skillSourcesBeforeAdmission=await environment.skillInstallations();
        if(environment?.toolExecutions){try{item.toolTraceBeforeAdmission=await environment.toolExecutions({ownedSessionIDs:[createdSession]});if(!item.toolTraceBeforeAdmission.complete)throw new Error("Existing unmatched observer calls require review before a new paid task");}catch(error){item.traceFailure=true;throw error;}}
        if (protocol.id === "native-v2") {
          item.nativeModelCatalogBeforeAdmission = await observeNativeModelCatalog(driver, connection.workspace.path);
          item.nativeModelCatalogAdmissionIdentity = assertNativeModelCatalogUnchanged(record.catalog.nativeModelCatalog, item.nativeModelCatalogBeforeAdmission, suite.model);
          await privateWrite(join(itemEvidence,"native-model-catalog-before-send.json"),item.nativeModelCatalogBeforeAdmission);
        }
        item.selectedModelBeforeAdmission=selectedModelEvidence(await protocol.session(createdSession),suite.model,
          {protocol:protocol.id,nativeCatalog:item.nativeModelCatalogBeforeAdmission});
        if(environment)await environment.assertModelAdmission(record, { suite, taskID: task.id });
        if (task.browserFixture) {
          const admitted = await environment.browserRegisterRequests({ task, stage: "admit", runId });
          const prior = new Set(item.browserFixture.requestIDsBefore);
          if (admitted?.instanceID !== item.browserFixture.instanceID || !Array.isArray(admitted.requests)
            || admitted.requests.some(request => typeof request.id !== "string" || request.fixtureInstanceID !== admitted.instanceID)
            || new Set(admitted.requests.map(request => request.id)).size !== admitted.requests.length
            || [...prior].some(id => !admitted.requests.some(request => request.id === id))) throw new Error("Browser route/arm evidence changed before actual composer Send");
          item.browserFixture.initialRequestIDsBefore = item.browserFixture.requestIDsBefore;
          item.browserFixture.requestIDsBefore = admitted.requests.map(request => request.id);
          await privateWrite(join(itemEvidence, "browser-fixture-before-send.json"), { ...item.browserFixture, requests: admitted.requests });
        }
        assertTaskSession(await driver.snapshot(),createdSession,"immediately before actual composer Send");
        item.preparationMs=performance.now()-started;
        const agentStarted=performance.now();
        item.agentStartedAt=new Date().toISOString();
        await driver.action("composer.send");
        const ui = await driver.snapshot();
        const sessionID = /\/session\/([^/?#]+)/.exec(ui.route)?.[1];
        if (!sessionID || decodeURIComponent(sessionID)!==createdSession) {
          item.scopeFailure={expectedSessionID:createdSession,actualRoute:ui.route,afterSend:true};
          const actualID=sessionID ? decodeURIComponent(sessionID):null;
          for(const ownedID of new Set([createdSession,...(ownedSessions.has(actualID)?[actualID]:[])])) {
            try { await protocol.stop(ownedID); } catch(error) { (item.scopeStopErrors??=[]).push({sessionID:ownedID,error:String(error)}); }
          }
          throw new Error("Post-send UI session differs from exact created task; only known owned work was stopped, no other chat was used as evidence");
        }
        item.sessionID = createdSession;
        async function stopOwnedTaskTree(reason) {
          const ids=await sessionTreeIDs(protocol,item.sessionID);
          const stops=[];
          for(const ownedID of ids) {
            try { await protocol.stop(ownedID); stops.push({sessionID:ownedID,requested:true}); }
            catch(error) { stops.push({sessionID:ownedID,error:String(error)}); }
          }
          await privateWrite(join(itemEvidence,`owned-stop-${reason}.json`),{rootSessionID:item.sessionID,reason,stops});
          if(stops.some(item=>item.error))throw new Error("Some exact owned task sessions could not be stopped; full stop evidence retained");
        }
        async function holdUnexpectedInteraction() {
          if(item.intervention)return true;
          if(!interactionMode)return false;
          const ownedIDs=[...await sessionTreeIDs(protocol,item.sessionID)];
          const interactions=await observeSessionInteractions(protocol,ownedIDs);
          await privateWrite(join(itemEvidence,"pending-interactions.json"),interactions);
          if(!interactions.permissions.length && !interactions.forms.length && !interactions.host.length)return false;
          if(interactionMode==="scripted-external-directory-decline" && interactions.permissions.length===1 && !interactions.forms.length && !interactions.host.length) {
            const request=interactions.permissions[0];
            const decision=externalDirectoryDecision(request,{ownedSessionIDs:ownedIDs,taskDirectory:executionDirectory});
            if(decision.decision==="reject") {
              try {
                const response=await environment.declineExternalPermission({driver,protocol,events,request,ownedSessionIDs:ownedIDs,rootSessionID:item.sessionID,taskDirectory:executionDirectory,evidence:itemEvidence});
                (item.permissionDecisions??=[]).push(response);
                await privateWrite(join(itemEvidence,"permission-decisions.json"),item.permissionDecisions);
                return false;
              } catch(error) {item.permissionUiError=String(error);}
            }
          }
          item.status="intervention-required";
          item.intervention={timestamp:new Date().toISOString(),...interactions,action:"stop-owned-session",policy:interactionMode,note:"No additional permission or form response was sent after this hold. Any earlier scripted UI denials are recorded separately; the scenario is held for review."};
          await privateWrite(join(itemEvidence,"intervention.json"),item.intervention);
          await stopOwnedTaskTree("unexpected-interaction");
          return true;
        }
        let entries = [];
        while (true) {
          events.check();
          entries = await protocol.messages(item.sessionID);
          await privateWrite(join(itemEvidence, "messages.json"), entries);
          const activity = await observeSessionActivity(protocol,[item.sessionID]);
          await privateWrite(join(itemEvidence,"execution-state.json"),activity);
          if(await holdUnexpectedInteraction())break;
          const assistants=entries.filter(protocol.isAssistant);
          const last=assistants.length ? protocol.info(assistants.at(-1)):null;
          const busy=activity.unsettledSessionIDs.length>0;
          if (!busy && last && (last.error || last.time?.completed)) break;
          if (settings.taskTimeoutMs !== null && performance.now() - started >= settings.taskTimeoutMs) {
            await stopOwnedTaskTree("task-watchdog");
            item.status = "harness-timeout";
            break;
          }
          await delay(settings.pollIntervalMs);
        }
        item.session=await protocol.session(item.sessionID);
        item.engineProtocol=protocol.id;
        item.summary = summarizeMessages(entries);
        const children = [];
        const sessionTree = [{ requestedParentID: null, session: item.session }];
        const visited = new Set([item.sessionID]);
        async function collectChildren(parentID) {
          for (const child of await protocol.sessions(parentID)) {
            if (visited.has(child.id)) continue;
            visited.add(child.id);
            sessionTree.push({ requestedParentID: parentID, session: child });
            const messages=await protocol.messages(child.id);
            await privateWrite(join(itemEvidence, "children", `${child.id}.json`), { session: child, messages });
            children.push(...messages);
            await collectChildren(child.id);
          }
        }
        await collectChildren(item.sessionID);
        let subtreeActivity=await observeSessionActivity(protocol,visited);
        await privateWrite(join(itemEvidence,"subtree-execution-state.json"),subtreeActivity);
        while(subtreeActivity.unsettledSessionIDs.length>0) {
          if(await holdUnexpectedInteraction())break;
          if(settings.taskTimeoutMs!==null && performance.now()-started>=settings.taskTimeoutMs) {await stopOwnedTaskTree("child-watchdog");throw new Error("Explicit task watchdog expired while waiting for native child sessions; partial evidence retained");}
          await delay(settings.pollIntervalMs);events.check();
          children.length=0;sessionTree.splice(1);visited.clear();visited.add(item.sessionID);await collectChildren(item.sessionID);
          subtreeActivity=await observeSessionActivity(protocol,visited);
          await privateWrite(join(itemEvidence,"subtree-execution-state.json"),subtreeActivity);
        }
        if (task.assertions.some(assertion => assertion.type === "capability.delegation")) {
          let refresh = 0;
          do {
            const snapshot = await refreshDelegationTree(protocol, item.sessionID);
            await privateWrite(join(itemEvidence, "delegation-settlement-refresh", `${String(++refresh).padStart(4, "0")}.json`), snapshot);
            children.splice(0, children.length, ...snapshot.messages.filter(entry => (entry.benchmarkRequestedSessionID ?? entry.info?.sessionID ?? entry.sessionID) !== item.sessionID));
            sessionTree.splice(0, sessionTree.length, ...snapshot.sessionTree);
            visited.clear(); for (const id of snapshot.ownedSessionIDs) visited.add(id);
            item.session = sessionTree[0].session;
            subtreeActivity = snapshot.activity;
            if (!subtreeActivity.unsettledSessionIDs.length || await holdUnexpectedInteraction()) break;
            if (settings.taskTimeoutMs !== null && performance.now() - started >= settings.taskTimeoutMs) {
              await stopOwnedTaskTree("child-watchdog"); throw new Error("Explicit task watchdog expired during delegation settlement refresh");
            }
            await delay(settings.pollIntervalMs); events.check();
          } while (true);
        }
        entries=await protocol.messages(item.sessionID);
        await privateWrite(join(itemEvidence,"messages.json"),entries);
        item.summary=summarizeMessages(entries);
        item.subtreeSummary = summarizeMessages([...entries, ...children]);
        item.descendantSessionIDs=[...visited].filter(id=>id!==item.sessionID);
        if (protocol.id === "native-v2") {
          item.nativeModelCatalogAfterExecution = await observeNativeModelCatalog(driver, connection.workspace.path);
          item.nativeModelCatalogTerminalIdentity = assertNativeModelCatalogUnchanged(item.nativeModelCatalogBeforeAdmission, item.nativeModelCatalogAfterExecution, suite.model);
          await privateWrite(join(itemEvidence,"native-model-catalog-after-execution.json"),item.nativeModelCatalogAfterExecution);
        }
        item.primaryMessageIntegrity=primaryMessageIntegrity(item.summary.assistantMessages,suite.model,
          {protocol:protocol.id,nativeCatalog:item.nativeModelCatalogAfterExecution});
        if (item.primaryMessageIntegrity.invalid.length) throw new Error("Real primary messages used a different model/provider/available variant than the pinned suite; result is not comparable");
        item.agentElapsedMs=performance.now()-agentStarted;
        item.ui = await driver.snapshot();
        const outcomeDirectory=environment ? join(itemEvidence,"guest-task-mirror") : directory;
        if (environment) {
          const collectStarted=performance.now();
          item.collection=await environment.files.collectTask(taskRelativePath,outcomeDirectory,join(itemEvidence,"remote-results"));
          item.collectionMs=performance.now()-collectStarted;
        }
        if(environment?.toolExecutions){try{item.toolTraceAfterExecution=await environment.toolExecutions({ownedSessionIDs:[...visited]});item.toolTraceCoverage=toolExecutionCoverage(item.subtreeSummary,item.toolTraceAfterExecution.records,[...visited],record.catalog.toolIdentityMapping);item.toolTraceCompleteness=reconcileToolTrace(item.toolTraceAfterExecution,item.toolTraceCoverage);if(!item.toolTraceCompleteness.completeAsExposed)item.traceFailure=true;}catch(error){item.traceFailure=true;throw error;}}
        if(environment?.skillInstallations)item.skillSourcesAfterExecution=await environment.skillInstallations();
        if (task.browserFixture) {
          try {
            const after = await environment.browserRegisterRequests({ task, stage: "after", runId, ownedSessionIDs: [...visited] });
            const prior = new Set(item.browserFixture.requestIDsBefore);
            if (after?.instanceID !== item.browserFixture.instanceID || !Array.isArray(after.requests)
              || after.requests.some(request => typeof request.id !== "string" || request.fixtureInstanceID !== after.instanceID)
              || new Set(after.requests.map(request => request.id)).size !== after.requests.length
              || [...prior].some(id => !after.requests.some(request => request.id === id))) throw new Error("Browser fixture trace lost, duplicated or crossed arm identities");
            item.browserFixture.requests = after.requests.filter(request => !prior.has(request.id));
            await privateWrite(join(itemEvidence, "browser-fixture-requests.json"), item.browserFixture);
          } catch (error) { item.traceFailure = true; throw error; }
        }
        const assertionContext = { workspace: connection.workspace.path, workspaceID: connection.workspace.id, executionDirectory,
          engineProtocol: protocol.id, rootSessionID: item.sessionID, sessionTree, subtreeActivity,
          toolTraceCompleteness: item.toolTraceCompleteness,
          ownedSessionIDs: [...visited], toolExecutions: item.toolTraceAfterExecution?.records.filter(record => record.phase === "after" && visited.has(record.sessionID)),
          toolIdentityMapping: record.catalog.toolIdentityMapping, skillInstallations: item.skillSourcesAfterExecution?.fixtures,
          browserRegisterRequests: item.browserFixture?.requests, browserFixtureInstanceID: item.browserFixture?.instanceID, subtreeMessages: [...entries, ...children] };
        if (task.browserFixture) {
          try {
            const candidates = new Map();
            for (const assertion of task.assertions.filter(assertion => assertion.type === "capability.browser_register")) {
              const proposed = evaluateBrowserRegisterExecution(assertion, item.subtreeSummary, assertionContext).evidence.completedOwnedDownloads ?? [];
              for (const candidate of proposed) candidates.set(browserDownloadKey(candidate), candidate);
            }
            item.browserDownloadReceipts = await environment.browserDownloads({ task, candidates: [...candidates.values()], evidence: join(itemEvidence, "actual-browser-downloads") });
            if (!Array.isArray(item.browserDownloadReceipts)) throw new Error("Actual browser download collection did not return receipts");
            assertionContext.browserDownloadReceipts = item.browserDownloadReceipts;
          } catch (error) { item.traceFailure = true; throw error; }
        }
        item.assertions = await evaluateAssertions(task.assertions, outcomeDirectory, entries, item.ui, assertionContext);
        for (const artifact of task.artifacts ?? []) {
          try {
            const source = inside(outcomeDirectory, artifact);
            const bytes = await readFile(source);
            await privateWrite(inside(itemEvidence, `artifacts/${artifact}`), bytes);
            try { await privateWrite(inside(itemEvidence, `extracted/${artifact}.json`), await extractFullArtifact(source)); }
            catch (error) { item.extractionLimitations ??= []; item.extractionLimitations.push({ artifact, error: String(error) }); }
          }
          catch (error) { item.artifactErrors ??= []; item.artifactErrors.push({ artifact, error: String(error) }); }
        }
        item.status = ["harness-timeout", "intervention-required"].includes(item.status) ? item.status : item.traceFailure ? "trace-incomplete":item.artifactErrors?.length ? "artifact-missing" : "completed";
      } catch (error) {
        item.status = "failed"; item.error = String(error);
        if (environment && item.staging && !item.collection) {
          try { item.partialCollection=await environment.files.collectTask(taskRelativePath,join(itemEvidence,"partial-guest-task-mirror"),join(itemEvidence,"partial-remote-results")); }
          catch (collectionError) { item.partialCollectionError=String(collectionError); }
        }
      }
      item.elapsedMs = performance.now() - started;
      await privateWrite(join(itemEvidence, "result.json"), item);
      await privateWrite(join(evidence, "result.json"), result);
      await verifyCatalog(`after-${task.id}`);
      if (item.intervention || item.scopeFailure || item.traceFailure) {
        result.halted = { reason: item.traceFailure ? "incomplete-authoritative-tool-traces":item.scopeFailure ? "exact-task-session-scope-failure":"unexpected-interaction-in-autonomous-scenario", taskID: task.id, notRun: suite.tasks.slice(result.items.length).map(task => task.id) };
        break;
      }
      // A broken transport or assertion is evidence; do not silently rerun or inject recovery prompts.
    }
    events.check();
    await verifyCatalog("completed");
    result.providerTraces = (await providerTrace()).items.filter(trace => !previousTraces.has(trace.id));
    if (!result.providerTraces.length || result.providerTraces.some(trace => !["completed", "cancelled"].includes(trace.status))) throw new Error("Provider trace coverage is missing or incomplete");
    result.wireIntegrity=providerWireIntegrity(result.providerTraces,suite.model,result.items.map(item=>item.sessionID).filter(Boolean),result.items.flatMap(item=>item.descendantSessionIDs??[]));
    result.backendIntegrity={expected:suite.model.backendModel,invalid:result.wireIntegrity.requests.filter(request=>!request.backendKnown),primaryMismatch:result.wireIntegrity.wrongPrimary};
    result.controlledPerformance={state:result.wireIntegrity.controlledPerformanceState,requests:result.wireIntegrity.requests,auxiliaryChoices:"Normal child/title/aux choices retained; missing role attribution keeps controlled performance inconclusive even when every captured wire has the expected main model/settings. Legal outcomes remain separate."};
    result.providerTotals = { requests: result.providerTraces.length, missingUsageRequests: result.providerTraces.filter(trace => !trace.usage?.raw).map(trace => trace.id), ...Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "reasoning"].map(field => [field, result.providerTraces.every(trace => typeof trace.usage?.[field] === "number") ? result.providerTraces.reduce((sum, trace) => sum + trace.usage[field], 0) : null])), gatewayReportedCostEur: result.providerTraces.every(trace => trace.gatewayReportedCostEur !== null) ? result.providerTraces.reduce((sum, trace) => sum + trace.gatewayReportedCostEur, 0) : null, note: "Provider input/output counts retain their native semantics; cache/reasoning categories are separate and must not be added twice. Missing fields remain null." };
    if (!result.wireIntegrity.mainModelSettingsConsistent)result.validity="inconclusive-primary-model-or-wire-attribution";
    else if(!result.wireIntegrity.roleAttributionComplete)result.validity="legal-outcome-evaluable-performance-unattributed";
    result.evidenceComplete = !environment || result.items.every(item=>item.toolTraceCompleteness?.completeAsExposed===true&&!item.traceFailure);
    result.toolTraceAvailability = {contractVersion:2,completeAsExposed:result.evidenceComplete,fullRawReturnCoverage:!environment ? null:result.items.every(item=>item.toolTraceCompleteness?.fullRawReturnCoverage===true),unavailableFailureReturns:result.items.flatMap(item=>item.toolTraceCoverage?.unavailableFailureReturns??[]),note:"Complete-as-exposed lifecycle/error evidence is distinct from all raw returned values. Existing historical receipts are not reinterpreted."};
    result.interactionScenario={mode:interactionMode??"undeclared",scriptedDenials:result.items.reduce((sum,item)=>sum+(item.permissionDecisions?.length??0),0),observedPermissionWaitMs:result.items.flatMap(item=>item.permissionDecisions??[]).reduce((sum,reply)=>sum+reply.requestToReplyObservedMs,0),autonomousSuccess:interactionMode==="autonomous" ? result.items.every(item=>item.status==="completed"&&!item.intervention):null,note:"Scripted UI rejection is a separate permission scenario and never counted as autonomous success. Permission wait is included in task wall time and also reported separately."};
  } finally {
    controller.abort();
    await events.done;
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = performance.now() - runStarted;
    result.timingScope = "Full runSuite invocation including preflight, staging, model execution, collection, and event-stream cleanup. Per-item send-to-terminal time and setup/collection remain separate.";
    result.qualityOutcomesPassed=result.items.length===suite.tasks.length && result.items.every(item=>item.status==="completed" && item.assertions.length>0 && item.assertions.every(assertion=>assertion.passed));
    result.passed = result.evidenceComplete && result.qualityOutcomesPassed && result.wireIntegrity?.mainModelSettingsConsistent===true;
    await privateWrite(join(evidence, "result.json"), result);
  }
  return result;
}
