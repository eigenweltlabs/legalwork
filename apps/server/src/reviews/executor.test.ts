import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewWorkerClaims } from "./worker.js";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { ReviewExecutor, isTextReviewModel } from "./executor.js";
import { ReviewColumnSchema, SavedReviewSchema, type ReviewResult } from "./schema.js";
import { SystemOneProviderSchema, SystemOneResponseSchema, type SystemOneRequest, type SystemOneSettings } from "../systemone-schema.js";
import type { Actor, ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import { callSystemOne } from "../systemone-client.js";
import { ReviewRequests } from "./scheduler.js";
import { builtinReviewLibrary } from "./builtin-library.js";
const root = await mkdtemp(join(tmpdir(), "legalwork-review-executor-"));
const actor: Actor = { type: "remote", scope: "owner", clientId: "review-executor-test" };
let workerSequence = 0;
const calls: Array<{ path: string; method: string; body: unknown }> = [];
const decisions: SystemOneRequest[] = [];
let fail = false, wrongModel = false, fabricated = false, incomplete = false, modelOffline = false, quota = false, subscribed = false, noDefault = false;
let citationRepairSucceeds = false, incidentalAbsenceCitation = false;
let stalledPrompts = 0;
let onStalledPrompt: (() => void) | undefined;
let engineError = false;
let malformedResponses = 0, invalidStructures = 0, structuredResponse = false;
const model = { id: "chat", name: "Reviewer", limit: { context: 128000, output: 4096 }, capabilities: { input: ["text"], output: ["text"] } };
const engine = Bun.serve({ port: 0, async fetch(request) {
  const path = new URL(request.url).pathname.replace(/review-worker-\d+/g, "review-worker"), raw = await request.text(); calls.push({ path, method: request.method, body: raw ? JSON.parse(raw) : undefined });
  if (path === "/api/location") return Response.json({ data: { directory: root } });
  if (path === "/api/provider") return Response.json({ location: { directory: root }, data: [{ id: "firm", name: "Firm", activation: modelOffline ? "disabled" : "enabled", package: "fixture" }, ...(subscribed ? [{ id: "eigenwelt", name: "Eigenwelt", activation: "enabled", package: "fixture" }] : [])] });
  if (path === "/api/model") return Response.json({ location: { directory: root }, data: [{ ...model, providerID: "firm", modelID: "chat", enabled: !modelOffline }, ...(subscribed ? [{ ...model, id: "ewl-large", modelID: "ewl-large", providerID: "eigenwelt", name: "Eigenwelt Large", enabled: true }] : [])] });
  if (path === "/api/model/default") return Response.json({ location: { directory: root }, data: noDefault ? null : { ...model, providerID: "firm", modelID: "chat", enabled: !modelOffline } });
  if (path === "/api/session" && request.method === "POST") return Response.json({ data: { id: "review-worker-" + (++workerSequence) } });
  if (path === "/api/session/review-worker" && request.method === "GET") {
    const creation = calls.find(call => call.path === "/api/session" && call.method === "POST");
    const created = z.object({ agent: z.string(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(creation?.body);
    const update = [...calls].reverse().find(call => call.path === path && call.method === "PATCH");
    const updated = z.object({ metadata: z.record(z.string(), z.unknown()).optional() }).parse(update?.body ?? {});
    return Response.json({ data: { id: new URL(request.url).pathname.split("/")[3], location: { directory: root }, agent: created.agent,
      metadata: { ...created.metadata, ...updated.metadata } } });
  }
  if (path === "/api/session/review-worker" && request.method === "PATCH") return new Response(null, { status: 204 });
  if (path === "/api/session/review-worker/prompt") {
    if (stalledPrompts-- > 0) { onStalledPrompt?.(); await Bun.sleep(300); return new Response("Stalled", { status: 504 }); }
    if (engineError) return Response.json({ type: "error", message: 'Agent not found: "document-extractor"' }, { status: 500 });
    const update = [...calls].reverse().find(call => call.path === "/api/session/review-worker" && call.method === "PATCH");
    const id = z.object({ metadata: z.object({ legalworkReviewClaim: z.string() }) }).parse(update?.body).metadata.legalworkReviewClaim;
    if (!quota && !wrongModel) {
      let answer: unknown = { cells: { assignment: {
        value: incomplete || incidentalAbsenceCitation ? "Not found" : "Yes", reason: "", quote: incomplete ? "" : fabricated && !(citationRepairSucceeds && calls.filter(call => call.path.endsWith("/prompt")).length > 1) ? "Invented quote" : "Assignment is permitted.",
        page: incomplete ? null : 1, location: "Assignment", confidence: "high", citations: [],
      } } };
      if (malformedResponses-- > 0) answer = "malformed";
      if (invalidStructures-- > 0) answer = { cells: { wrong: {} } };
      reviewWorkerClaims(config).submit(workspace, new URL(request.url).pathname.split("/")[3], id, { value: answer, messageID: "msg_answer", toolID: "call_submit" });
    }
    return Response.json({ data: { id: "msg_prompt" } });
  }
  if (path === "/api/experimental/session/review-worker/wait") return new Response(null, { status: 204 });
  if (path === "/api/session/review-worker/message") return Response.json({ data: [{ type: "assistant", id: "msg_answer", model: { id: wrongModel ? "substitute" : "chat", providerID: "firm" }, content: [],
    ...(quota ? { error: { message: "You have no credits remaining.", status: 402 } } : {}),
  }], cursor: {} });
  if (path === "/api/session/review-worker/interrupt" || request.method === "DELETE") return new Response(null, { status: 204 });
  return new Response("Unknown", { status: 404 });
} });
const workspace: WorkspaceInfo = { id: "qa", name: "QA", path: root, preset: "starter", workspaceType: "local" };
const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "test-host", configPath: "/unused-fixture", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [workspace.path], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, opencodeBaseUrl: engine.url.origin };
const settings: SystemOneSettings = { selection: { providerId: "firm-jev", model: "jev" }, providers: [SystemOneProviderSchema.parse({ id: "firm-jev", name: "Firm JEV", endpoint: "http://localhost/v1/systemone", enabled: true, managed: false, status: "ready", models: [{ id: "jev", name: "JEV", questionTypes: ["noul", "choice"], source: "configured" }] })] };
const executor = new ReviewExecutor(config, { settings: async () => structuredClone(settings), infer: async (_config, request, options) => {
  decisions.push(request); expect(options?.providerId).toBe("firm-jev"); if (fail) throw new Error("JEV unavailable");
  return SystemOneResponseSchema.parse({ model: "serving-jev", answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: .95 }])), usage: { input_tokens: 123, output_tokens: 0 } });
} });
const column = ReviewColumnSchema.parse({ key: "assignment", label: "Assignment", question: "Is assignment permitted?", kind: "yes_no" });
const review = (mode: "jev" | "mixed" | "llm") => SavedReviewSchema.parse({ id: "71953464-c3a7-47a5-ae2a-f28a1b090bea", name: "Review", revision: 0, createdAt: 0, updatedAt: 0, settings: { mode, jev: { providerId: "firm-jev", model: "jev" }, llm: { providerId: "firm", model: "chat" } }, documents: [], cells: [], columns: [column], status: "draft", runId: null });
const evidence = { hash: "source-hash", complete: true, pages: [{ page: 1, text: "Assignment is permitted." }] };
beforeEach(() => { calls.length = 0; decisions.length = 0; fail = false; wrongModel = false; fabricated = false; incomplete = false; modelOffline = false; quota = false; subscribed = false; noDefault = false; citationRepairSucceeds = false; incidentalAbsenceCitation = false; stalledPrompts = 0; onStalledPrompt = undefined; engineError = false; malformedResponses = 0; invalidStructures = 0; structuredResponse = false; });
afterAll(async () => { await engine.stop(true); await rm(root, { recursive: true, force: true }); });
test("model discovery filters embeddings, image and realtime models and retains actual engine text capabilities", () => {
  expect(isTextReviewModel(model)).toBe(true);
  for (const id of ["text-embedding-3-small", "gpt-realtime-2.1"]) expect(isTextReviewModel({ ...model, id })).toBe(false);
  expect(isTextReviewModel({ ...model, capabilities: { input: ["text"], output: ["text", "image"] } })).toBe(false);
  expect(isTextReviewModel({ ...model, limit: { context: 0, output: 0 } })).toBe(false);
});
test("JEV mode uses explicit provider/model and preserves probabilities without invented quotations", async () => {
  const result = await executor.execute(workspace, review("jev"), column, evidence, new AbortController().signal, actor);
  expect(decisions[0].model).toBe("jev"); expect(result).toMatchObject({ backend: "systemone", model: "serving-jev", requestedModel: "jev", value: "Yes", decision: { type: "noul", noul: .95 }, evidence: "uncited", citations: [], confidence: null });
  expect(calls.some(call => call.path === "/api/session")).toBe(false);
});
test("Only JEV rejects text and uncertain evidence before inference", async () => {
  await expect(executor.execute(workspace, review("jev"), { ...column, kind: "text" }, evidence, new AbortController().signal, actor)).rejects.toThrow("Only JEV");
  const result = await executor.execute(workspace, review("jev"), column, { ...evidence, complete: false }, new AbortController().signal, actor);
  expect(result.value).toBe("Needs review"); expect(decisions).toHaveLength(0);
});
test("JEV failure never calls an LLM as a fallback", async () => {
  fail = true;
  await expect(executor.execute(workspace, review("mixed"), column, evidence, new AbortController().signal, actor)).rejects.toThrow("JEV unavailable");
  expect(calls.some(call => call.path === "/api/session")).toBe(false);
});
test("builtin JEV choices abstain for missing, irrelevant, uncertain and low-probability answers without losing the raw decision", async () => {
  for (const locale of ["en", "de"] satisfies Array<"en" | "de">) {
    const prompt = builtinReviewLibrary(locale).find(entry => entry.id === `builtin-assignment-${locale}`)!.columns[0];
    for (const scenario of [
      { index: 0, probability: .9, value: locale === "en" ? "Yes" : "Ja", evidence: "uncited" },
      { index: 1, probability: .9, value: locale === "en" ? "No" : "Nein", evidence: "uncited" },
      { index: 2, probability: .9, value: "Not found", evidence: "absent" },
      { index: 3, probability: .9, value: "Not applicable", evidence: "uncited" },
      { index: 4, probability: .9, value: "Needs review", evidence: "uncertain" },
      { index: 0, probability: .35, value: "Needs review", evidence: "uncertain" },
      { index: 2, probability: .35, value: "Needs review", evidence: "uncertain" },
      { index: 0, probability: .5, value: "Needs review", evidence: "uncertain" },
    ] satisfies Array<{ index: number; probability: number; value: string; evidence: ReviewResult["evidence"] }>) {
      const selected = prompt.options[scenario.index];
      const inference = new ReviewExecutor(config, { settings: async () => structuredClone(settings), infer: async (_config, request) => {
        const question = request.questions.answer;
        expect(question.type).toBe("choice");
        if (question.type !== "choice") throw new Error("Expected explicit fallback choices");
        expect(Object.keys(question.criteria)).toEqual(prompt.options);
        expect(Object.values(question.criteria).every(value => typeof value === "string")).toBe(true);
        return SystemOneResponseSchema.parse({ model: "serving-jev", answers: { answer: { type: "choice", choice: selected, probabilities: Object.fromEntries(prompt.options.map(option => [option, option === selected ? scenario.probability : (1 - scenario.probability) / (prompt.options.length - 1)])) } } });
      } });
      const result = await inference.execute(workspace, review("jev"), prompt, evidence, new AbortController().signal, actor);
      expect(result.value).toBe(scenario.value); expect(result.evidence).toBe(scenario.evidence);
      expect(result.decision).toMatchObject({ type: "choice", choice: selected });
      expect(result.citations).toEqual([]);
    }
  }
  expect(calls.some(call => call.path === "/api/session")).toBe(false);
});
test("Only LLM uses the selected model, disables all tools, checks citations, and deletes its temporary session", async () => {
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor);
  expect(result.citations).toEqual([{ page: 1, quote: "Assignment is permitted." }]); expect(decisions).toHaveLength(0);
  expect(calls.find(call => call.path.endsWith("/prompt"))?.body).toMatchObject({ text: expect.stringContaining("assignment") });
  expect(calls.some(call => call.method === "DELETE")).toBe(true);
  expect(calls.some(call => call.path === "/api/session/review-worker" && call.method === "GET")).toBe(true);
  expect(calls.some(call => call.path.startsWith("/api/mcp"))).toBe(false);
});
test("review engine errors retain their cause and clean up the temporary session", async () => {
  engineError = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).rejects.toThrow('Agent not found: "document-extractor"');
  expect(calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(1);
  expect(calls.some(call => call.path.endsWith("/interrupt"))).toBe(true);
  expect(calls.some(call => call.method === "DELETE")).toBe(true);
});
test("fabricated citations or substituted models cannot become results; tools are still cleaned up", async () => {
  fabricated = true;
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor);
  expect(result).toMatchObject({ value: "Needs review", evidence: "uncertain", citations: [] });
  expect(result.reason).toContain("could not be verified");
  expect(calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(2);
  fabricated = false; wrongModel = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).rejects.toThrow("selected model");
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(3); expect(decisions).toHaveLength(0);
});
test("one citation correction reuses the selected model and yields a verified answer", async () => {
  fabricated = true; citationRepairSucceeds = true;
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor);
  expect(result).toMatchObject({ value: "Yes", evidence: "cited", citations: [{ page: 1, quote: "Assignment is permitted." }] });
  const prompts = calls.filter(call => call.path.endsWith("/prompt"));
  expect(prompts).toHaveLength(2);
  for (const creation of calls.filter(call => call.path === "/api/session" && call.method === "POST")) expect(creation.body).toMatchObject({ model: { providerID: "firm", id: "chat" }, permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "legalwork_review_submit", resource: "*", effect: "allow" }] });
  expect(prompts[1].body).toMatchObject({ text: expect.stringContaining("assignment") });
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2); expect(decisions).toHaveLength(0);
});
test("LLM absence with an incidental quote completes without a correction request", async () => {
  incidentalAbsenceCitation = true;
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor);
  expect(result).toMatchObject({ value: "Not found", evidence: "absent", citations: [], confidence: "low" });
  expect(calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(1);
});
test("incomplete source evidence cannot disappear when chunking drops empty pages", async () => {
  incomplete = true;
  const result = await executor.execute(workspace, review("llm"), column, { ...evidence, complete: false }, new AbortController().signal, actor);
  expect(result.value).toBe("Needs review"); expect(result.evidence).toBe("uncertain");
});
test("unlocatable linked evidence yields Needs review before a false absence answer", async () => {
  incidentalAbsenceCitation = true;
  const linked = { ...evidence, pages: [{ page: 1, text: "Assignment is permitted.", source: "ocr" as const,
    blocks: [{ id: "main", kind: "text", start: 0, end: 24 }] }],
    relations: [{ id: "missing", kind: "annotates" as const,
      source: { page: 1, regionId: "main" }, target: { page: 2, regionId: "missing" },
      status: "candidate" as const, basis: "arrow" as const, explanation: "Arrow" }] };
  const result = await executor.execute(workspace, review("llm"), column, linked, new AbortController().signal, actor);
  expect(result.value).toBe("Needs review");
  expect(calls.some(call => call.path.endsWith("/prompt"))).toBe(false);
});
test("JEV relevance receives a linked next-page exception before selecting chunks", async () => {
  const linked = { ...evidence, pages: [
    { page: 1, text: "Assignment is permitted." + "x".repeat(120_000), source: "ocr" as const,
      blocks: [{ id: "main", kind: "text", start: 0, end: 24 }] },
    { page: 2, text: "Exception applies.", source: "ocr" as const,
      blocks: [{ id: "exception", kind: "note", start: 0, end: 18 }] },
  ], relations: [{ id: "link", kind: "annotates" as const,
    source: { page: 1, regionId: "main" }, target: { page: 2, regionId: "exception" },
    status: "candidate" as const, basis: "arrow" as const, explanation: "Arrow" }] };
  const result = await executor.execute(workspace, review("jev"), column, linked, new AbortController().signal, actor);
  expect(result.value).toBe("Needs review"); // Both relevant chunks exceed combined context.
  expect(JSON.stringify(decisions[0].state)).toContain("Exception applies.");
  expect(JSON.stringify(decisions[0].state)).toContain('"status":"candidate"');
});
test("disconnected selected model fails before creating a review session", async () => {
  modelOffline = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).rejects.toThrow("no longer available");
  expect(calls.some(call => call.path === "/api/session")).toBe(false);
});
test("provider billing errors fail promptly rather than leaving cells in an endless retry", async () => {
  quota = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).rejects.toThrow("no credits remaining");
  expect(calls.some(call => call.path.endsWith("/interrupt"))).toBe(true);
  expect(calls.some(call => call.method === "DELETE")).toBe(true);
  expect(decisions).toHaveLength(0);
});

