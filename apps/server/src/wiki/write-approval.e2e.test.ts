import { WikiSuggestionSchema } from "@legalwork/types/wiki-suggestions";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ViewRecordSchema, type ViewInput } from "@legalwork/types/views";
import { startServer } from "../server.js";
import { serve } from "../serve-node.js";
import type { ServerConfig } from "../types.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "./agent-access.js";
import { listApprovals, respondApproval, waitForApprovals, type TestApproval } from "./approval.test-helpers.js";

const roots: string[] = [], stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const documentSchema = z.object({ path: z.string(), content: z.string(), revision: z.string() });
const input: ViewInput = { version: 1, title: "Review", mode: "report", catalog: "legalwork-1", program: 'root = Text("Review")', queries: {} };

async function fixture(timeoutMs = 3_000) {
  const root = await mkdtemp(join(tmpdir(), "wiki-write-approval-"));
  roots.push(root);
  const project = join(root, "Matter");
  await mkdir(project);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "approval-client", hostToken: "approval-host",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs }, corsOrigins: ["*"],
    workspaces: [{ id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  const agentToken = await ensureWikiAgentToken(config);
  await grantWikiAgentSession(config, { sessionId: "matter-chat", directory: project, scope: "owner" });
  const server = await startServer(config);
  stops.push(() => server.stop());
  const url = `http://127.0.0.1:${server.port}`;
  const host = (path: string, method = "GET", body?: unknown) => fetch(`${url}${path}`, { method,
    headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = await host("/wikis", "POST", { name: "Knowledge", root: join(root, "Knowledge"), template: "blank" });
  expect(created.status).toBe(201);
  const { wiki } = z.object({ wiki: z.object({ id: z.string(), root: z.string(), workspaceId: z.string() }) }).parse(await created.json());
  await mkdir(join(wiki.root, "Knowledge"));
  const base = `/wikis/${wiki.id}`;
  const content = "---\ntype: client\nstatus: draft\n---\n# Client\n\nOriginal text.\n";
  const page = documentSchema.parse(await (await host(`${base}/page`, "PUT", { path: "Client.md", content, baseRevision: null })).json());
  const view = ViewRecordSchema.parse(await (await host(`${base}/ui-views`, "POST", input)).json());
  const headers = (sessionID = "matter-chat", directory = project) => ({ "content-type": "application/json",
    "x-legalwork-wiki-agent-token": agentToken, "x-legalwork-wiki-agent-session": sessionID,
    "x-legalwork-wiki-agent-directory": encodeURIComponent(directory),
  });
  const agent = (path: string, method = "GET", body?: unknown, signal?: AbortSignal) => fetch(`${url}${base}${path}`, {
    method, headers: headers(), signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const pending = async (action: string) => {
    const [approval] = await waitForApprovals(url, config.hostToken);
    expect(approval).toMatchObject({ action, workspaceId: "matter", sessionID: "matter-chat",
      actor: { type: "remote", clientId: "wiki-agent:matter-chat", scope: "owner" } });
    expect(approval.workspaceId).not.toBe(wiki.workspaceId);
    expect(approval.summary).toContain("Matter");
    return approval;
  };
  const reply = (approval: TestApproval, value: "allow" | "deny") => respondApproval(url, config.hostToken, approval, value);
  const unchanged = async () => {
    expect(await readFile(join(wiki.root, page.path), "utf8")).toBe(content);
    const current = ViewRecordSchema.parse(await (await host(`${base}/ui-views/${view.id}`)).json());
    expect(current.revision).toBe(view.revision);
    expect(current.title).toBe(view.title);
    expect(z.object({ items: z.array(z.unknown()) }).parse(await (await host(`${base}/ui-views`)).json()).items).toHaveLength(1);
  };
  return { root, project, config, wiki, url, base, host, headers, agent, page, view, pending, reply, unchanged };
}

async function descendantFixture() {
  const f = await fixture();
  const directory = await realpath(f.project);
  const sessions = new Map([
    ["matter-chat", { id: "matter-chat", location: { directory }, parentID: undefined }],
    ["child-chat", { id: "child-chat", location: { directory }, parentID: "matter-chat" }],
  ]);
  const engineRequests: string[] = [];
  const engine = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/session/")) return Response.json({ error: "Not found" }, { status: 404 });
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("wiki-engine:test-secret").toString("base64")}`);
    expect(request.headers.get("x-opencode-directory")).toBeNull();
    const id = decodeURIComponent(path.slice("/api/session/".length));
    engineRequests.push(id);
    const record = sessions.get(id);
    return record ? Response.json({ data: record }) : Response.json({ error: "Unknown session" }, { status: 404 });
  } });
  stops.push(() => engine.stop());
  const workspace = f.config.workspaces.find(item => item.id === "matter");
  if (!workspace) throw new Error("Matter workspace missing");
  workspace.baseUrl = `http://127.0.0.1:${engine.port}`;
  workspace.opencodeUsername = "wiki-engine";
  workspace.opencodePassword = "test-secret";
  const child = (path: string, method = "GET", body?: unknown) => fetch(`${f.url}${path}`, {
    method, headers: f.headers("child-chat"), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const pendingChild = async () => {
    const [approval] = await waitForApprovals(f.url, f.config.hostToken);
    expect(approval).toMatchObject({ action: "wiki.write", workspaceId: "matter", sessionID: "child-chat",
      actor: { type: "remote", clientId: "wiki-agent:child-chat", scope: "owner" } });
    return approval;
  };
  return { ...f, sessions, engineRequests, child, pendingChild };
}

test("a revoked ancestor and changed engine lineage cannot retain child wiki access", async () => {
  const f = await descendantFixture();
  expect((await f.child(`${f.base}/page?path=Client.md`)).status).toBe(200);
  const original = f.sessions.get("child-chat");
  if (!original) throw new Error("Child session missing");
  f.sessions.set("child-chat", { ...original, parentID: "unregistered-parent" });
  expect((await f.child(`${f.base}/page?path=Client.md`)).status).toBe(403);
  f.sessions.set("child-chat", { ...original, location: { directory: f.root } });
  expect((await f.child("/wikis")).status).toBe(403);
  f.sessions.set("child-chat", original);
  await grantWikiAgentSession(f.config, { sessionId: "matter-chat", directory: join(f.root, "unavailable"), scope: "owner" });
  expect((await f.child(`${f.base}/page?path=Client.md`)).status).toBe(403);
  expect(await listApprovals(f.url, f.config.hostToken)).toEqual([]);
  await f.unchanged();
});

test("project wiki reads, discovery and report reads do not require approval", async () => {
  const f = await fixture();
  for (const path of ["/page?path=Client.md", "/search?q=Client", "/fields", "/ui-views", `/ui-views/${f.view.id}`]) {
    expect((await f.agent(path)).status).toBe(200);
    expect(await listApprovals(f.url, f.config.hostToken)).toEqual([]);
  }
  expect((await f.agent("/query", "POST", { fields: ["title", "status"] })).status).toBe(200);
  expect((await fetch(`${f.url}/wikis`, { headers: f.headers() })).status).toBe(200);
  expect(await listApprovals(f.url, f.config.hostToken)).toEqual([]);
});

test("a wiki's own session follows ordinary approval mode even when project access is disabled", async () => {
  const f = await fixture();
  expect((await f.host(f.base, "PATCH", { allowInProjects: false })).status).toBe(200);
  await grantWikiAgentSession(f.config, { sessionId: "own-wiki-chat", directory: f.wiki.root, scope: "owner" });
  const ownWrite = (revision: string, content: string) => fetch(`${f.url}${f.base}/page`, { method: "PUT",
    headers: f.headers("own-wiki-chat", f.wiki.root), body: JSON.stringify({ path: f.page.path, content, baseRevision: revision }) });
  const auto = await ownWrite(f.page.revision, "# Own wiki edit\n");
  expect(auto.status).toBe(200);
  const page = documentSchema.parse(await auto.json());
  expect(await listApprovals(f.url, f.config.hostToken)).toEqual([]);
  f.config.approval.mode = "manual";
  const manual = ownWrite(page.revision, "# Manual own wiki edit\n");
  const [approval] = await waitForApprovals(f.url, f.config.hostToken);
  expect(approval).toMatchObject({ action: "wiki.write", workspaceId: f.wiki.workspaceId });
  await f.reply(approval, "deny");
  expect((await manual).status).toBe(403);
  expect(await readFile(join(f.wiki.root, f.page.path), "utf8")).toBe(page.content);
});


const suggestionsPath = "/workspace/matter/wiki-suggestions";
test("human Save files exact reviewed sources and links; stale previews, agent publication and Dismiss cannot file them", async () => {
  const f = await fixture();
  const bytes = Buffer.from("%PDF-1.4\nSynthetic legal authority\n");
  await writeFile(join(f.project, "judgment.pdf"), bytes);
  const proposal = { title: "Finding", content: "# Finding\n\nSupported legal knowledge.", destination: { wikiId: f.wiki.id, path: "Knowledge/Finding.md", baseRevision: null }, attachments: [{ sourcePath: "judgment.pdf" }] };
  const staged = await fetch(`${f.url}${suggestionsPath}`, { method: "POST", headers: f.headers(), body: JSON.stringify(proposal) });
  expect(staged.status).toBe(201);
  const draft = WikiSuggestionSchema.parse(await staged.json());
  const path = `${suggestionsPath}/${draft.id}`, source = draft.attachments[0]!;
  await expect(readFile(join(f.wiki.root, source.path))).rejects.toMatchObject({ code: "ENOENT" });
  const previewPath = `${path}/attachments/${source.sha256}?revision=${draft.revision}`;
  const preview = await f.host(previewPath);
  expect(preview.status).toBe(200);
  expect(preview.headers.get("content-type")).toBe("application/pdf");
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(bytes);
  expect((await f.host(`${path}/attachments/${source.sha256}?revision=stale`)).status).toBe(409);
  expect((await fetch(`${f.url}${path}/save`, { method: "POST", headers: f.headers(), body: JSON.stringify({ revision: draft.revision }) })).status).toBe(403);
  await writeFile(join(f.project, "judgment.pdf"), "New version of original");
  const response = await f.host(`${path}/save`, "POST", { revision: draft.revision });
  expect(response.status).toBe(200);
  const saved = WikiSuggestionSchema.parse(await response.json());
  expect(saved.attachments[0].path).toBe("Sources/judgment.pdf");
  expect(await readFile(join(f.wiki.root, saved.attachments[0].path))).toEqual(bytes);
  expect(await readFile(join(f.wiki.root, proposal.destination.path), "utf8")).toBe(saved.content);
  expect(saved.content).toContain(proposal.content);
  expect(saved.content).toContain(`../Sources/judgment.pdf`);
  expect(saved.content).not.toContain(draft.id);

  const second = WikiSuggestionSchema.parse(await (await f.host(suggestionsPath, "POST", { ...proposal, destination: { ...proposal.destination, path: "Knowledge/Dismissed.md" } })).json());
  expect((await f.host(`${suggestionsPath}/${second.id}/dismiss`, "POST", { revision: second.revision })).status).toBe(200);
  expect(await readFile(join(f.wiki.root, saved.attachments[0].path))).toEqual(bytes);
  await expect(readFile(join(f.wiki.root, second.destination.path))).rejects.toMatchObject({ code: "ENOENT" });
});

test("tampered copies, revoked wiki access and changed destinations fail before any source is filed", async () => {
  const f = await fixture();
  await writeFile(join(f.project, "source.pdf"), "Original");
  const draft = WikiSuggestionSchema.parse(await (await f.host(suggestionsPath, "POST", { title: "Finding", content: "# Finding", destination: { wikiId: f.wiki.id, path: "Knowledge/Finding.md", baseRevision: null }, attachments: [{ sourcePath: "source.pdf" }] })).json());
  const path = `${suggestionsPath}/${draft.id}`, attachment = draft.attachments[0]!;
  await writeFile(join(f.project, attachment.filePath), "Changed");
  expect((await f.host(`${path}/save`, "POST", { revision: draft.revision })).status).toBe(409);
  await writeFile(join(f.project, attachment.filePath), "Original");
  await f.host(f.base, "PATCH", { allowInProjects: false });
  expect((await f.host(`${path}/save`, "POST", { revision: draft.revision })).status).toBe(403);
  await f.host(f.base, "PATCH", { allowInProjects: true });
  await writeFile(join(f.wiki.root, draft.destination.path), "# Colleague's finding");
  expect((await f.host(`${path}/save`, "POST", { revision: draft.revision })).status).toBe(409);
  await expect(readFile(join(f.wiki.root, attachment.path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.wiki.root, draft.destination.path), "utf8")).toBe("# Colleague's finding");
});

async function stage(f: Awaited<ReturnType<typeof fixture>>, content = "# Useful knowledge\n") {
  const response = await fetch(`${f.url}${suggestionsPath}`, { method: "POST", headers: f.headers(), body: JSON.stringify({
    title: "Useful knowledge", content, destination: { wikiId: f.wiki.id, path: "Knowledge/New.md", baseRevision: null },
  }) });
  expect(response.status).toBe(201);
  return WikiSuggestionSchema.parse(await response.json());
}

test("project writes, fields, wiki views and deletes cannot bypass the suggestion viewer", async () => {
  const f = await fixture();
  const calls = [
    { path: "/page", method: "PUT", body: { path: f.page.path, content: "# Changed", baseRevision: f.page.revision } },
    { path: "/page", method: "DELETE", body: { path: f.page.path, baseRevision: f.page.revision } },
    { path: "/properties", method: "PATCH", body: { path: f.page.path, baseRevision: f.page.revision, patch: { set: { status: "changed" }, unset: [] } } },
    { path: "/ui-views", method: "POST", body: input },
    { path: `/ui-views/${f.view.id}`, method: "PUT", body: { input, baseRevision: f.view.revision } },
  ];
  for (const call of calls) {
    const response = await f.agent(call.path, call.method, call.body);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: call.path.startsWith("/ui-views") ? "wiki_agent_endpoint_denied" : "wiki_suggestion_required" });
  }
  expect(await listApprovals(f.url, f.config.hostToken)).toEqual([]);
  await f.unchanged();
});

test("stage, edit, restart recovery and human save preserve exact content outside the wiki until Save", async () => {
  const f = await fixture(), draft = await stage(f);
  expect(draft.filePath).toMatch(/^\.legalwork\/tmp\/wiki-suggestions\/[^/]+\/draft\.md$/);
  expect(await readFile(join(f.project, draft.filePath), "utf8")).toBe(draft.content);
  expect((await f.host(`${f.base}/page?path=Knowledge/New.md`)).status).toBe(404);
  expect(await listApprovals(f.url, f.config.hostToken)).toEqual([]);
  const path = `${suggestionsPath}/${draft.id}`;
  // Agent cannot call either human review action, even with a valid draft revision.
  for (const action of ["save", "dismiss"]) expect((await fetch(`${f.url}${path}/${action}`, { method: "POST", headers: f.headers(), body: JSON.stringify({ revision: draft.revision }) })).status).toBe(403);
  const update = await fetch(`${f.url}${path}`, { method: "PUT", headers: f.headers(), body: JSON.stringify({ ...draft, content: "# Edited by agent\n", revision: draft.revision }) });
  expect(update.status).toBe(200);
  const edited = WikiSuggestionSchema.parse(await update.json());
  // A stale editor cannot overwrite an agent edit.
  expect((await f.host(path, "PUT", { ...draft, content: "stale" })).status).toBe(409);
  const reviewed = WikiSuggestionSchema.parse(await (await f.host(path, "PUT", { ...edited, content: "# Edited by user\n\nReusable finding.", destination: { ...edited.destination, path: "Knowledge/Reviewed.md" } })).json());
  const saved = await f.host(`${path}/save`, "POST", { revision: reviewed.revision });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ status: "saved" });
  expect(await readFile(join(f.wiki.root, "Knowledge/Reviewed.md"), "utf8")).toBe(reviewed.content);
  expect((await f.host(`${path}/save`, "POST", { revision: reviewed.revision })).status).toBe(409);
  expect((await f.host(`${f.base}/page?path=Knowledge/New.md`)).status).toBe(404);
});

test("dismissal leaves wiki unchanged and remains discoverable to avoid repeat proposals", async () => {
  const f = await fixture(), draft = await stage(f);
  const path = `${suggestionsPath}/${draft.id}`;
  expect((await f.host(`${path}/dismiss`, "POST", { revision: draft.revision })).status).toBe(200);
  const list = await fetch(`${f.url}${suggestionsPath}`, { headers: f.headers() });
  expect(await list.json()).toMatchObject({ items: [{ id: draft.id, status: "dismissed" }] });
  expect((await f.host(`${path}/save`, "POST", { revision: draft.revision })).status).toBe(409);
  expect((await f.host(`${f.base}/page?path=Knowledge/New.md`)).status).toBe(404);
});

test("malformed suggestions return a useful validation error without creating a draft", async () => {
  const f = await fixture();
  const response = await fetch(`${f.url}${suggestionsPath}`, { method: "POST", headers: f.headers(), body: JSON.stringify({ title: "", content: "# Draft" }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_wiki_suggestion" });
  expect(await (await f.host(suggestionsPath)).json()).toEqual({ items: [] });
});

test("Save rechecks wiki access and revisions, including a newly selected destination", async () => {
  const f = await fixture(), draft = await stage(f);
  const path = `${suggestionsPath}/${draft.id}`;
  const changed = WikiSuggestionSchema.parse(await (await f.host(path, "PUT", { ...draft, destination: { wikiId: f.wiki.id, path: f.page.path, baseRevision: null } })).json());
  expect((await f.host(`${path}/save`, "POST", { revision: changed.revision })).status).toBe(409);
  await f.unchanged();
  const replacement = WikiSuggestionSchema.parse(await (await f.host(path, "PUT", { ...changed, destination: { ...changed.destination, baseRevision: f.page.revision } })).json());
  await f.host(f.base, "PATCH", { allowInProjects: false });
  expect((await f.host(`${path}/save`, "POST", { revision: replacement.revision })).status).toBe(403);
  await f.unchanged();
  await f.host(f.base, "PATCH", { allowInProjects: true });
  await f.host(`${f.base}/page`, "PUT", { path: f.page.path, content: "# Colleague's change", baseRevision: f.page.revision });
  expect((await f.host(`${path}/save`, "POST", { revision: replacement.revision })).status).toBe(409);
  expect(await readFile(join(f.wiki.root, f.page.path), "utf8")).toBe("# Colleague's change");
  expect(WikiSuggestionSchema.parse(await (await f.host(path)).json()).status).toBe("pending");
});

test("child agents can stage in their originating project but cannot publish or reach other projects", async () => {
  const f = await descendantFixture();
  const proposal = { title: "Child proposal", content: "# Useful knowledge", destination: { wikiId: f.wiki.id, path: "Child.md", baseRevision: null } };
  const response = await f.child(suggestionsPath, "POST", proposal);
  expect(response.status).toBe(201);
  const draft = WikiSuggestionSchema.parse(await response.json());
  expect(draft.sessionId).toBe("child-chat");
  expect((await f.child(`${suggestionsPath}/${draft.id}/save`, "POST", { revision: draft.revision })).status).toBe(403);
  expect((await f.child("/workspace/another-project/wiki-suggestions")).status).toBe(403);
  await grantWikiAgentSession(f.config, { sessionId: "matter-chat", directory: f.project, scope: "collaborator" });
  expect((await f.child(suggestionsPath, "POST", proposal)).status).toBe(404);
  await f.unchanged();
});


test("destinations use real folders in the selected wiki and revalidate on Save", async () => {
  const f = await fixture();
  const second = z.object({ wiki: z.object({ id: z.string() }) }).parse(await (await f.host("/wikis", "POST", { name: "Other wiki", root: join(f.root, "Other"), template: "blank" })).json()).wiki;
  const draft = await stage(f);
  const path = `${suggestionsPath}/${draft.id}`;
  // A path valid in the first wiki does not silently create folders in the second.
  const changed = await f.host(path, "PUT", { ...draft, destination: { ...draft.destination, wikiId: second.id } });
  expect(changed.status).toBe(400);
  expect(await changed.json()).toMatchObject({ code: "wiki_folder_missing" });
  expect(WikiSuggestionSchema.parse(await (await f.host(path)).json()).destination.wikiId).toBe(f.wiki.id);
  await rm(join(f.wiki.root, "Knowledge"), { recursive: true });
  const save = await f.host(`${path}/save`, "POST", { revision: draft.revision });
  expect(save.status).toBe(400);
  expect(await save.json()).toMatchObject({ code: "wiki_folder_missing" });
  expect(WikiSuggestionSchema.parse(await (await f.host(path)).json()).status).toBe("pending");
  await f.unchanged();
});


test("disabling approval publishes project contributions and source snapshots, while access checks and human endpoints stay enforced", async () => {
  const f = await fixture();
  const propose = (value: unknown, method = "POST", suffix = "") => fetch(`${f.url}${suggestionsPath}${suffix}`, { method, headers: f.headers(), body: JSON.stringify(value) });
  const proposal = { title: "Background finding", content: "# Finding", destination: { wikiId: f.wiki.id, path: "Knowledge/Background.md", baseRevision: null }, attachments: [{ sourcePath: "judgment.pdf" }] };
  await writeFile(join(f.project, "judgment.pdf"), "new source");
  expect((await f.agent("", "PATCH", { requireAgentApproval: false })).status).toBe(403);
  expect((await f.host(f.base, "PATCH", { requireAgentApproval: false })).status).toBe(200);
  await mkdir(join(f.wiki.root, "Sources"));
  await writeFile(join(f.wiki.root, "Sources", "judgment.pdf"), "existing source");
  const response = await propose(proposal);
  expect(response.status).toBe(201);
  const saved = WikiSuggestionSchema.parse(await response.json());
  expect(saved.status).toBe("saved");
  expect(saved.attachments[0].path).toBe("Sources/judgment (2).pdf");
  expect(await readFile(join(f.wiki.root, saved.destination.path), "utf8")).toBe(saved.content);
  expect(saved.content).toContain("../Sources/judgment%20%282%29.pdf");
  expect(await readFile(join(f.wiki.root, "Sources/judgment.pdf"), "utf8")).toBe("existing source");
  const preview = await f.host(`${suggestionsPath}/${saved.id}/attachments/${saved.attachments[0].sha256}?revision=${saved.revision}`);
  expect(preview.status).toBe(200);
  expect(await preview.text()).toBe("new source");
  expect((await propose({ ...proposal, content: "# Stale" })).status).toBe(409);
  expect((await f.agent("/page?path=Direct.md", "PUT", { path: "Direct.md", content: "# Bypass", baseRevision: null })).status).toBe(403);
  expect((await propose({ revision: saved.revision }, "POST", `/${saved.id}/save`)).status).toBe(403);
  // A later change applies immediately to existing sessions and drafts.
  await f.host(f.base, "PATCH", { requireAgentApproval: true });
  const next = { ...proposal, destination: { ...proposal.destination, path: "Knowledge/Next.md" } };
  const pending = WikiSuggestionSchema.parse(await (await propose(next)).json());
  expect(pending.status).toBe("pending");
  await expect(readFile(join(f.wiki.root, next.destination.path))).rejects.toMatchObject({ code: "ENOENT" });
  await f.host(f.base, "PATCH", { requireAgentApproval: false });
  const updated = WikiSuggestionSchema.parse(await (await propose({ ...next, revision: pending.revision }, "PUT", `/${pending.id}`)).json());
  expect(updated.status).toBe("saved");
  await f.host(f.base, "PATCH", { allowInProjects: false });
  expect((await propose({ ...proposal, destination: { ...proposal.destination, path: "Knowledge/Denied.md" } })).status).toBe(403);
  await expect(readFile(join(f.wiki.root, "Knowledge/Denied.md"))).rejects.toMatchObject({ code: "ENOENT" });
});


test("background publication cannot bypass read-only mode or a session's viewer scope", async () => {
  const f = await fixture();
  await f.host(f.base, "PATCH", { requireAgentApproval: false });
  const proposal = { title: "Denied", content: "# Denied", destination: { wikiId: f.wiki.id, path: "Knowledge/Denied.md", baseRevision: null } };
  await grantWikiAgentSession(f.config, { sessionId: "viewer-chat", directory: f.project, scope: "viewer" });
  const denied = await fetch(`${f.url}${suggestionsPath}`, { method: "POST", headers: f.headers("viewer-chat"), body: JSON.stringify(proposal) });
  expect(denied.status).toBe(403);
  f.config.readOnly = true;
  const readOnly = await fetch(`${f.url}${suggestionsPath}`, { method: "POST", headers: f.headers(), body: JSON.stringify(proposal) });
  expect(readOnly.status).toBe(403);
  await expect(readFile(join(f.wiki.root, proposal.destination.path))).rejects.toMatchObject({ code: "ENOENT" });
});
