import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { createManagedOpencodeServer } from "../managed-opencode.js";
import { startServer } from "../server.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ensureWikiAgentToken } from "../wiki/agent-access.js";
import { ReviewExecutor } from "./executor.js";
import { ReviewColumnSchema, SavedReviewSchema } from "./schema.js";
import { REVIEW_SUBMIT_TOOL } from "./worker-identity.js";

type Transport = { method: string; path: string; status: number; raw: string; authorization: string | null; scoped: boolean; afterSubmission: boolean };
const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("real server grants only active native review workers, validates submissions and revokes before cleanup", async () => {
  if (!binary) throw new Error("An isolated released engine is required.");
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-review-"));
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: join(root, "matter"), preset: "starter", workspaceType: "local" };
  const other: WorkspaceInfo = { id: "other", name: "Other", path: join(root, "other"), preset: "starter", workspaceType: "local" };
  for (const folder of [workspace.path, other.path, ...["home", "config", "data", "cache", "state", "plugins"].map(name => join(root, name))]) await mkdir(folder, { recursive: true });
  const previous = { ...process.env };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  process.env.LEGALWORK_DATA_DIR = join(root, "legalwork-data");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace, other], authorizedRoots: [workspace.path, other.path], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const serverUrl = () => { if (!server) throw new Error("Real server is not started."); return `http://127.0.0.1:${server.port}`; };
  const transports: Transport[] = [], requests: unknown[] = [];
  const wrongTools: { status: number; code: string }[] = [];
  const submitted = new Set<string>();
  const workerReady = Promise.withResolvers<{ sessionID: string; claimID: string }>();
  const modelRelease = Promise.withResolvers<void>();
  const cleanupReady = Promise.withResolvers<string>();
  const cleanupRelease = Promise.withResolvers<void>();
  let cleanupTarget = "", holdCleanup = true, phase: "route" | "citation" = "route", primaryCalls = 0, citationCalls = 0, officeReads = 0;
  // These proxies observe full traffic but never handle worker routes or grant
  // authority. Request identity encoding avoids forwarding Bun's decoded bytes
  // with an upstream compression header. The real services execute each call.
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), match = /^\/workspace\/matter\/reviews\/workers\/([^/]+)\/(contract|submit)$/.exec(url.pathname);
    if (url.pathname.endsWith("/office-tools/status")) officeReads++;
    const afterSubmission = match ? submitted.has(match[1]!) : false;
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    if (match?.[2] === "submit" && body) {
      // Use the actual executing native assistant identity, which does not
      // exist while the provider request is held before its response stream.
      const input = z.object({ value: z.json(), messageID: z.string(), toolID: z.string() }).parse(JSON.parse(Buffer.from(body).toString()));
      const denied = await fetch(`${serverUrl()}${url.pathname}`, { method: "POST", headers: { ...Object.fromEntries(request.headers), "accept-encoding": "identity" }, body: JSON.stringify({ ...input, toolID: "forged-tool" }) });
      wrongTools.push({ status: denied.status, code: z.object({ code: z.string() }).parse(await denied.json()).code });
    }
    const response = await fetch(`${serverUrl()}${url.pathname}${url.search}`, { method: request.method, headers: { ...Object.fromEntries(request.headers), "accept-encoding": "identity" },
      ...(body === undefined ? {} : { body }) });
    const raw = await response.clone().text();
    transports.push({ method: request.method, path: url.pathname, status: response.status, raw, authorization: request.headers.get("authorization"), scoped: request.headers.has("x-legalwork-wiki-agent-token"), afterSubmission });
    if (match?.[2] === "submit" && response.ok) submitted.add(match[1]!);
    return response;
  } });
  const engineProxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!engine) return new Response(null, { status: 503 });
    const url = new URL(request.url);
    if (holdCleanup && cleanupTarget && request.method === "POST" && url.pathname === `/api/session/${cleanupTarget}/interrupt`) {
      holdCleanup = false; cleanupReady.resolve(cleanupTarget); await cleanupRelease.promise;
    }
    return fetch(`${engine.url}${url.pathname}${url.search}`, { method: request.method, headers: { ...Object.fromEntries(request.headers), "accept-encoding": "identity" },
      ...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
  } });
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input: unknown = await request.json(); requests.push(input);
    const tools = z.object({ tools: z.array(z.object({ name: z.string(), parameters: z.json() })).optional() }).parse(input).tools ?? [];
    const primary = tools.some(tool => tool.name === REVIEW_SUBMIT_TOOL);
    const contract = [...transports].reverse().find(item => item.status === 200 && item.path.endsWith("/contract"));
    const sessionID = contract?.path.split("/").at(-2);
    if (primary) {
      primaryCalls++;
      expect(tools.map(tool => tool.name)).toEqual([REVIEW_SUBMIT_TOOL]);
      expect(JSON.stringify(tools[0]!.parameters)).toContain('"assignment"');
      expect(JSON.stringify(input)).not.toContain("Unrelated.docx");
      expect(JSON.stringify(input)).not.toContain("Scheduling");
      expect(z.object({ model: z.string() }).parse(input).model).toBe("fixture");
      if (!contract || !sessionID) throw new Error("Native review model was reached without its real server contract.");
      if (phase === "route" && primaryCalls === 1) {
        workerReady.resolve({ sessionID, claimID: z.object({ id: z.string() }).parse(JSON.parse(contract.raw)).id });
        await modelRelease.promise;
      }
    }
    const invalidQuote = primary && phase === "citation" && ++citationCalls === 1;
    const quote = invalidQuote ? "A fabricated assignment clause." : "Assignment is permitted.";
    const page = phase === "citation" ? 1 : null;
    const answer = { cells: { assignment: { value: "Yes", reason: "The source expressly permits assignment.", quote, page, location: "Assignment", confidence: "high", citations: page ? [{ page, quote, source: "native" }] : [] } } };
    const id = `resp_${requests.length}`;
    const item = primary && sessionID && !submitted.has(sessionID)
      ? { type: "function_call", id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name: REVIEW_SUBMIT_TOOL, arguments: JSON.stringify(answer), status: "completed" }
      : { type: "message", id: `msg_${requests.length}`, role: "assistant", content: [{ type: "output_text", text: "Done" }], status: "completed" };
    const events = [{ type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    server = await startServer(config);
    const scopedToken = await ensureWikiAgentToken(config);
    const entry = join(root, "fixture.ts");
    await writeFile(entry, `import {Plugin} from "@opencode/plugin";import {registerReviewWorker} from ${JSON.stringify(resolve(import.meta.dir, "../opencode-plugins/review-worker.ts"))};import {registerAppStateReminders} from ${JSON.stringify(resolve(import.meta.dir, "../opencode-plugins/native-app-state-reminders.ts"))};import {registerPrimaryContext} from ${JSON.stringify(resolve(import.meta.dir, "../opencode-plugins/native-review-worker.ts"))};export default Plugin.define({id:"legalwork.review.fixture",async setup(ctx){const stop=await registerReviewWorker(ctx);const reminders=await registerAppStateReminders(ctx,{topic:"office",read:async()=>{await fetch("${relay.url.origin}/workspace/matter/office-tools/status",{headers:{authorization:"Bearer fixture"}});return "Unrelated.docx";},cleared:"Closed"});await registerPrimaryContext(ctx,event=>event.system.push({type:"text",text:"Scheduling and unrelated app guidance"}));return()=>{stop();reminders();};}});`);
    const build = await Bun.build({ entrypoints: [entry], outdir: join(root, "plugins"), naming: "index.mjs", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    engine = await createManagedOpencodeServer({ bin: binary, cwd: workspace.path, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      // A real privileged fixture bearer exists, so passing requires the worker
      // plugin to omit it and use only its automatic ephemeral scoped authority.
      LEGALWORK_SERVER_URL: relay.url.origin, LEGALWORK_SERVER_TOKEN: config.token, LEGALWORK_WIKI_AGENT_TOKEN: scopedToken,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [join(root, "plugins")], model: "openai/fixture",
        agents: { "document-extractor": { mode: "subagent", hidden: true, system: "Use only the supplied evidence.", permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: REVIEW_SUBMIT_TOOL, resource: "*", effect: "allow" }] } },
        providers: { openai: { settings: { baseURL: model.url.origin + "/v1", apiKey: "fixture", transport: "http" }, models: { fixture: { modelID: "fixture", name: "Fixture", limit: { context: 128000, output: 4096 }, capabilities: { tools: true } } } } } }),
    } });
    Object.assign(config, { opencodeBaseUrl: engineProxy.url.origin, opencodeUsername: engine.username, opencodePassword: engine.password });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const human = (path: string, method = "GET", body?: unknown) => fetch(`${serverUrl()}/workspace/matter/reviews${path}`, { method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const scoped = (path: string, sessionID: string, directory = workspace.path, method = "GET", body?: unknown) => fetch(`${serverUrl()}${path}`, { method, headers: { "x-legalwork-wiki-agent-token": scopedToken, "x-legalwork-wiki-agent-session": sessionID, "x-legalwork-wiki-agent-directory": encodeURIComponent(directory), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const column = ReviewColumnSchema.parse({ key: "assignment", label: "Assignment", question: "Is assignment permitted?", kind: "yes_no" });
    const settings = { mode: "llm", jev: null, llm: { providerId: "openai", model: "fixture" } };
    await writeFile(join(workspace.path, "assignment.txt"), "Assignment is permitted.");
    expect((await human("/settings", "PUT", settings)).status).toBe(200);
    const createdResponse = await human("", "POST", { requestId: "71953464-c3a7-47a5-ae2a-f28a1b090bea", name: "Authenticated review", files: ["assignment.txt"], columns: [column] });
    expect(createdResponse.status).toBe(200);
    const review = SavedReviewSchema.parse(await createdResponse.json());
    const started = await human(`/${review.id}/start`, "POST", { revision: review.revision });
    if (!started.ok) throw new Error(`Real review start failed: HTTP ${started.status} ${await started.text()}`);
    expect(started.status).toBe(200);
    const worker = await workerReady.promise; cleanupTarget = worker.sessionID;
    const contractPath = `/workspace/matter/reviews/workers/${worker.sessionID}/contract`;
    const submitPath = `/workspace/matter/reviews/workers/${worker.sessionID}/submit`;
    expect((await scoped(contractPath, worker.sessionID)).status).toBe(200);
    const live = await client.session.get({ sessionID: worker.sessionID });
    expect(live).toMatchObject({ agent: "document-extractor", metadata: { legalworkReviewWorker: true, legalworkReviewWorkspaceId: workspace.id, legalworkReviewClaim: worker.claimID }, model: { providerID: "openai", id: "fixture" } });
    // Public human operations cannot turn this internal inference context into
    // a normal chat or establish a general agent-tool origin.
    for (const [method, suffix, body] of [["POST", "/prompt", { text: "Must not re-prompt the worker." }], ["PATCH", "", { title: "Must not promote worker" }]]) {
      const response = await fetch(`${serverUrl()}/workspace/matter/opencode/api/session/${worker.sessionID}${suffix}`, {
        method: z.string().parse(method), headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "session_not_found" });
    }
    expect(primaryCalls).toBe(1);
    for (const [path, method, body] of [["/workspaces", "GET", undefined], ["/wikis", "GET", undefined], ["/workspace/matter/office-tools/execute", "POST", {}], ["/workspace/matter/sandbox/command", "POST", { sessionID: worker.sessionID, command: "printf must-not-run" }], ["/workspace/matter/sandbox/http", "POST", { sessionID: worker.sessionID }]])
      expect((await scoped(z.string().parse(path), worker.sessionID, workspace.path, z.string().parse(method), body)).status).toBe(403);
    expect((await scoped(contractPath, worker.sessionID, other.path)).status).toBe(403);
    expect((await scoped(contractPath.replace("/matter/", "/other/"), worker.sessionID)).status).toBe(403);
    for (const [path, method] of [[contractPath, "GET"], [submitPath, "POST"]])
      expect((await fetch(`${serverUrl()}${path}`, { method, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })).status).toBe(403);
    const forged = await client.session.create({ agent: "document-extractor", location: { directory: workspace.path }, metadata: { ...live.metadata } });
    const child = await client.session.create({ parentID: worker.sessionID, agent: "document-extractor", metadata: { ...live.metadata } });
    expect((await scoped(contractPath.replace(worker.sessionID, forged.id), forged.id)).status).toBe(403);
    expect((await scoped(contractPath.replace(worker.sessionID, child.id), child.id)).status).toBe(403);
    expect((await scoped("/wikis", child.id)).status).toBe(403);
    await client.session.update({ sessionID: worker.sessionID, metadata: { ...live.metadata, legalworkReviewClaim: "forged-claim" } });
    const forgedClaim = await scoped(contractPath, worker.sessionID);
    expect(forgedClaim.status).toBe(404);
    expect(await forgedClaim.json()).toMatchObject({ code: "review_worker_not_found" });
    await client.session.update({ sessionID: worker.sessionID, metadata: live.metadata });
    expect((await scoped(contractPath, worker.sessionID)).status).toBe(200);
    await client.session.remove({ sessionID: child.id }); await client.session.remove({ sessionID: forged.id });
    modelRelease.resolve();
    expect(await cleanupReady.promise).toBe(worker.sessionID);
    // The engine session still exists and the real interrupt HTTP request is
    // held, proving revocation happened before any awaited native cleanup.
    expect((await client.session.get({ sessionID: worker.sessionID })).id).toBe(worker.sessionID);
    expect((await scoped(contractPath, worker.sessionID)).status).toBe(403);
    expect((await scoped(submitPath, worker.sessionID, workspace.path, "POST", {})).status).toBe(403);
    cleanupRelease.resolve();
    const waited = await human("/wait", "POST", { reviewIds: [review.id], waitSeconds: 20 });
    expect(waited.status).toBe(200); expect(await waited.json()).toMatchObject({ settled: true, errors: [] });
    const completed = SavedReviewSchema.parse(await (await human(`/${review.id}`)).json());
    expect(completed.cells[0]?.result).toMatchObject({ value: "Yes", backend: "llm", model: "fixture", evidence: "cited", citations: [{ page: null, quote: "Assignment is permitted." }] });
    expect(completed.cells[0]?.status).toBe("complete");
    phase = "citation";
    const executor = new ReviewExecutor(config, { settings: async () => ({ selection: { providerId: "", model: "" }, providers: [] }), infer: async () => { throw new Error("No JEV inference expected."); } });
    const result = await executor.execute(workspace, { ...review, settings: { ...review.settings, mode: "llm", jev: null, llm: settings.llm } }, column,
      { hash: "fixture", complete: true, pages: [{ page: 1, source: "native", text: "Assignment is permitted." }] }, new AbortController().signal, { type: "host", scope: "owner" });
    expect(result).toMatchObject({ value: "Yes", backend: "llm", model: "fixture", evidence: "cited", citations: [{ page: 1, quote: "Assignment is permitted.", source: "native" }] });
    expect(citationCalls).toBe(2); // Fabricated first quote required a new corrected worker.
    expect(requests.some(input => JSON.stringify(input).includes("failed validation"))).toBe(true);
    await expect(executor.execute(workspace, review, column, { hash: "fixture", complete: true, pages: [{ page: 1, source: "native", text: "Assignment is permitted." }] }, new AbortController().signal, { type: "remote", scope: "viewer" })).rejects.toThrow();
    const workerTraffic = transports.filter(item => /\/reviews\/workers\//.test(item.path));
    expect(workerTraffic.filter(item => item.status === 200 && item.path.endsWith("/submit"))).toHaveLength(3);
    expect(wrongTools).toEqual(Array.from({ length: 3 }, () => ({ status: 403, code: "review_worker_model" })));
    for (const request of workerTraffic) { expect(request.authorization).toBeNull(); expect(request.scoped).toBe(true); }
    expect(transports.filter(item => item.status >= 400 && !item.afterSubmission)).toEqual([]);
    expect(transports.some(item => item.path === "/workspaces")).toBe(false);
    expect(primaryCalls).toBeGreaterThanOrEqual(3); expect(officeReads).toBe(0);
    expect((await client.session.list({})).data).toEqual([]);
    expect(await client.session.active()).toEqual({});
  } catch (error) {
    console.error("Real review fixture failure:", error);
    const failed = transports.filter(item => item.status >= 400);
    if (failed.length) console.error("Real review transport failures:", JSON.stringify(failed));
    throw error;
  } finally {
    modelRelease.resolve(); cleanupRelease.resolve();
    await server?.stop(); await engine?.close(); relay.stop(true); engineProxy.stop(true); model.stop(true);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
