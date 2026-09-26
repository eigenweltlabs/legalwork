import { afterAll, beforeEach, expect, test } from "bun:test";
import { ReviewExecutor, isTextReviewModel } from "./executor.js";
import { ReviewColumnSchema, SavedReviewSchema, type ReviewResult } from "./schema.js";
import { SystemOneProviderSchema, SystemOneResponseSchema, type SystemOneRequest, type SystemOneSettings } from "../systemone-schema.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import { ReviewRequests } from "./scheduler.js";
import { builtinReviewLibrary } from "./builtin-library.js";
const calls: Array<{ path: string; method: string; body: unknown }> = [];
const decisions: SystemOneRequest[] = [];
let fail = false, wrongModel = false, fabricated = false, incomplete = false, modelOffline = false, quota = false, subscribed = false, noDefault = false;
let citationRepairSucceeds = false, incidentalAbsenceCitation = false;
let stalledPrompts = 0;
const model = { id: "chat", name: "Reviewer", limit: { context: 128000, output: 4096 }, capabilities: { input: { text: true }, output: { text: true } } };
const engine = Bun.serve({ port: 0, async fetch(request) {
  const path = new URL(request.url).pathname, raw = await request.text(); calls.push({ path, method: request.method, body: raw ? JSON.parse(raw) : undefined });
  if (path === "/provider") return Response.json({ connected: modelOffline ? [] : ["firm", ...(subscribed ? ["eigenwelt"] : [])], all: [{ id: "firm", name: "Firm", models: { chat: model } }, ...(subscribed ? [{ id: "eigenwelt", name: "Eigenwelt", models: { "ewl-large": { ...model, id: "ewl-large", name: "Eigenwelt Large" } } }] : [])] });
  if (path === "/config") return Response.json({ model: noDefault ? undefined : "firm/chat" });
  if (path === "/experimental/tool/ids") return Response.json(["bash", "read", "task", "legalwork_review_start"]);
  if (path === "/session" && request.method === "POST") return Response.json({ id: "review-worker" });
  if (path === "/session/status") return Response.json(quota ? { "review-worker": { type: "retry", attempt: 1, message: "You have no credits remaining.", next: Date.now() + 60_000 } } : {});
  if (quota && path === "/session/review-worker/message") await Bun.sleep(2500);
  if (path === "/session/review-worker/message" && stalledPrompts-- > 0) await Bun.sleep(300);
  if (path === "/session/review-worker/message") return Response.json({ info: { modelID: wrongModel ? "substitute" : "chat", providerID: "firm" }, parts: [{ type: "text", text: JSON.stringify({ cells: { assignment: {
    value: incomplete || incidentalAbsenceCitation ? "Not found" : "Yes", reason: "", quote: incomplete ? "" : fabricated && !(citationRepairSucceeds && calls.filter(call => call.path.endsWith("/message")).length > 1) ? "Invented quote" : "Assignment is permitted.", page: incomplete ? null : 1, location: "Assignment", confidence: "high", citations: [],
  } } }) }] });
  if (path === "/session/review-worker/abort" || request.method === "DELETE") return Response.json(true);
  return new Response("Unknown", { status: 404 });
} });
const workspace: WorkspaceInfo = { id: "qa", name: "QA", path: "/qa", preset: "starter", workspaceType: "local" };
const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "test-host", configPath: "/unused-fixture", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [workspace.path], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, opencodeBaseUrl: engine.url.origin };
const settings: SystemOneSettings = { selection: { providerId: "firm-jev", model: "jev" }, providers: [SystemOneProviderSchema.parse({ id: "firm-jev", name: "Firm JEV", endpoint: "http://localhost/v1/systemone", enabled: true, managed: false, status: "ready", models: [{ id: "jev", name: "JEV", questionTypes: ["noul", "choice"], source: "configured" }] })] };
const executor = new ReviewExecutor(config, { settings: async () => structuredClone(settings), infer: async (_config, request, options) => {
  decisions.push(request); expect(options?.providerId).toBe("firm-jev"); if (fail) throw new Error("JEV unavailable");
  return SystemOneResponseSchema.parse({ model: "serving-jev", answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: .95 }])), usage: { input_tokens: 123, output_tokens: 0 } });
} });
const column = ReviewColumnSchema.parse({ key: "assignment", label: "Assignment", question: "Is assignment permitted?", kind: "yes_no" });
const review = (mode: "jev" | "mixed" | "llm") => SavedReviewSchema.parse({ id: "71953464-c3a7-47a5-ae2a-f28a1b090bea", name: "Review", revision: 0, createdAt: 0, updatedAt: 0, settings: { mode, jev: { providerId: "firm-jev", model: "jev" }, llm: { providerId: "firm", model: "chat" } }, documents: [], cells: [], columns: [column], status: "draft", runId: null });
const evidence = { hash: "source-hash", complete: true, pages: [{ page: 1, text: "Assignment is permitted." }] };
beforeEach(() => { calls.length = 0; decisions.length = 0; fail = false; wrongModel = false; fabricated = false; incomplete = false; modelOffline = false; quota = false; subscribed = false; noDefault = false; citationRepairSucceeds = false; incidentalAbsenceCitation = false; stalledPrompts = 0; });
afterAll(() => engine.stop(true));
test("model discovery filters embeddings, image and realtime models and retains actual engine text capabilities", () => {
  expect(isTextReviewModel(model)).toBe(true);
  for (const id of ["text-embedding-3-small", "gpt-realtime-2.1"]) expect(isTextReviewModel({ ...model, id })).toBe(false);
  expect(isTextReviewModel({ ...model, capabilities: { input: { text: true }, output: { text: true, image: true } } })).toBe(false);
  expect(isTextReviewModel({ ...model, limit: { context: 0, output: 0 } })).toBe(false);
});
test("JEV mode uses explicit provider/model and preserves probabilities without invented quotations", async () => {
  const result = await executor.execute(workspace, review("jev"), column, evidence, new AbortController().signal);
  expect(decisions[0].model).toBe("jev"); expect(result).toMatchObject({ backend: "systemone", model: "serving-jev", requestedModel: "jev", value: "Yes", decision: { type: "noul", noul: .95 }, evidence: "uncited", citations: [], confidence: null });
  expect(calls.some(call => call.path === "/session")).toBe(false);
});
test("Only JEV rejects text and uncertain evidence before inference", async () => {
  await expect(executor.execute(workspace, review("jev"), { ...column, kind: "text" }, evidence, new AbortController().signal)).rejects.toThrow("Only JEV");
  const result = await executor.execute(workspace, review("jev"), column, { ...evidence, complete: false }, new AbortController().signal);
  expect(result.value).toBe("Needs review"); expect(decisions).toHaveLength(0);
});
test("JEV failure never calls an LLM as a fallback", async () => {
  fail = true;
  await expect(executor.execute(workspace, review("mixed"), column, evidence, new AbortController().signal)).rejects.toThrow("JEV unavailable");
  expect(calls.some(call => call.path === "/session")).toBe(false);
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
      const result = await inference.execute(workspace, review("jev"), prompt, evidence, new AbortController().signal);
      expect(result.value).toBe(scenario.value); expect(result.evidence).toBe(scenario.evidence);
      expect(result.decision).toMatchObject({ type: "choice", choice: selected });
      expect(result.citations).toEqual([]);
    }
  }
  expect(calls.some(call => call.path === "/session")).toBe(false);
});
test("Only LLM uses the selected model, disables all tools, checks citations, and deletes its temporary session", async () => {
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal);
  expect(result.citations).toEqual([{ page: 1, quote: "Assignment is permitted." }]); expect(decisions).toHaveLength(0);
  expect(calls.find(call => call.path.endsWith("/message"))?.body).toMatchObject({ model: { providerID: "firm", modelID: "chat" }, tools: { bash: false, read: false, task: false, legalwork_review_start: false } });
  expect(calls.some(call => call.method === "DELETE")).toBe(true);
});
test("fabricated citations or substituted models cannot become results; tools are still cleaned up", async () => {
  fabricated = true;
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal);
  expect(result).toMatchObject({ value: "Needs review", evidence: "uncertain", citations: [] });
  expect(result.reason).toContain("could not be verified");
  expect(calls.filter(call => call.path.endsWith("/message"))).toHaveLength(2);
  fabricated = false; wrongModel = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal)).rejects.toThrow("selected model");
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(3); expect(decisions).toHaveLength(0);
});
test("one citation correction reuses the selected model and yields a verified answer", async () => {
  fabricated = true; citationRepairSucceeds = true;
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal);
  expect(result).toMatchObject({ value: "Yes", evidence: "cited", citations: [{ page: 1, quote: "Assignment is permitted." }] });
  const prompts = calls.filter(call => call.path.endsWith("/message"));
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) expect(prompt.body).toMatchObject({ model: { providerID: "firm", modelID: "chat" }, tools: { bash: false, read: false, task: false, legalwork_review_start: false } });
  expect(prompts[1].body).toHaveProperty("system", expect.stringContaining("failed citation verification"));
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2); expect(decisions).toHaveLength(0);
});
test("LLM absence with an incidental quote completes without a correction request", async () => {
  incidentalAbsenceCitation = true;
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal);
  expect(result).toMatchObject({ value: "Not found", evidence: "absent", citations: [], confidence: "low" });
  expect(calls.filter(call => call.path.endsWith("/message"))).toHaveLength(1);
});
test("incomplete source evidence cannot disappear when chunking drops empty pages", async () => {
  incomplete = true;
  const result = await executor.execute(workspace, review("llm"), column, { ...evidence, complete: false }, new AbortController().signal);
  expect(result.value).toBe("Needs review"); expect(result.evidence).toBe("uncertain");
});
test("disconnected selected model fails before creating a review session", async () => {
  modelOffline = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal)).rejects.toThrow("no longer available");
  expect(calls.some(call => call.path === "/session")).toBe(false);
});
test("provider billing errors fail promptly rather than leaving cells in an endless retry", async () => {
  quota = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal)).rejects.toThrow("no credits remaining");
  expect(calls.some(call => call.path.endsWith("/abort"))).toBe(true);
  expect(calls.some(call => call.method === "DELETE")).toBe(true);
  expect(decisions).toHaveLength(0);
});

