import { afterAll, beforeEach, expect, test } from "bun:test";
import { LegalWorkReviewTools } from "./legalwork-review-tools.js";
import { z } from "zod";
import { SavedReviewSchema } from "@legalwork/types/reviews";
const originalUrl = process.env.LEGALWORK_SERVER_URL, originalToken = process.env.LEGALWORK_SERVER_TOKEN;
const calls: Array<{ path: string; search: string; method: string; body: unknown }> = [];
let denied = false;
let unavailable = false;
let launchFixture = false;
let launchFail = false;
let launchUnreadable = false;
let selectionFixture: { count: number; status: string; uncertain?: boolean; incomplete?: boolean } | undefined;
let exportFixture = false;
let exportDraft = false;
let reportFixture = false;
let reportWrongHash = false;
let reportLibraryFixture = false;
const server = Bun.serve({ port: 0, async fetch(request) {
  if (request.headers.get("authorization") !== "Bearer fixture-relay") return new Response("", { status: 401 });
  const url = new URL(request.url), path = url.pathname;
  const text = await request.text(); calls.push({ path, search: url.search, method: request.method, body: text ? JSON.parse(text) : undefined });
  if (path === "/workspaces") return Response.json({ items: [{ id: "project", path: "/project" }, { id: "nested", path: "/project/nested" }] });
  if (denied) return Response.json({ code: "review_mode_conflict", message: "Only JEV accepts typed decisions." }, { status: 422 });
  if (selectionFixture && path.endsWith("/corpus/query")) {
    const args = z.object({ jobId: z.string().optional(), offset: z.number().default(0), paths: z.array(z.string()).optional(), evidencePath: z.string().optional(), evidenceOffset: z.number().default(0) }).parse(text ? JSON.parse(text) : {});
    if (args.evidencePath) return Response.json({ sourceHash: `hash-${Number(args.evidencePath.match(/(\d+)\.pdf$/)?.[1])}`, passages: [{ page: args.evidenceOffset ? 2 : 1, text: args.evidenceOffset ? "Exact second-page passage." : "Project Demo | Fictional record\nCustomer Agreement\nExact first-page passage." }], nextEvidenceOffset: args.evidenceOffset ? null : 4 });
    if (!args.jobId) return Response.json({ selected: args.paths?.length });
    const f = selectionFixture, end = Math.min(args.offset + 50, f.count);
    return Response.json({ jobId: id, question: "Which class?", kind: "classification", total: f.count, counts: { [f.uncertain ? "uncertain" : "Customer Agreements"]: f.count }, status: f.status, matching: f.count, results: Array.from({ length: end - args.offset }, (_, index) => ({ path: `room/${String(args.offset + index).padStart(5, "0")}.pdf`, sourceHash: `hash-${args.offset + index}`, chunks: 1, status: f.uncertain ? "uncertain" : "complete", answer: "Customer Agreements", confidence: 1 })), nextOffset: f.incomplete || end === f.count ? null : end });
  }
  if (exportFixture) {
    if (reportLibraryFixture && path.endsWith("/library")) return Response.json({ entries: [{ id, version: 2, kind: "set", name: "DD", language: "en", source: "personal", updatedAt: 0,
      columns: [{ key: "ip", label: "IP", kind: "classification", question: "Owns IP?", hint: "", options: ["Yes", "No"] }] }] });
    if (path.endsWith("/files/content")) {
      if (request.method === "GET") {
        const file = url.searchParams.get("path");
        const content = file === "source-index.json" ? { documents: [{ document: "room/source.pdf", title: "Source", sourceHash: "hash", evidenceFiles: ["source-evidence.json"] }] }
          : file === "template-fields.json" ? { tokens: ["reviewed_files", "executive_summary", ...(reportLibraryFixture ? ["class_rows"] : [])], repeat_tables: {}, count_bindings: { reviewed_files: { metric: "documents" }, ...(reportLibraryFixture ? { class_rows: { metric: "documents", reviewName: "DD" } } : {}) } }
          : { document: "room/source.pdf", sourceHash: reportWrongHash ? "wrong" : "hash", passages: [{ page: 2, text: "The company owns its IP." }] };
        return Response.json({ content: JSON.stringify(content) });
      }
      return Response.json({ path: z.object({ path: z.string() }).parse(JSON.parse(text)).path });
    }
    const review = SavedReviewSchema.parse({ id, name: "Export", revision: 8, createdAt: 1, updatedAt: 1, settings: { mode: "jev", jev: null, llm: null }, columns: [{ key: "ip", label: "IP", kind: "classification", question: "Owns IP?", options: ["Yes", "No"] }], documents: exportDraft ? [] : [{ id: "source", path: "room/source.pdf", name: "Source", sourceHash: "hash", status: "ready" }], cells: exportDraft ? [] : [{ documentId: "source", columnKey: "ip", status: "needs_review", result: null }], status: exportDraft ? "draft" : "needs_review", runId: null });
    if (reportLibraryFixture) review.columns[0].libraryId = id;
    if (reportFixture && review.cells[0]) {
      review.cells[0].status = "complete";
      review.cells[0].result = { value: "Yes", reason: "", citations: [], confidence: null, evidence: "uncited", backend: "systemone", providerId: "eigenwelt", model: "Jev", requestedModel: "Jev", sourceHash: "hash", prompt: review.columns[0], completedAt: 1, chunks: [] };
    }
    return Response.json(review);
  }
  if (launchFixture) {
    if (path.endsWith("/library")) return Response.json({ entries: [{ id, version: 2, kind: "set", name: "DD", language: "en", source: "personal", updatedAt: 0,
      columns: [{ key: "ip", label: "IP", kind: "classification", question: "Does {{target}} own the IP?", hint: "As of {{review_date}}", options: ["Yes", "No"] }] }] });
    if (path.endsWith("/start") && launchFail) return Response.json({ code: "busy" }, { status: 409 });
    if (path.endsWith("/start") && launchUnreadable) return new Response("unreadable response");
    return Response.json(SavedReviewSchema.parse({ id, name: "DD", revision: 7, createdAt: 1, updatedAt: 1, settings: { mode: "jev", jev: null, llm: null }, columns: [], documents: [], cells: [], runId: null, status: path.endsWith("/start") ? "running" : "draft" }));
  }
  if (path.endsWith("/project/contents")) return Response.json({ version: 1, project: { id: "project", name: "Private name", fields: [] }, sections: [{ kind: "files", path: "Contracts", unavailable, nextCursor: "page-2", items: [{ id: "Contracts/a.pdf", kind: "files", title: "a.pdf", directory: false }, { id: "Contracts/Archive", kind: "files", title: "Archive", directory: true }] }] });
  return Response.json({ fixture: true, settings: { mode: "jev" } });
} });
process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture-relay";
const plugin = await LegalWorkReviewTools();
beforeEach(() => { calls.length = 0; denied = false; unavailable = false; launchFixture = false; launchFail = false; launchUnreadable = false; selectionFixture = undefined; exportFixture = false; exportDraft = false; reportFixture = false; reportWrongHash = false; reportLibraryFixture = false; });
afterAll(() => { server.stop(true); if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = originalUrl; if (originalToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = originalToken; });
const context = { directory: "/project", sessionID: "parent" };
const id = "8d421fb4-3f23-49e3-a5a2-01a2f3cd9911";

test.each(["workflow-assistant-due-diligence", "workflow-assistant-saas-acquisition-dd"])("%s report handoff redirects generated programs while allowing prose, arithmetic and other workflows", async (skillName) => {
  exportFixture = true;
  const dd = await LegalWorkReviewTools(), scoped = { ...context, sessionID: "direct-dd" };
  await dd["tool.execute.before"]({ tool: "skill", sessionID: scoped.sessionID }, { args: { name: skillName } });
  await dd["tool.execute.before"]({ tool: "skill", sessionID: scoped.sessionID }, { args: { name: "author-review-prompts" } });
  await dd.tool.legalwork_review_report_prepare.execute({ reviewIds: [id], evidenceIndexes: ["source-index.json"] }, scoped);
  await dd["tool.execute.before"]({ tool: "skill", sessionID: scoped.sessionID }, { args: { name: "docx-edit" } });
  for (const [tool,args] of [["legalwork_shell", { command: "cat << 'EOF' > scratch/build_report.py\nimport json\nEOF" }],
    ["write", { filePath: "/project/scratch/build_report.py", content: "import json" }],
    ["bash", { command: "python3 -c 'import json; " + "print(1);".repeat(100) + "'" }]] satisfies Array<[string, Record<string, unknown>]>) {
    await expect(dd["tool.execute.before"]({ tool, sessionID: scoped.sessionID }, { args })).rejects.toThrow("Write legal prose");
    await dd["tool.execute.before"]({ tool, sessionID: "another-workflow" }, { args });
  }
  for (const [tool,args] of [["write", { filePath: "/project/reports/draft.json", content: "{}" }],
    ["bash", { command: "python3 -c 'print(410000+24000)'" }],
    ["bash", { command: "python3 -c 'print(sum([" + "1,".repeat(800) + "]))'" }],
    ["bash", { command: 'python3 "installed skill/scripts/report_from_reviews.py" --data reports/draft.json' }]] satisfies Array<[string, Record<string, unknown>]>)
    await dd["tool.execute.before"]({ tool, sessionID: scoped.sessionID }, { args });
  await dd["tool.execute.before"]({ tool: "todowrite", sessionID: scoped.sessionID }, { args: { todos: [{ status: "completed" }] } });
  await dd["tool.execute.before"]({ tool: "write", sessionID: scoped.sessionID }, { args: { filePath: "/project/later-task.py" } });
});

test("one preparation exports full review data, measured draft fields and original excerpts without inference", async () => {
  exportFixture = true; reportFixture = true;
  const result = JSON.parse(await plugin.tool.legalwork_review_report_prepare.execute({ reviewIds: [id], evidenceIndexes: ["source-index.json"], templateFields: "template-fields.json" }, context));
  expect(result).toMatchObject({ ok: true, documents: 1, cells: 1, openCells: 0, draft: "reports/dd-report-data/draft.json" });
  expect(JSON.stringify(result)).not.toContain("The company owns");
  const writes = calls.filter(call => call.path.endsWith("/files/content") && call.method === "POST");
  expect(writes).toHaveLength(9);
  expect(JSON.parse(z.object({ content: z.string() }).parse(writes.at(-1)?.body).content)).toMatchObject({ measuredFields: { reviewed_files: 1 }, cells: 1 });
  const classFile = writes.find(call => z.object({ path: z.string() }).parse(call.body).path.endsWith("class-1.txt"));
  expect(z.object({ content: z.string() }).parse(classFile?.body).content).toContain("Page 2:\nThe company owns its IP.");
  expect(calls.every(call => call.method !== "POST" || call.path.endsWith("/files/content"))).toBe(true);
});

test("report preparation preserves open cells and rejects mismatched evidence before writing", async () => {
  exportFixture = true;
  const input = { reviewIds: [id], evidenceIndexes: ["source-index.json"] };
  expect(JSON.parse(await plugin.tool.legalwork_review_report_prepare.execute(input, context))).toMatchObject({ ok: true, openCells: 1, openDocuments: 1 });
  reportFixture = true; reportWrongHash = true; calls.length = 0;
  expect(JSON.parse(await plugin.tool.legalwork_review_report_prepare.execute(input, context))).toMatchObject({ ok: false, error: { message: expect.stringContaining("source version") } });
  expect(calls.some(call => call.method === "POST")).toBe(false);
  expect(JSON.parse(await plugin.tool.legalwork_review_report_prepare.execute({ ...input, reviewIds: [id,id] }, context)).ok).toBe(false);
  expect(JSON.parse(await plugin.tool.legalwork_review_report_prepare.execute({ ...input, outputPrefix: "reports/../room" }, context)).ok).toBe(false);
});

test("native report preparation binds renamed reviews through installed library provenance", async () => {
  exportFixture = true; reportFixture = true; reportLibraryFixture = true;
  const result = JSON.parse(await plugin.tool.legalwork_review_report_prepare.execute({ reviewIds: [id], evidenceIndexes: ["source-index.json"], templateFields: "template-fields.json" }, context));
  expect(result.ok).toBe(true);
  const packet = [...calls].reverse().find(call => call.path.endsWith("/files/content") && call.method === "POST");
  expect(JSON.parse(z.object({ content: z.string() }).parse(packet?.body).content)).toMatchObject({
    measuredFields: { reviewed_files: 1, class_rows: 1 }, reviews: [{ name: "Export", libraryName: "DD" }],
  });
});

test("saved selections transfer 6,001 paths internally with constant-size model arguments", async () => {
  selectionFixture = { count: 6001, status: "complete" }; launchFixture = true;
  const input = { name: "DD", sourceSelection: { jobId: id, answers: ["Customer Agreements"] }, libraryId: id, libraryVersion: 2, context: { target: "Aster", review_date: "2026-09-30" } };
  const output = JSON.parse(await plugin.tool.legalwork_review_launch.execute(input, context));
  expect(JSON.stringify(input).length).toBeLessThan(400);
  expect(JSON.stringify(output).length).toBeLessThan(1000);
  expect(output.review.status).toBe("running");
  const created = calls.find(call => call.path.endsWith("/reviews") && call.method === "POST");
  expect(z.object({ files: z.array(z.string()) }).parse(created?.body).files).toHaveLength(6001);
  calls.length = 0;
  const classified = JSON.parse(await plugin.tool.legalwork_jev_corpus_question.execute({ sourceSelection: input.sourceSelection, question: "Which type applies to this document?", kind: "classification", options: ["Customer Agreements", "DPA"] }, context));
  expect(classified.data.selected).toBe(6001);
});

test("selections reject incomplete jobs, uncertain decisions and incomplete pagination", async () => {
  launchFixture = true;
  const input = { name: "DD", sourceSelection: { jobId: id, answers: ["Customer Agreements"] }, libraryId: id, libraryVersion: 2, context: { target: "Aster", review_date: "2026-09-30" } };
  for (const fixture of [{ count: 1, status: "running" }, { count: 1, status: "complete", uncertain: true }, { count: 80, status: "complete", incomplete: true }]) {
    calls.length = 0; selectionFixture = fixture;
    expect(JSON.parse(await plugin.tool.legalwork_review_launch.execute(input, context)).ok).toBe(false);
    expect(calls.filter(call => call.path.endsWith("/reviews") && call.method === "POST")).toHaveLength(0);
  }
});

test("native export persists grid, unresolved register and pinned provenance with compact output", async () => {
  exportFixture = true;
  const result = JSON.parse(await plugin.tool.legalwork_review_export.execute({ reviewId: id }, context));
  expect(result.files).toEqual([`reports/reviews/${id}-r8.csv`, `reports/reviews/${id}-r8.unresolved.csv`, `reports/reviews/${id}-r8.manifest.json`]);
  expect(result.guidance).toContain("not cleared");
  expect(JSON.stringify(result)).not.toContain("content");
  const writes = calls.filter(call => call.path.endsWith("/files/content"));
  expect(writes).toHaveLength(3);
  expect(writes[0].body).toMatchObject({ content: "document_id,document,source_hash,ip (IP),ip_status\r\nsource,room/source.pdf,hash,,needs_review\r\n" });
});

test("an absent class does not create a doomed review or export an empty draft as coverage", async () => {
  launchFixture = true; selectionFixture = { count: 0, status: "complete" };
  const result = JSON.parse(await plugin.tool.legalwork_review_launch.execute({ name: "Customer", sourceSelection: { jobId: id, answers: ["Customer Agreements"] }, libraryId: id, libraryVersion: 2, context: { target: "Aster", review_date: "today" } }, context));
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("No documents matched") } });
  expect(calls.some(call => call.path.endsWith("/reviews") && call.method === "POST")).toBe(false);
  launchFixture = false; selectionFixture = undefined; exportFixture = true; exportDraft = true; calls.length = 0;
  expect(JSON.parse(await plugin.tool.legalwork_review_export.execute({ reviewId: id }, context))).toMatchObject({ ok: false, error: { message: expect.stringContaining("not processed") } });
  expect(calls.some(call => call.path.endsWith("/files/content"))).toBe(false);
});

