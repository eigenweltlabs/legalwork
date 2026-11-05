import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { REVIEW_AGENT, REVIEW_SUBMIT_TOOL } from "../reviews/worker-identity.js";
import { ReviewColumnSchema } from "../reviews/schema.js";
import { reviewWorkerClaims } from "../reviews/worker.js";
import { configureWikiAgentSessionLookup, ensureWikiAgentToken, grantReviewWorkerAccess, grantWikiAgentSession, revokeWikiAgentSession } from "./agent-access.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-agent-workspace-tools-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "matter"); await mkdir(directory);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client-fixture", hostToken: "host-fixture",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, agentSandboxEnabled: true };
  const server = await startServer(config); cleanup.push(async () => { await server.stop(); });
  const url = `http://127.0.0.1:${server.port}`, token = await ensureWikiAgentToken(config);
  await grantWikiAgentSession(config, { sessionId: "ordinary", directory, scope: "collaborator" });
  const request = (path: string, method = "GET", body?: unknown, session = "ordinary", host = false) => fetch(`${url}/workspace/matter/${path}`, {
    method, headers: { "Content-Type": "application/json", ...(host ? { "x-legalwork-host-token": config.hostToken } : {
      Authorization: `Bearer ${config.token}`, "x-legalwork-wiki-agent-token": token,
      "x-legalwork-wiki-agent-session": session, "x-legalwork-wiki-agent-directory": encodeURIComponent(directory),
    }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { root, directory, config, request };
}

test("managed ordinary tools reach the real Office relay without losing viewer or revocation enforcement", async () => {
  const { config, directory, request } = await fixture();
  expect((await request("office-tools/poll?wait=0&host=word", "GET", undefined, "ordinary", true)).status).toBe(200);
  const pending = request("office-tools/execute", "POST", { tool: "word_read_document", args: {} });
  const poll = await request("office-tools/poll?wait=2&host=word", "GET", undefined, "ordinary", true);
  const { requests } = await poll.json();
  expect(requests).toMatchObject([{ tool: "word_read_document", args: {} }]);
  expect((await request(`office-tools/requests/${requests[0].id}/result`, "POST", { ok: true, result: { text: "Owned document" } }, "ordinary", true)).status).toBe(200);
  expect(await (await pending).json()).toEqual({ ok: true, result: { text: "Owned document" } });
  await grantWikiAgentSession(config, { sessionId: "ordinary", directory, scope: "viewer" });
  for (const path of ["office-tools/execute", "sandbox/command", "sandbox/http", "reviews/workers/ordinary/submit"])
    expect(await (await request(path, "POST", { sessionID: "ordinary" })).json()).toMatchObject({ code: "forbidden" });
  await grantWikiAgentSession(config, { sessionId: "ordinary", directory, scope: "collaborator" });
  for (const path of ["sandbox/command", "sandbox/http"])
    expect(await (await request(path, "POST", { sessionID: "another-chat" })).json()).toMatchObject({ code: "wiki_agent_session_mismatch" });
  revokeWikiAgentSession(config, "ordinary");
  expect(await (await request("office-tools/execute", "POST", { tool: "word_read_document" })).json()).toMatchObject({ code: "wiki_agent_session_unknown" });
}, 15_000);

test("review endpoints preserve exact worker, model, active claim and read-only authority", async () => {
  const { config, directory, request } = await fixture(), workspace = config.workspaces[0];
  const claim = reviewWorkerClaims(config).create({ sessionID: "worker", workspace, selected: { providerId: "fixture", model: "reviewer" },
    column: ReviewColumnSchema.parse({ key: "assignment", label: "Assignment", question: "Allowed?", kind: "yes_no" }),
    pages: [{ page: 1, source: "native", text: "Assignment is permitted." }], instructions: "Review this source." });
  let wrongModel = false, reads = 0;
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    reads++;
    const path = new URL(req.url).pathname;
    if (path === "/api/session/worker") return Response.json({ data: { id: "worker", location: { directory }, agent: REVIEW_AGENT,
      metadata: { legalworkReviewWorker: true, legalworkReviewClaim: claim.id } } });
    if (path === "/api/session/ordinary") return Response.json({ data: { id: "ordinary", location: { directory }, agent: "legalwork", metadata: {} } });
    if (path === "/api/session/worker/message/msg") return Response.json({ data: { id: "msg", type: "assistant", agent: REVIEW_AGENT,
      model: { id: wrongModel ? "other" : "reviewer", providerID: "fixture" }, content: [{ type: "tool", id: "call", name: REVIEW_SUBMIT_TOOL }] } });
    return Response.json({}, { status: 404 });
  } });
  cleanup.push(async () => { await engine.stop(true); });
  workspace.baseUrl = engine.url.origin;
  const revoke = await grantReviewWorkerAccess(config, { workspace, sessionId: "worker", claimId: claim.id,
    actor: { type: "remote", scope: "collaborator" }, signal: new AbortController().signal });
  cleanup.push(async () => { revoke(); });
  expect(await (await request("reviews/workers/worker/contract", "GET", undefined, "worker")).json()).toMatchObject({ id: claim.id, schema: claim.schema });
  expect(await (await request("reviews/workers/worker/contract", "GET", undefined, "worker", true)).json()).toMatchObject({ code: "review_worker_access_required" });
  const priorReads = reads;
  expect(await (await request("reviews/workers/worker/contract")).json()).toMatchObject({ code: "wiki_agent_session_mismatch" });
  expect(reads).toBe(priorReads);
  expect(await (await request("reviews/workers/ordinary/contract")).json()).toMatchObject({ code: "review_worker_access_required" });
  const value = { cells: { assignment: { value: "Yes", reason: "Permitted", quote: "Assignment is permitted.", page: 1, location: "Assignment", confidence: "high", citations: [{ page: 1, quote: "Assignment is permitted.", source: "native" }] } } };
  const input = { value, messageID: "msg", toolID: "call" };
  wrongModel = true;
  expect(await (await request("reviews/workers/worker/submit", "POST", input, "worker")).json()).toMatchObject({ code: "review_worker_model" });
  wrongModel = false; config.readOnly = true;
  expect(await (await request("reviews/workers/worker/submit", "POST", input, "worker")).json()).toMatchObject({ code: "read_only" });
  config.readOnly = false;
  expect(await (await request("reviews/workers/worker/submit", "POST", input, "worker")).json()).toEqual({ accepted: true });
  expect(await claim.completion).toMatchObject({ ok: true, cell: { value: "Yes" } });
  reviewWorkerClaims(config).remove("worker");
  expect(await (await request("reviews/workers/worker/contract", "GET", undefined, "worker")).json()).toMatchObject({ code: "review_worker_not_found" });
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory, parentID: "worker" }));
  expect(await (await request("reviews/workers/worker/contract", "GET", undefined, "child")).json()).toMatchObject({ code: "wiki_agent_session_unknown" });
}, 15_000);
