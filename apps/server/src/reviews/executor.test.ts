import { afterAll, beforeEach, expect, test } from "bun:test";
import { ReviewExecutor, isTextReviewModel } from "./executor.js";
import { ReviewColumnSchema, SavedReviewSchema } from "./schema.js";
import { SystemOneProviderSchema, SystemOneResponseSchema, type SystemOneRequest, type SystemOneSettings } from "../systemone-schema.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
const calls: Array<{ path: string; method: string; body: unknown }> = [];
const decisions: SystemOneRequest[] = [];
let fail = false, wrongModel = false, fabricated = false, incomplete = false, modelOffline = false, quota = false;
const model = { id: "chat", name: "Reviewer", limit: { context: 128000, output: 4096 }, capabilities: { input: { text: true }, output: { text: true } } };
const engine = Bun.serve({ port: 0, async fetch(request) {
  const path = new URL(request.url).pathname, raw = await request.text(); calls.push({ path, method: request.method, body: raw ? JSON.parse(raw) : undefined });
  if (path === "/provider") return Response.json({ connected: modelOffline ? [] : ["firm"], all: [{ id: "firm", name: "Firm", models: { chat: model } }] });
  if (path === "/config") return Response.json({ model: "firm/chat" });
  if (path === "/experimental/tool/ids") return Response.json(["bash", "read", "task", "legalwork_review_start"]);
  if (path === "/session" && request.method === "POST") return Response.json({ id: "review-worker" });
  if (path === "/session/status") return Response.json(quota ? { "review-worker": { type: "retry", attempt: 1, message: "You have no credits remaining.", next: Date.now() + 60_000 } } : {});
  if (quota && path === "/session/review-worker/message") await Bun.sleep(2500);
  if (path === "/session/review-worker/message") return Response.json({ info: { modelID: wrongModel ? "substitute" : "chat", providerID: "firm" }, parts: [{ type: "text", text: JSON.stringify({ cells: { assignment: {
    value: incomplete ? "Not found" : "Yes", reason: "", quote: incomplete ? "" : fabricated ? "Invented quote" : "Assignment is permitted.", page: incomplete ? null : 1, location: "Assignment", confidence: "high", citations: [],
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
beforeEach(() => { calls.length = 0; decisions.length = 0; fail = false; wrongModel = false; fabricated = false; incomplete = false; modelOffline = false; quota = false; });
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
test("Only LLM uses the selected model, disables all tools, checks citations, and deletes its temporary session", async () => {
  const result = await executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal);
  expect(result.citations).toEqual([{ page: 1, quote: "Assignment is permitted." }]); expect(decisions).toHaveLength(0);
  expect(calls.find(call => call.path.endsWith("/message"))?.body).toMatchObject({ model: { providerID: "firm", modelID: "chat" }, tools: { bash: false, read: false, task: false, legalwork_review_start: false } });
  expect(calls.some(call => call.method === "DELETE")).toBe(true);
});
test("fabricated citations or substituted models cannot become results; tools are still cleaned up", async () => {
  fabricated = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal)).rejects.toThrow("citation");
  fabricated = false; wrongModel = true;
  await expect(executor.execute(workspace, review("llm"), column, evidence, new AbortController().signal)).rejects.toThrow("selected model");
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2); expect(decisions).toHaveLength(0);
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
