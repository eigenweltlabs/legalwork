import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, ServerConfig } from "../types.js";
import { authenticateWikiAgentRequest, configureWikiAgentSessionLookup, ensureWikiAgentToken, grantReviewWorkerAccess, grantWikiAgentSession } from "../wiki/agent-access.js";
import { ReviewColumnSchema } from "./schema.js";
import { reviewExecutionActor } from "./execution-actor.js";
import { reviewWorkerClaims } from "./worker.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-review-access-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const workspace = config.workspaces[0], token = await ensureWikiAgentToken(config), controller = new AbortController();
  const claim = reviewWorkerClaims(config).create({ sessionID: "worker", workspace, selected: { providerId: "fixture", model: "reviewer" },
    column: ReviewColumnSchema.parse({ key: "assignment", label: "Assignment", question: "Allowed?", kind: "yes_no" }),
    pages: [{ page: 1, text: "Assignment is permitted." }], instructions: "Use the supplied evidence." });
  const grant = (actor: Actor = { type: "remote", scope: "owner" }) => grantReviewWorkerAccess(config, { workspace, sessionId: "worker", claimId: claim.id, actor, signal: controller.signal });
  const request = (path = "/workspace/matter/reviews/workers/worker/contract", method = "GET", session = "worker", directory = root) => new Request(`http://localhost${path}`, {
    method, headers: { "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": session, "x-legalwork-wiki-agent-directory": encodeURIComponent(directory) },
  });
  return { root, config, workspace, claim, grant, request, controller };
}

test("a worker has only its exact active contract and submit authority with the initiating scope", async () => {
  const f = await fixture(), dispose = await f.grant({ type: "remote", scope: "collaborator" });
  expect(await authenticateWikiAgentRequest(f.config, f.request())).toMatchObject({ reviewWorker: true, sessionId: "worker", generation: f.claim.id, actor: { scope: "collaborator" } });
  expect((await authenticateWikiAgentRequest(f.config, f.request("/workspace/matter/reviews/workers/worker/submit", "POST")))?.reviewWorker).toBe(true);
  for (const [path, method] of [["/workspaces", "GET"], ["/wikis", "GET"], ["/workspace/matter/storage/roots", "GET"],
    ["/workspace/matter/office-tools/execute", "POST"], ["/workspace/matter/sandbox/command", "POST"], ["/workspace/matter/sandbox/http", "POST"],
    ["/workspace/matter/reviews/workers/worker/contract", "POST"], ["/workspace/matter/opencode/api/session/worker/prompt", "POST"]])
    await expect(authenticateWikiAgentRequest(f.config, f.request(path, method))).rejects.toMatchObject({ code: "wiki_agent_endpoint_denied" });
  await expect(authenticateWikiAgentRequest(f.config, f.request("/workspace/matter/reviews/workers/other/contract"))).rejects.toMatchObject({ code: "wiki_agent_session_mismatch" });
  await expect(authenticateWikiAgentRequest(f.config, f.request("/workspace/other/reviews/workers/worker/contract"))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
  const other = join(f.root, "other"); await mkdir(other);
  await expect(authenticateWikiAgentRequest(f.config, f.request(undefined, "GET", "worker", other))).rejects.toMatchObject({ code: "wiki_agent_directory_mismatch" });
  reviewWorkerClaims(f.config).remove("worker");
  await expect(authenticateWikiAgentRequest(f.config, f.request())).rejects.toMatchObject({ code: "review_worker_not_found" });
  dispose();
});

test("worker cancellation revokes synchronously and reserved identities never become generic or inherited grants", async () => {
  const f = await fixture(), dispose = await f.grant();
  configureWikiAgentSessionLookup(f.config, async (_workspace, id) => ({ id, directory: f.root, ...(id === "child" ? { parentID: "worker" } : {}) }));
  await expect(authenticateWikiAgentRequest(f.config, f.request("/workspaces", "GET", "child"))).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  await expect(grantWikiAgentSession(f.config, { sessionId: "worker", directory: f.root, scope: "owner" })).rejects.toMatchObject({ code: "review_worker_access_invalid" });
  f.controller.abort();
  expect(() => reviewWorkerClaims(f.config).get(f.workspace, "worker", f.claim.id)).toThrow("no longer active");
  await expect(authenticateWikiAgentRequest(f.config, f.request())).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  await expect(grantWikiAgentSession(f.config, { sessionId: "worker", directory: f.root, scope: "owner" })).rejects.toMatchObject({ code: "review_worker_access_invalid" });
  await expect(authenticateWikiAgentRequest(f.config, f.request("/workspaces", "GET", "child"))).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  dispose();
});

test("server-issued authority cannot be minted from absent or viewer scope, inactive claims or a forged workspace", async () => {
  const f = await fixture();
  for (const actor of [{ type: "host" }, { type: "remote", scope: "viewer" }] satisfies Actor[])
    await expect(f.grant(actor)).rejects.toMatchObject({ code: "review_actor_required" });
  expect(() => reviewExecutionActor(undefined)).toThrow("initiating member");
  await expect(grantReviewWorkerAccess(f.config, { workspace: { ...f.workspace, id: "invented" }, sessionId: "worker", claimId: f.claim.id,
    actor: { type: "remote", scope: "owner" }, signal: f.controller.signal })).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
  reviewWorkerClaims(f.config).remove("worker");
  await expect(f.grant()).rejects.toMatchObject({ code: "review_worker_not_found" });
  await expect(authenticateWikiAgentRequest(f.config, f.request())).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
});

test("owner scope remains explicit and cleanup revokes before any engine teardown is needed", async () => {
  const f = await fixture(), dispose = await f.grant({ type: "host", scope: "owner" });
  expect((await authenticateWikiAgentRequest(f.config, f.request()))?.actor.scope).toBe("owner");
  dispose();
  await expect(authenticateWikiAgentRequest(f.config, f.request())).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  const noScopedToken = f.request(); noScopedToken.headers.delete("x-legalwork-wiki-agent-token"); noScopedToken.headers.set("Authorization", "Bearer fixture");
  expect(await authenticateWikiAgentRequest(f.config, noScopedToken)).toBeNull();
});