test("native evidence export preserves original pages on disk and returns only a compact index reference", async () => {
  selectionFixture = { count: 3, status: "complete", uncertain: true }; exportFixture = true;
  const result = JSON.parse(await plugin.tool.legalwork_jev_evidence_export.execute({ jobId: id, answers: ["uncertain"] }, context));
  expect(result).toMatchObject({ ok: true, documents: 3, evidenceFiles: 6 });
  expect(JSON.stringify(result)).not.toContain("Exact first-page");
  const writes = calls.filter(call => call.path.endsWith("/files/content"));
  expect(writes).toHaveLength(7);
  const savedIndex = z.object({ content: z.string() }).parse(writes.at(-1)?.body);
  expect(JSON.parse(savedIndex.content).documents[0]).toMatchObject({ title: "Customer Agreement", sourceHash: "hash-0", status: "uncertain", evidenceFiles: expect.any(Array) });
  expect(z.object({ content: z.string() }).parse(writes[1].body).content).toContain('"page":2');
  expect(calls.filter(call => call.path.endsWith("/corpus/query")).every(call => z.object({ jobId: z.string() }).parse(call.body).jobId === id)).toBe(true);
});

test("corpus export writes every source internally, including uncertainty, without returning file IDs", async () => {
  selectionFixture = { count: 6001, status: "complete", uncertain: true }; exportFixture = true;
  const result = JSON.parse(await plugin.tool.legalwork_jev_corpus_export.execute({ jobId: id }, context));
  expect(result.processed).toBe(6001); expect(result.unprocessed).toBe(0);
  expect(result.counts.uncertain).toBe(6001);
  expect(JSON.stringify(result).length).toBeLessThan(1000);
  const writes = calls.filter(call => call.path.endsWith("/files/content"));
  const grid = z.object({ content: z.string() }).parse(writes[0].body).content;
  expect(grid.split("\r\n")).toHaveLength(6003);
  expect(grid.includes('"room/06000.pdf","hash-6000","Customer Agreements","uncertain"')).toBe(true);
});

