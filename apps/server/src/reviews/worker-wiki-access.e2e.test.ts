import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { startServer } from "../server.js";
import { wikiTeamFixture } from "../wiki/team-test-helper.js";
import { ensureWikiAgentToken, grantReviewWorkerAccess } from "../wiki/agent-access.js";
import { reviewWorkerClaims } from "./worker.js";
import { ReviewColumnSchema } from "./schema.js";
import { REVIEW_AGENT } from "./worker-identity.js";
import type { TokenScope } from "../types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("worker grants preserve owner-only private Wiki visibility and collaborator access to shared Wikis", async () => {
  const cloud = await wikiTeamFixture(); cleanup.push(() => cloud.close());
  const { config } = await cloud.account(), server = await startServer(config); cleanup.push(async () => { await server.stop(); });
  const base = `http://127.0.0.1:${server.port}`, token = await ensureWikiAgentToken(config);
  const sessions = new Map<string, { directory: string; claimId: string }>();
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const id = new URL(request.url).pathname.match(/^\/api\/session\/([^/]+)$/)?.[1], entry = id ? sessions.get(id) : undefined;
    return entry ? Response.json({ data: { id, location: { directory: entry.directory }, agent: REVIEW_AGENT,
      metadata: { legalworkReviewWorker: true, legalworkReviewClaim: entry.claimId } } }) : Response.json({}, { status: 404 });
  } });
  cleanup.push(async () => { await engine.stop(true); });
  for (const shared of [false, true]) {
    const created = await fetch(base + "/wikis", { method: "POST", headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" },
      body: JSON.stringify({ name: shared ? "Shared worker authority" : "Private worker authority", template: "firm", ...(shared ? { sharing: { access: "org", memberIds: [] } } : {}) }) });
    expect(created.status).toBe(201);
    const { wiki } = z.object({ wiki: z.object({ workspaceId: z.string(), root: z.string() }) }).parse(await created.json());
    const workspace = config.workspaces.find(item => item.id === wiki.workspaceId);
    if (!workspace) throw new Error("Expected real Wiki workspace");
    workspace.baseUrl = engine.url.origin;
    for (const scope of ["owner", "collaborator"] satisfies TokenScope[]) {
      const id = `worker-${shared}-${scope}`, claim = reviewWorkerClaims(config).create({ sessionID: id, workspace, selected: { providerId: "fixture", model: "reviewer" },
        column: ReviewColumnSchema.parse({ key: "assignment", label: "Assignment", question: "Allowed?", kind: "yes_no" }),
        pages: [{ page: 1, text: "Assignment is permitted." }], instructions: "Review the supplied source." });
      sessions.set(id, { directory: wiki.root, claimId: claim.id });
      const revoke = await grantReviewWorkerAccess(config, { workspace, sessionId: id, claimId: claim.id, actor: { type: "remote", scope }, signal: new AbortController().signal });
      try {
        const response = await fetch(`${base}/workspace/${wiki.workspaceId}/reviews/workers/${id}/contract`, { headers: {
          "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": id, "x-legalwork-wiki-agent-directory": encodeURIComponent(wiki.root),
        } });
        expect(response.status).toBe(shared || scope === "owner" ? 200 : 404);
        expect(await response.json()).toMatchObject(shared || scope === "owner" ? { id: claim.id } : { code: "workspace_not_found" });
      } finally { revoke(); }
    }
  }
}, 30_000);