test("stalled LLM calls release their session and retry within a bounded request deadline", async () => {
  const bounded = new ReviewExecutor(config, { settings: async () => structuredClone(settings), infer: async () => { throw new Error("Unexpected JEV"); } }, new ReviewRequests({ cells: 1, documents: 1 }, { retryDelayMs: 1, jitterMs: 0 }), 60);
  stalledPrompts = 1;
  expect((await bounded.execute(workspace, review("llm"), column, evidence, new AbortController().signal)).value).toBe("Yes");
  expect(calls.filter(call => call.path.endsWith("/message"))).toHaveLength(2);
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  calls.length = 0; stalledPrompts = 3;
  await expect(bounded.execute(workspace, review("llm"), column, evidence, new AbortController().signal)).rejects.toThrow("request time limit");
  expect(calls.filter(call => call.path.endsWith("/message"))).toHaveLength(3);
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(3);
  calls.length = 0; stalledPrompts = 1;
  const controller = new AbortController();
  const pending = bounded.execute(workspace, review("llm"), column, evidence, controller.signal);
  setTimeout(() => controller.abort(new Error("User stopped review")), 30);
  await expect(pending).rejects.toThrow("User stopped review");
  expect(calls.filter(call => call.path.endsWith("/message"))).toHaveLength(1);
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
  const result = await retried.execute(workspace, review("jev"), column, { ...evidence, pages: [{ page: 1, text: "A".repeat(120_000) }] }, new AbortController().signal);
  expect(result.value).toBe("Yes"); expect(seen).toEqual([1, 2, 2, 0]);
});