test("launch copies pinned installed columns and starts immediately without repeating their text", async () => {
  launchFixture = true;
  const input = { name: "DD", files: Array.from({ length: 501 }, (_, index) => `room/${index}.pdf`), libraryId: id, libraryVersion: 2, context: { target: "Aster", review_date: "2026-09-30" } };
  const result = JSON.parse(await plugin.tool.legalwork_review_launch.execute(input, context));
  expect(result.review.status).toBe("running");
  const writes = calls.filter(call => call.method === "POST");
  expect(writes).toHaveLength(2);
  expect(writes[0].body).toMatchObject({ files: input.files, columns: [{ question: "Does Aster own the IP?", hint: "As of 2026-09-30", libraryId: id, libraryVersion: 2, libraryColumnKey: "ip" }] });
  expect(writes[1]).toMatchObject({ path: `/workspace/project/reviews/${id}/start`, body: { revision: 7, rerun: false, reprocess: false } });
  await plugin.tool.legalwork_review_launch.execute(input, context);
  expect(calls.filter(call => call.path.endsWith("/reviews") && call.method === "POST").map(call => z.object({ requestId: z.string() }).parse(call.body).requestId).every(value => value === z.object({ requestId: z.string() }).parse(writes[0].body).requestId)).toBe(true);
});
test("launch rejects changed sets or missing context before creating, and retains IDs after a failed start", async () => {
  launchFixture = true;
  const input = { name: "DD", files: ["room/a.pdf"], libraryId: id, libraryVersion: 2, context: { target: "Aster", review_date: "2026-09-30" } };
  for (const bad of [{ ...input, libraryVersion: 1 }, { ...input, context: {} }]) {
    expect(JSON.parse(await plugin.tool.legalwork_review_launch.execute(bad, context)).ok).toBe(false);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  }
  launchFail = true;
  expect(JSON.parse(await plugin.tool.legalwork_review_launch.execute(input, context))).toMatchObject({ ok: false, createdReview: { review: { id } } });
  launchFail = false; launchUnreadable = true;
  expect(JSON.parse(await plugin.tool.legalwork_review_launch.execute(input, context))).toMatchObject({ ok: false, createdReview: { review: { id } }, nextAction: expect.stringContaining("inspect its status") });
});

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
  expect(output.system.join(" ")).toContain("ONE job");
  expect(output.system.join(" ")).toContain("not the project root");
  // The listing changes as folders appear, so it arrives as a reminder, not in the system prompt.
  expect(output.system.join(" ")).not.toContain("Available top-level project folders");
  const message: { message: { id: string }; parts: object[] } = { message: { id: "msg_test" }, parts: [] };
  await scoped["chat.message"]({ sessionID: "ses_review" }, message);
  const hints = message.parts.map(part => String(Reflect.get(part, "text"))).join(" ");
  expect(hints).toContain("Available top-level project folders");
  expect(hints).toContain('"Contracts/Archive"');
  expect(hints).not.toContain("a.pdf"); expect(hints).not.toContain("Private name");
  expect(calls.filter(call => call.path.endsWith("/project/contents"))).toHaveLength(1);
  // Cached for 15 seconds, and unchanged state adds nothing to later results.
  const result = { output: "done" };
  await scoped["tool.execute.after"]({ sessionID: "ses_review" }, result);
  expect(result.output).toBe("done");
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
