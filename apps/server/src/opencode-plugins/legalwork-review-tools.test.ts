import { afterAll, beforeEach, expect, test } from "bun:test";
import { LegalWorkReviewTools } from "./legalwork-review-tools.js";
import { z } from "zod";
const originalUrl = process.env.LEGALWORK_SERVER_URL, originalToken = process.env.LEGALWORK_SERVER_TOKEN;
const calls: Array<{ path: string; search: string; method: string; body: unknown }> = [];
let denied = false;
let unavailable = false;
const server = Bun.serve({ port: 0, async fetch(request) {
  if (request.headers.get("authorization") !== "Bearer fixture-relay") return new Response("", { status: 401 });
  const url = new URL(request.url), path = url.pathname;
  const text = await request.text(); calls.push({ path, search: url.search, method: request.method, body: text ? JSON.parse(text) : undefined });
  if (path === "/workspaces") return Response.json({ items: [{ id: "project", path: "/project" }, { id: "nested", path: "/project/nested" }] });
  if (denied) return Response.json({ code: "review_mode_conflict", message: "Only JEV accepts typed decisions." }, { status: 422 });
  if (path.endsWith("/project/contents")) return Response.json({ version: 1, project: { id: "project", name: "Private name", fields: [] }, sections: [{ kind: "files", path: "Contracts", unavailable, nextCursor: "page-2", items: [{ id: "Contracts/a.pdf", kind: "files", title: "a.pdf", directory: false }, { id: "Contracts/Archive", kind: "files", title: "Archive", directory: true }] }] });
  return Response.json({ fixture: true, settings: { mode: "jev" } });
} });
process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture-relay";
const plugin = await LegalWorkReviewTools();
beforeEach(() => { calls.length = 0; denied = false; unavailable = false; });
afterAll(() => { server.stop(true); if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = originalUrl; if (originalToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = originalToken; });
const context = { directory: "/project", sessionID: "parent" };
const id = "8d421fb4-3f23-49e3-a5a2-01a2f3cd9911";

test("old model/row tools are removed and the agent is instructed to read enforced settings", async () => {
  expect(Object.keys(plugin.tool)).not.toContain("tabular_review_row"); expect(Object.keys(plugin.tool)).not.toContain("tabular_review_models");
  const output: { system: string[] } = { system: [] }; await plugin["experimental.chat.system.transform"]({}, output);
  expect(output.system.join(" ")).toContain("BEFORE proposing"); expect(output.system.join(" ")).toContain("No free-text");
});
test("review tools are scoped to the exact or closest registered project, never a sibling", async () => {
  expect(JSON.parse(await plugin.tool.legalwork_review_settings.execute({}, { directory: "/project/nested/docs" })).ok).toBe(true);
  expect(calls.at(-1)?.path).toBe("/workspace/nested/reviews/settings");
  calls.length = 0;
  expect(JSON.parse(await plugin.tool.legalwork_review_list.execute({}, { directory: "/project-elsewhere" })).ok).toBe(false);
  expect(calls).toHaveLength(0);
});
test("agents cannot override mode or inject backend/model settings into create or start", async () => {
  const result = await plugin.tool.legalwork_review_create.execute({ name: "Review", files: ["a.txt"], columns: [], settings: { mode: "llm" } }, context);
  expect(JSON.parse(result).ok).toBe(false); expect(calls).toHaveLength(0);
  expect(JSON.parse(await plugin.tool.legalwork_review_start.execute({ reviewId: id, revision: 0, mode: "llm" }, context)).ok).toBe(false);
  expect(calls).toHaveLength(0);
});
test("create generates stable per-session retry IDs and preserves server policy errors", async () => {
  denied = true;
  const input = { name: "Review", files: ["a.txt"], columns: [] };
  expect(JSON.parse(await plugin.tool.legalwork_review_create.execute(input, context))).toMatchObject({ ok: false, error: { code: "review_mode_conflict" } });
  const first = z.object({ requestId: z.string().uuid() }).parse(calls.at(-1)?.body).requestId;
  expect(calls.at(-1)?.body).toMatchObject({ ...input, sessionId: context.sessionID });
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  const reloaded = await LegalWorkReviewTools();
  await reloaded.tool.legalwork_review_create.execute(input, context);
  expect(calls.at(-1)?.body).toHaveProperty("requestId", first);
  for (const [args, ctx] of [[{ ...input, name: "Second review" }, context], [input, { ...context, sessionID: "another" }]] satisfies Array<[typeof input, typeof context]>) {
    await plugin.tool.legalwork_review_create.execute(args, ctx);
    expect(z.object({ requestId: z.string().uuid() }).parse(calls.at(-1)?.body).requestId).not.toBe(first);
  }
  expect(plugin.tool.legalwork_review_create.args).not.toHaveProperty("requestId");
  expect(plugin.tool.legalwork_review_create.args).not.toHaveProperty("sessionId");
  expect(plugin.tool.legalwork_review_start.args).not.toHaveProperty("sessionId");
  calls.length = 0;
  expect(JSON.parse(await plugin.tool.legalwork_review_create.execute({ ...input, requestId: id }, context)).ok).toBe(false);
  expect(calls).toHaveLength(0);
});

test("review file discovery is paginated, scoped and excludes project widget data", async () => {
  const result = JSON.parse(await plugin.tool.legalwork_review_files.execute({ path: "Contracts", cursor: "page-1", limit: 10 }, context));
  expect(result).toEqual({ ok: true, workspaceId: "project", path: "Contracts", nextCursor: "page-2", files: [{ path: "Contracts/a.pdf", name: "a.pdf", directory: false }, { path: "Contracts/Archive", name: "Archive", directory: true }] });
  const params = new URLSearchParams(calls.at(-1)?.search);
  expect(params.get("kind")).toBe("files"); expect(params.get("cursor")).toBe("page-1"); expect(params.get("limit")).toBe("10");
  unavailable = true;
  expect(JSON.parse(await plugin.tool.legalwork_review_files.execute({}, context))).toMatchObject({ ok: false, error: { message: expect.stringContaining("not mean the folder is empty") } });
});
test("start preserves cell selection and revision; library discovery forwards the search", async () => {
  const result = JSON.parse(await plugin.tool.legalwork_review_start.execute({ reviewId: id, revision: 8, documentIds: ["doc"], columnKeys: ["law"], rerun: true }, context));
  expect(calls.at(-1)).toMatchObject({ path: `/workspace/project/reviews/${id}/start`, body: { sessionId: context.sessionID, revision: 8, documentIds: ["doc"], columnKeys: ["law"], rerun: true, reprocess: false } });
  expect(result.nextAction).toContain("For start-only requests");
  expect(result.nextAction).toContain("legalwork_review_wait");
  denied = true;
  expect(JSON.parse(await plugin.tool.legalwork_review_start.execute({ reviewId: id, revision: 8 }, context))).not.toHaveProperty("nextAction");
});

test("result queries forward filters through the project-scoped read-only endpoint", async () => {
  const input = { view: "answers", limit: 60, documentIds: ["doc-1", "doc-2"], columnKeys: ["law"], statuses: ["complete"], values: ["Ja / Yes"], query: "German law", searchIn: ["citations"], sort: { by: "document", direction: "asc" } };
  const result = JSON.parse(await plugin.tool.legalwork_review_results.execute({ reviewId: id, ...input }, context));
  expect(result).toMatchObject({ ok: true, workspaceId: "project" });
  const request = calls.at(-1)!;
  expect(request).toMatchObject({ method: "POST", path: `/workspace/project/reviews/${id}/results/query`, body: input });
  expect(calls.filter(call => call.method !== "GET")).toHaveLength(1);
  await plugin.tool.legalwork_review_results.execute({ reviewId: id, cursor: "opaque-next-page" }, context);
  expect(calls.at(-1)?.body).toEqual({ cursor: "opaque-next-page" });
  expect(plugin.tool.legalwork_review_results.args).not.toHaveProperty("revision");
  expect(plugin.tool.legalwork_review_results.args).not.toHaveProperty("offset");
});

test("agents can discuss saved JEV results without rerunning, and result tools retain scope and validation", async () => {
  const output: { system: string[] } = { system: [] }; await plugin["experimental.chat.system.transform"]({}, output);
  expect(output.system.join(" ")).toContain("not discussion of already-saved results");
  expect(output.system.join(" ")).toContain("Never start, recreate or rerun a review merely to read its results");
  expect(output.system.join(" ")).toContain("usableAnswer=true");
  expect(JSON.parse(await plugin.tool.legalwork_review_results.execute({ reviewId: id }, { directory: "/project-elsewhere" })).ok).toBe(false);
  calls.length = 0;
  expect(JSON.parse(await plugin.tool.legalwork_review_results.execute({ reviewId: id, limit: 500 }, context)).ok).toBe(false);
  expect(calls).toHaveLength(0);
});

test("corpus questions preserve per-document wording, use project scope and carry retry identity", async () => {
  const input = { paths: ["Contracts"], question: "Does this document contain an assignment clause?", answers: ["Yes"] };
  const tool = plugin.tool.legalwork_jev_corpus_question;
  expect(tool.description).toContain("EACH document");
  expect(JSON.parse(await tool.execute(input, context)).ok).toBe(true);
  const first = calls.at(-1); expect(first?.path).toBe("/workspace/project/reviews/corpus/query");
  expect(first?.body).toMatchObject(input);
  await tool.execute(input, context); expect(calls.at(-1)?.body).toEqual(first?.body);
  const result = await tool.execute({ jobId: id, offset: 30 }, context); expect(JSON.parse(result).ok).toBe(true);
  expect(calls.at(-1)?.body).toMatchObject({ jobId: id, offset: 30 });
});


test("Jev starts a whole named folder immediately and caps optional waits and page sizes", async () => {
  const tool = plugin.tool.legalwork_jev_corpus_question;
  const input = { paths: ["Jev Search Corpus"], question: "Does this document contain a change-of-control clause?", answers: ["Yes"], limit: 100, waitSeconds: 60 };
  expect(z.object(tool.args).safeParse(input).success).toBe(true);
  expect(JSON.parse(await tool.execute(input, context)).ok).toBe(true);
  expect(calls.at(-1)).toMatchObject({ path: "/workspace/project/reviews/corpus/query", body: { ...input, limit: 50, waitSeconds: 0 } });
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  await tool.execute({ jobId: id, waitSeconds: 60, limit: 100 }, context);
  expect(calls.at(-1)?.body).toMatchObject({ jobId: id, waitSeconds: 25, limit: 50 });
  expect(calls.at(-1)?.body).not.toHaveProperty("paths");
});

test("file browsing accepts oversized pages and a quoted empty root without extra agent retries", async () => {
  const result = JSON.parse(await plugin.tool.legalwork_review_files.execute({ path: '\"\"', limit: 100 }, context));
  expect(result.ok).toBe(true);
  const params = new URLSearchParams(calls.at(-1)?.search);
  expect(params.get("path")).toBe(""); expect(params.get("limit")).toBe("50");
});

test("bounded folder hints let the model select a named subfolder without a discovery tool loop", async () => {
  const scoped = await LegalWorkReviewTools(context);
  const output: { system: string[] } = { system: [] };
  await scoped["experimental.chat.system.transform"]({}, output);
  const hints = output.system.find(value => value.startsWith("Available top-level project folders"));
  expect(hints).toContain('"Contracts/Archive"');
  expect(hints).not.toContain("a.pdf"); expect(hints).not.toContain("Private name");
  expect(output.system.join(" ")).toContain("ONE job");
  expect(output.system.join(" ")).toContain("not the project root");
  expect(calls.filter(call => call.path.endsWith("/project/contents"))).toHaveLength(1);
  await scoped["experimental.chat.system.transform"]({}, { system: [] });
  expect(calls.filter(call => call.path.endsWith("/project/contents"))).toHaveLength(1);
});

test("agents can wait for multiple reviews in their project without model or execution overrides", async () => {
  const input = { reviewIds: [id, "81a622ba-fc55-40fd-a965-846596122258"], waitSeconds: 0 };
  expect(JSON.parse(await plugin.tool.legalwork_review_wait.execute(input, context)).ok).toBe(true);
  expect(calls.at(-1)).toMatchObject({ path: "/workspace/project/reviews/wait", method: "POST", body: input });
  calls.length = 0;
  expect(JSON.parse(await plugin.tool.legalwork_review_wait.execute(input, { directory: "/project-elsewhere" })).ok).toBe(false);
  expect(calls).toHaveLength(0);
  const output: { system: string[] } = { system: [] }; await plugin["experimental.chat.system.transform"]({}, output);
  expect(output.system.join(" ")).toContain("start all requested reviews and use legalwork_review_wait");
});