test("stalled LLM calls release their session and retry within a bounded request deadline", async () => {
  const bounded = new ReviewExecutor(config, { settings: async () => structuredClone(settings), infer: async () => { throw new Error("Unexpected JEV"); } }, new ReviewRequests({ cells: 1, documents: 1 }, { retryDelayMs: 1, jitterMs: 0 }), 60);
  stalledPrompts = 1;
  expect((await bounded.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).value).toBe("Yes");
  expect(calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(2);
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  calls.length = 0; stalledPrompts = 3;
  await expect(bounded.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).rejects.toThrow("request time limit");
  expect(calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(3);
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(3);
});

test("stopping a stalled LLM request releases its session without retrying", async () => {
  stalledPrompts = 1;
  const controller = new AbortController();
  onStalledPrompt = () => controller.abort(new Error("User stopped review"));
  const pending = executor.execute(workspace, review("llm"), column, evidence, controller.signal, actor);
  await expect(pending).rejects.toThrow("User stopped review");
  expect(calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(1);
  expect(calls.filter(call => call.path.endsWith("/interrupt"))).toHaveLength(1);
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});

test("subscribers default to Eigenwelt rather than an unrelated global chat model", async () => {
  subscribed = true;
  const found = await executor.models(workspace);
  expect(found.settings.llm).toEqual({ providerId: "eigenwelt", model: "ewl-large" }); expect(found.settings.mode).toBe("mixed");
  expect(found.settings.jev).toEqual({ providerId: "eigenwelt", model: "EigenJev" });
});
test("non-subscribers default to LLM without JEV and mixed with a configured JEV provider", async () => {
  const noJev = new ReviewExecutor(config, { settings: async () => ({ ...settings, providers: [] }), infer: async () => { throw new Error("No inference"); } });
  expect((await noJev.models(workspace)).settings).toEqual({ mode: "llm", jev: null, llm: { providerId: "firm", model: "chat" } });
  const configured = new ReviewExecutor(config, { settings: async () => ({ ...settings, providers: settings.providers.map(provider => ({ ...provider, status: "unavailable" })) }), infer: async () => { throw new Error("No inference"); } });
  expect((await configured.models(workspace)).settings).toEqual({ mode: "mixed", jev: { providerId: "firm-jev", model: "jev" }, llm: { providerId: "firm", model: "chat" } });
});
test("subscription defaults retain managed EigenJev during an outage instead of selecting a custom provider", async () => {
  const discovery = new ReviewExecutor(config, { subscribed: async () => true, settings: async () => structuredClone(settings), infer: async () => { throw new Error("No inference"); } });
  expect((await discovery.models(workspace)).settings).toEqual({ mode: "mixed", jev: { providerId: "eigenwelt", model: "EigenJev" }, llm: null });
});
test("connected models are selected even without global chat or JEV selections", async () => {
  noDefault = true;
  const discovery = new ReviewExecutor(config, { settings: async () => ({ ...settings, selection: { providerId: "missing", model: "missing" } }), infer: async () => { throw new Error("Must not run inference"); } });
  const found = await discovery.models(workspace);
  expect(found.settings.jev).toEqual({ providerId: "firm-jev", model: "jev" }); expect(found.settings.llm).toEqual({ providerId: "firm", model: "chat" }); expect(found.settings.mode).toBe("mixed");
});

test("a throttled JEV chunk retries individually without repeating prior successful chunks", async () => {
  const seen: number[] = [];
  let throttled = false;
  const retried = new ReviewExecutor(config, { settings: async () => structuredClone(settings), infer: async (_config, request, options) => {
    expect(options?.retry).toBe(false); // The review scheduler owns retries, not the adapter.
    const state = request.state;
    const part = typeof state === "object" && state !== null && !Array.isArray(state) ? state.document_part : undefined;
    const index = typeof part === "object" && part !== null && !Array.isArray(part) && typeof part.index === "number" ? part.index : 0;
    seen.push(index);
    if (index === 2 && !throttled) { throttled = true; throw new ApiError(429, "systemone_rate_limited", "Rate limited", { retryAfterMs: 1 }); }
    return SystemOneResponseSchema.parse({ model: "jev", answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: index === 1 ? .1 : .95 }])), usage: { input_tokens: 1, output_tokens: 0 } });
  } }, new ReviewRequests(undefined, { retryDelayMs: 1, jitterMs: 0 }));
  const result = await retried.execute(workspace, review("jev"), column, { ...evidence, pages: [{ page: 1, text: "A".repeat(120_000) }] }, new AbortController().signal, actor);
  expect(result.value).toBe("Yes"); expect(seen).toEqual([1, 2, 2, 0]);
});


