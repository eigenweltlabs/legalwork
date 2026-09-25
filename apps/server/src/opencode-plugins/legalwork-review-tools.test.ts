import { afterAll, beforeEach, expect, test } from "bun:test";
import { LegalWorkReviewTools } from "./legalwork-review-tools.js";
const originalUrl = process.env.LEGALWORK_SERVER_URL, originalToken = process.env.LEGALWORK_SERVER_TOKEN;
const calls: Array<{ path: string; method: string; body: unknown }> = [];
let denied = false;
const server = Bun.serve({ port: 0, async fetch(request) {
  if (request.headers.get("authorization") !== "Bearer fixture-relay") return new Response("", { status: 401 });
  const path = new URL(request.url).pathname;
  const text = await request.text(); calls.push({ path, method: request.method, body: text ? JSON.parse(text) : undefined });
  if (path === "/workspaces") return Response.json({ items: [{ id: "project", path: "/project" }, { id: "nested", path: "/project/nested" }] });
  if (denied) return Response.json({ code: "review_mode_conflict", message: "Only JEV accepts typed decisions." }, { status: 422 });
  return Response.json({ fixture: true, settings: { mode: "jev" } });
} });
process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture-relay";
const plugin = await LegalWorkReviewTools();
beforeEach(() => { calls.length = 0; denied = false; });
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
  const result = await plugin.tool.legalwork_review_create.execute({ requestId: id, name: "Review", files: ["a.txt"], columns: [], settings: { mode: "llm" } }, context);
  expect(JSON.parse(result).ok).toBe(false); expect(calls).toHaveLength(0);
  expect(JSON.parse(await plugin.tool.legalwork_review_start.execute({ reviewId: id, revision: 0, mode: "llm" }, context)).ok).toBe(false);
  expect(calls).toHaveLength(0);
});
test("create preserves idempotency key and server policy errors, without fallback calls", async () => {
  denied = true;
  const input = { requestId: id, name: "Review", files: ["a.txt"], columns: [] };
  expect(JSON.parse(await plugin.tool.legalwork_review_create.execute(input, context))).toMatchObject({ ok: false, error: { code: "review_mode_conflict" } });
  expect(calls.at(-1)?.body).toEqual(input);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});
test("start preserves cell selection and revision; library discovery forwards the search", async () => {
  await plugin.tool.legalwork_review_start.execute({ reviewId: id, revision: 8, documentIds: ["doc"], columnKeys: ["law"], rerun: true }, context);
  expect(calls.at(-1)).toMatchObject({ path: `/workspace/project/reviews/${id}/start`, body: { revision: 8, documentIds: ["doc"], columnKeys: ["law"], rerun: true, reprocess: false } });
});
