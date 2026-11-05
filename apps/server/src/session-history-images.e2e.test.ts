import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { historyImagePage, historyImagePayload } from "./session-history-image-schema.js";
import { ensureWikiAgentToken, grantReviewWorkerAccess, grantWikiAgentSession, revokeWikiAgentSession } from "./wiki/agent-access.js";
import { reviewWorkerClaims } from "./reviews/worker.js";
import { ReviewColumnSchema } from "./reviews/schema.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-history-image-routes-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const other = join(root, "other"); await mkdir(other);
  let onRead: (() => void | Promise<void>) | undefined;
  let imageReads = 0;
  const session = (id: string) => ({ id, projectID: "native-project", location: { directory: id === "ses_other" ? other : root },
    ...(id === "ses_child" ? { parentID: "ses_parent" } : {}),
    ...(id === "ses_copied_worker" ? { metadata: { legalworkReviewWorker: true } } : {}), time: { created: 1, updated: 2 } });
  const image = { id: "msg_original", type: "user", text: "Original image", files: [{ data, mime: "image/png", source: { type: "inline" }, name: "Original.png" }], time: { created: 1 } };
  const native = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/message(?:\/([^/]+))?)?$/);
    if (!match) return new Response(null, { status: 404 });
    const id = match[1];
    if (!url.pathname.includes("/message")) return Response.json({ data: session(id) });
    if (match[2]) { imageReads++; await onRead?.(); return Response.json({ data: image }); }
    return Response.json({ data: [image], cursor: { next: "opaque-next", previous: null } });
  } });
  cleanups.push(() => native.stop(true));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "ordinary-fixture", hostToken: "host-fixture", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: true, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    authorizedRoots: [root], opencodeBaseUrl: native.url.origin,
    workspaces: [{ id: "matter", name: "Matter", path: root, preset: "starter", workspaceType: "local" }, { id: "other", name: "Other", path: other, preset: "starter", workspaceType: "local" }] };
  const server = await startServer(config); cleanups.push(() => server.stop());
  const token = await ensureWikiAgentToken(config);
  await grantWikiAgentSession(config, { sessionId: "ses_child", directory: root, scope: "owner" });
  const headers = (id = "ses_child", directory = root) => ({ "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": id,
    "x-legalwork-wiki-agent-directory": encodeURIComponent(directory), "Content-Type": "application/json" });
  const url = (id = "ses_child", workspace = "matter") => `http://127.0.0.1:${server.port}/workspace/${workspace}/sessions/${id}/history-images`;
  return { root, other, config, headers, url, onRead: (callback: () => void | Promise<void>) => { onRead = callback; }, imageReads: () => imageReads };
}

test("real server routes retain metadata paging and exact ancestor bytes, rejecting full bearer, forged caller and cross-project access", async () => {
  const f = await fixture();
  const response = await fetch(`${f.url()}?sessionID=ses_parent&cursor=native-cursor`, { headers: f.headers() });
  expect(response.status).toBe(200);
  const page = historyImagePage.parse(await response.json());
  expect(page.images).toHaveLength(1); expect(page.cursor.next).toBe("opaque-next"); expect(JSON.stringify(page)).not.toContain(data);
  const reference = page.images[0]?.reference; if (!reference) throw new Error("No historical image reference");
  const read = await fetch(`${f.url()}/read`, { method: "POST", headers: f.headers(), body: JSON.stringify(reference) });
  expect(read.status).toBe(200);
  expect(historyImagePayload.parse(await read.json()).uri).toBe(`data:image/png;base64,${data}`);
  const bearer = await fetch(f.url(), { headers: { Authorization: "Bearer ordinary-fixture" } });
  expect(bearer.status).toBe(403); expect(await bearer.text()).not.toContain(data);
  const forgedCaller = await fetch(f.url("ses_parent"), { headers: f.headers() });
  expect(forgedCaller.status).toBe(403); expect(await forgedCaller.text()).not.toContain(data);
  const sibling = await fetch(`${f.url()}?sessionID=ses_sibling`, { headers: f.headers() });
  expect(sibling.status).toBe(404); expect(await sibling.text()).not.toContain(data);
  const cross = await fetch(f.url("ses_child", "other"), { headers: f.headers() });
  expect(cross.status).toBe(403); expect(await cross.text()).not.toContain(data);
  const invalid = await fetch(`${f.url()}/read`, { method: "POST", headers: f.headers(), body: "{}" });
  expect(invalid.status).toBe(400); expect(f.imageReads()).toBe(1);
});

test("origin revocation and scope downgrade during the native image read release no bytes", async () => {
  const f = await fixture();
  const page = historyImagePage.parse(await fetch(f.url(), { headers: f.headers() }).then(response => response.json()));
  const reference = page.images[0]?.reference; if (!reference) throw new Error("No historical image reference");
  f.onRead(() => revokeWikiAgentSession(f.config, "ses_child"));
  const revoked = await fetch(`${f.url()}/read`, { method: "POST", headers: f.headers(), body: JSON.stringify(reference) });
  expect(revoked.status).toBe(403); expect(await revoked.text()).not.toContain(data);
  await grantWikiAgentSession(f.config, { sessionId: "ses_child", directory: f.root, scope: "owner" });
  f.onRead(() => grantWikiAgentSession(f.config, { sessionId: "ses_child", directory: f.root, scope: "viewer" }));
  const downgraded = await fetch(`${f.url()}/read`, { method: "POST", headers: f.headers(), body: JSON.stringify(reference) });
  expect(downgraded.status).toBe(403); expect(await downgraded.text()).not.toContain(data);
  expect(f.imageReads()).toBe(2);
});

test("active inference workers and ordinary copied worker metadata receive no image authority", async () => {
  const f = await fixture();
  await grantWikiAgentSession(f.config, { sessionId: "ses_copied_worker", directory: f.root, scope: "owner" });
  const copied = await fetch(f.url("ses_copied_worker"), { headers: f.headers("ses_copied_worker") });
  expect(copied.status).toBe(404); expect(await copied.text()).not.toContain(data);
  const workspace = f.config.workspaces[0]; if (!workspace) throw new Error("No workspace");
  const claim = reviewWorkerClaims(f.config).create({ workspace, sessionID: "ses_worker", selected: { providerId: "fixture", model: "fixture" },
    column: ReviewColumnSchema.parse({ key: "answer", label: "Answer", question: "Yes?", kind: "yes_no" }), pages: [{ page: 1, text: "Source" }], instructions: "Read the supplied source." });
  const revoke = await grantReviewWorkerAccess(f.config, { workspace, sessionId: "ses_worker", claimId: claim.id, actor: { type: "host", scope: "owner" }, signal: new AbortController().signal });
  try {
    const worker = await fetch(f.url("ses_worker"), { headers: f.headers("ses_worker") });
    expect(worker.status).toBe(403); expect(await worker.text()).not.toContain(data);
    expect(f.imageReads()).toBe(0);
  } finally { revoke(); }
});