test("review discovery excludes disabled managed models even when the provider is ready", async () => {
  const managed = new ReviewExecutor(config, { infer: async () => { throw new Error("Discovery must not infer"); }, settings: async () => ({ ...settings, providers: [
    SystemOneProviderSchema.parse({ ...settings.providers[0], id: "eigenwelt", managed: true, models: [
      { id: "EigenJev", name: "Eigenwelt Europe EigenJev", questionTypes: ["noul", "choice"], source: "configured", status: "ready", region: "EU" },
      { id: "TypeSafeJev", name: "Eigenwelt US Jev", questionTypes: ["noul", "choice"], source: "configured", status: "disabled", region: "US" },
    ] }),
  ] }) });
  const result = await managed.models(workspace);
  expect(result.models.some(model => model.model === "EigenJev")).toBe(true);
  expect(result.models.some(model => model.model === "TypeSafeJev")).toBe(false);
});

test("a subscriber's explicit TypeSafe selection survives unavailability without switching region", async () => {
  const selection = { providerId: "eigenwelt", model: "TypeSafeJev" };
  const discovery = new ReviewExecutor(config, {
    subscribed: async () => true,
    settings: async () => ({ ...settings, selection, providers: [SystemOneProviderSchema.parse({
      ...settings.providers[0], id: "eigenwelt", managed: true,
      models: [
        { id: "EigenJev", name: "EU", questionTypes: ["noul", "choice"], source: "configured", status: "ready" },
        { id: "TypeSafeJev", name: "US", questionTypes: ["noul", "choice"], source: "configured", status: "unavailable" },
      ],
    })] }),
    infer: async () => { throw new Error("Discovery must not infer"); },
  });
  const result = await discovery.models(workspace);
  expect(result.settings.jev).toEqual(selection);
  expect(result.models.some(model => model.model === "TypeSafeJev")).toBe(false);
});


test("review evidence reaches the SystemOne HTTP adapter for EU and US models, including chunk relevance", async () => {
  const prompt = builtinReviewLibrary("de").find(entry => entry.id === "builtin-forum-country-de")!.columns[0];
  const received: SystemOneRequest[] = [];
  const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(httpRequest) {
    const request: SystemOneRequest = await httpRequest.json();
    received.push(request);
    return Response.json({ model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key,
      question.type === "choice" ? { type: "choice", choice: "Deutschland", probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === "Deutschland" ? 1 : 0])) }
        : { type: "noul", noul: received.length === 1 ? .99 : .01 },
    ])) });
  } });
  try {
    for (const model of ["EigenJev", "TypeSafeJev"]) for (const long of [false, true]) {
      received.length = 0;
      const selection = { providerId: "eigenwelt", model };
      const runner = new ReviewExecutor(config, {
        settings: async () => ({ selection, providers: [SystemOneProviderSchema.parse({ ...settings.providers[0], id: "eigenwelt", managed: true,
          models: [{ id: model, name: model, source: "configured", questionTypes: ["noul", "choice"], status: "ready" }],
        })] }),
        infer: async (_config, request) => callSystemOne({ endpoint: `${gateway.url}v1/systemone`, apiKey: "fixture", model, questionTypes: ["noul", "choice"] }, request, { retry: false }),
      });
      const document = { ...evidence, pages: [{ page: 1, text: "Gerichtsstand ist Berlin, Deutschland. " + (long ? "A".repeat(120_000) : ""),
        blocks: undefined, tables: undefined, links: undefined }] };
      const result = await runner.execute(workspace, { ...review("mixed"), settings: { ...review("mixed").settings, jev: selection } }, prompt, document, new AbortController().signal, actor);
      expect(result.value).toBe("Deutschland");
      expect(received.every(request => request.model === model)).toBe(true);
      expect(received.some(request => "relevant" in request.questions)).toBe(long);
      expect(received.at(-1)?.questions.answer.type).toBe("choice");
    }
  } finally { gateway.stop(true); }
});


test("review workers are marked internal in the creation request, before inference starts", async () => {
  await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor);
  expect(calls.find(call => call.path === "/api/session")?.body).toMatchObject({ agent: "document-extractor", metadata: { legalworkReviewWorker: true } });
  expect(calls.find(call => call.path === "/api/session")?.body).toMatchObject({ model: { providerID: "firm", id: "chat" }, permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "legalwork_review_submit", resource: "*", effect: "allow" }] });
});

test("malformed JSON and invalid cell structures receive one grounded correction attempt", async () => {
  for (const failure of ["syntax", "schema"]) {
    calls.length = 0;
    if (failure === "syntax") malformedResponses = 1; else invalidStructures = 1;
    const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor);
    expect(result.value).toBe("Yes");
    const prompts = calls.filter(call => call.path.endsWith("/prompt"));
    expect(prompts).toHaveLength(2);
    expect(prompts[1].body).toMatchObject({ text: expect.stringContaining("assignment") });
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  }
});

test("repeated malformed responses stop with a useful error and never become an accepted finding", async () => {
  malformedResponses = 10;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).rejects.toThrow("could not return a valid review answer after a correction attempt");
  expect(calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(2);
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
});

test("structured answers still undergo source verification", async () => {
  structuredResponse = true;
  expect((await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor)).value).toBe("Yes");
  fabricated = true;
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal, actor);
  expect(result.value).toBe("Needs review");
  expect(result.citations).toEqual([]);
});
