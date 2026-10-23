import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ViewRecordSchema, WikiDataResultSchema, type ViewInput } from "@legalwork/types/views";
import { Database } from "bun:sqlite";
import { startServer } from "./server.js";
import { TokenService } from "./tokens.js";
import { WikiSuggestionSchema } from "@legalwork/types/wiki-suggestions";
import { WikiSuggestions } from "./wiki/suggestions.js";
import { WikiStore } from "./wiki/store.js";
import { registerLocalProject } from "./routes/workspaces.js";
import { runtimeDbPath } from "./runtime-db.js";
import { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "./wiki/agent-access.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [], roots: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-wiki-api-"));
  roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "wiki-collaborator", hostToken: "wiki-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [], authorizedRoots: [], readOnly,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const tokens = new TokenService(config), viewer = await tokens.create("viewer"), owner = await tokens.create("owner");
  const server = await startServer(config);
  stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const request = (path: string, scope: "host" | "owner" | "collaborator" | "viewer" | "anonymous" = "host", method = "GET", body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (scope === "host") { headers["x-legalwork-host-token"] = config.hostToken; headers.authorization = `Bearer ${config.token}`; }
    else if (scope !== "anonymous") headers.authorization = `Bearer ${scope === "owner" ? owner.token : scope === "viewer" ? viewer.token : config.token}`;
    return fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { request, root, config, base };
}
const wikiSchema = z.object({ wiki: z.object({ id: z.string(), root: z.string(), workspaceId: z.string(), writable: z.boolean() }) });
const documentSchema = z.object({ path: z.string(), content: z.string(), revision: z.string(), updatedAt: z.number() });

describe("Wiki HTTP API", () => {

  test("pending contributions aggregate projects without publishing drafts or exposing them to wiki agents", async () => {
    const { request, config, root, base } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Inbox", template: "blank" })).json());
    const { wiki: otherWiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Other", template: "blank" })).json());
    const a = (await registerLocalProject(config, { folderPath: join(root, "a"), name: "Project A", preset: "starter" })).workspace;
    const b = (await registerLocalProject(config, { folderPath: join(root, "b"), name: "Project B", preset: "starter" })).workspace;
    expect((await request(`/wikis/${wiki.id}`, "owner", "PATCH", { allowInProjects: true })).status).toBe(200);
    const input = { title: "Contribution", content: "# Confidential draft", destination: { wikiId: wiki.id, path: "Draft.md", baseRevision: null } };
    const first = WikiSuggestionSchema.parse(await (await request(`/workspace/${a.id}/wiki-suggestions`, "owner", "POST", input)).json());
    const second = WikiSuggestionSchema.parse(await (await request(`/workspace/${b.id}/wiki-suggestions`, "owner", "POST", { ...input, destination: { ...input.destination, path: "Second.md" } })).json());
    await new WikiSuggestions(a.path, a.id).create({ ...input, destination: { ...input.destination, wikiId: otherWiki.id } }, null);
    const inbox = z.object({ items: z.array(WikiSuggestionSchema.omit({ content: true }).extend({ projectName: z.string(), changes: z.object({ added: z.number(), removed: z.number() }) })), unavailableProjects: z.array(z.string()) });
    const endpoint = `/wikis/${wiki.id}/suggestions`;
    const result = inbox.parse(await (await request(endpoint, "owner")).json());
    expect(result.items.map(item => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(result.items.map(item => item.projectName).sort()).toEqual(["Project A", "Project B"]);
    expect(result.unavailableProjects).toEqual([]);
    expect(result.items.map(item => item.changes)).toEqual([{ added: 1, removed: 0 }, { added: 1, removed: 0 }]);
    expect((await request(`/wikis/${wiki.id}/page?path=Draft.md`)).status).toBe(404);
    expect((await request(endpoint, "viewer")).status).toBe(404);
    expect((await request(endpoint, "anonymous")).status).toBe(401);
    const token = await ensureWikiAgentToken(config);
    await grantWikiAgentSession(config, { sessionId: "wiki-inbox-agent", directory: wiki.root, scope: "owner" });
    expect((await fetch(`${base}${endpoint}`, { headers: { "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": "wiki-inbox-agent", "x-legalwork-wiki-agent-directory": encodeURIComponent(wiki.root) } })).status).toBe(403);
    expect((await request(`/workspace/${a.id}/wiki-suggestions/${first.id}/dismiss`, "owner", "POST", { revision: first.revision })).status).toBe(200);
    expect((await request(`/workspace/${b.id}/wiki-suggestions/${second.id}/save`, "owner", "POST", { revision: second.revision })).status).toBe(200);
    expect(inbox.parse(await (await request(endpoint, "owner")).json()).items).toEqual([]);
    expect(documentSchema.parse(await (await request(`/wikis/${wiki.id}/page?path=Second.md`)).json()).content).toBe(input.content);
  });

  test("historical content is read-only, path-bound and protected by wiki permissions", async () => {
    const { request } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Versions", template: "blank" })).json());
    const base = `/wikis/${wiki.id}`, path = "Page.md";
    const original = documentSchema.parse(await (await request(`${base}/page`, "owner", "PUT", { path, content: "# Before\n", baseRevision: null })).json());
    const updated = documentSchema.parse(await (await request(`${base}/page`, "owner", "PUT", { path, content: "# After\n", baseRevision: original.revision })).json());
    const history = z.object({ items: z.array(z.object({ id: z.string(), changes: z.object({ added: z.number(), removed: z.number() }) })) }).parse(await (await request(`${base}/history?path=${path}`)).json());
    expect(history.items[0].changes).toEqual({ added: 1, removed: 1 });
    expect(history.items.at(-1)!.changes).toEqual({ added: 1, removed: 0 });
    const revisionId = history.items.at(-1)!.id;
    const endpoint = `${base}/history/${revisionId}?path=${path}`;
    expect(documentSchema.parse(await (await request(endpoint, "owner")).json()).content).toBe(original.content);
    expect(documentSchema.parse(await (await request(`${base}/page?path=${path}`)).json()).content).toBe(updated.content);
    expect((await request(endpoint, "viewer")).status).toBe(404);
    expect((await request(endpoint, "anonymous")).status).toBe(401);
    expect((await request(`${base}/history/${revisionId}?path=Other.md`)).status).toBe(404);
    expect((await request(`${base}/history/${revisionId}?path=../escape.md`)).status).toBe(400);
    await request(`${base}/page`, "owner", "DELETE", { path, baseRevision: updated.revision });
    expect(documentSchema.parse(await (await request(endpoint, "owner")).json()).content).toBe(original.content);
  });
  test("a blank wiki saves dashboards as renderable views in Dashboards", async () => {
    const { request } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Minimal", template: "blank" })).json());
    const input: ViewInput = { version: 1, title: "Overview", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Overview")', queries: {} };
    const response = await request(`/wikis/${wiki.id}/ui-views`, "owner", "POST", input);
    expect(response.status).toBe(201);
    const saved = ViewRecordSchema.parse(await response.json());
    const list = z.object({ items: z.array(z.object({ id: z.string(), path: z.string() })) }).parse(await (await request(`/wikis/${wiki.id}/ui-views`, "owner")).json());
    expect(list.items).toContainEqual({ id: saved.id, path: `Dashboards/${saved.id}.view.json` });
    expect(ViewRecordSchema.parse(await (await request(`/wikis/${wiki.id}/ui-views/${saved.id}`, "owner")).json()).program).toBe(input.program);
  });
  test("typed queries and frozen reports retain wiki authorization and revision checks", async () => {
    const { request, config } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Views", template: "blank" })).json());
    const base = `/wikis/${wiki.id}`;
    const page = documentSchema.parse(await (await request(`${base}/page`, "owner", "PUT", { path: "Client.md", content: "---\ntype: client\namount: 0\nactive: false\n---\n# Client\n", baseRevision: null })).json());
    for (const path of ["fields", "ui-views"]) expect((await request(`${base}/${path}`, "viewer")).status).toBe(404);
    const query = { fields: ["amount", "active"], pageType: "client" };
    expect((await request(`${base}/query`, "viewer", "POST", query)).status).toBe(404);
    const data = WikiDataResultSchema.parse(await (await request(`${base}/query`, "owner", "POST", query)).json());
    expect(data.rows[0]).toMatchObject({ path: "Client.md", amount: 0, active: false });
    const input: ViewInput = { version: 1, title: "Client report", mode: "report", catalog: "legalwork-1", program: 'root = Text("Client report")', queries: { clients: query } };
    const view = ViewRecordSchema.parse(await (await request(`${base}/ui-views`, "owner", "POST", input)).json());
    expect(view.datasets?.clients.rows[0].amount).toBe(0);
    expect((await request(`/workspace/${wiki.workspaceId}/ui-views`, "owner")).status).toBe(403);
    await request(`${base}/page`, "owner", "PUT", { path: page.path, content: page.content.replace("amount: 0", "amount: 50"), baseRevision: page.revision });
    const frozen = ViewRecordSchema.parse(await (await request(`${base}/ui-views/${view.id}`, "owner")).json());
    expect(frozen.datasets?.clients.rows[0].amount).toBe(0);
    expect(WikiDataResultSchema.parse(await (await request(`${base}/query`, "owner", "POST", query)).json()).rows[0].amount).toBe(50);
    expect((await request(`${base}/ui-views/${view.id}`, "owner", "PUT", { baseRevision: "stale", input })).status).toBe(409);
    config.readOnly = true;
    expect((await request(`${base}/ui-views`, "owner", "POST", input)).status).toBe(403);
  });

  test("agents can read their project views but only humans can persist them", async () => {
    const { request, config, root, base } = await fixture();
    const { workspace: project } = await registerLocalProject(config, { folderPath: join(root, "project-a"), name: "A", preset: "starter" });
    const { workspace: other } = await registerLocalProject(config, { folderPath: join(root, "project-b"), name: "B", preset: "starter" });
    const token = await ensureWikiAgentToken(config);
    await grantWikiAgentSession(config, { sessionId: "view-agent", directory: project.path, scope: "owner" });
    const headers = { "content-type": "application/json", "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": "view-agent", "x-legalwork-wiki-agent-directory": encodeURIComponent(project.path) };
    const input: ViewInput = { version: 1, title: "Private report", mode: "report", catalog: "legalwork-1", program: 'root = Text("Project review")', queries: {} };
    const response = await fetch(`${base}/workspace/${project.id}/ui-views`, { method: "POST", headers, body: JSON.stringify(input) });
    expect(response.status).toBe(403);
    const view = ViewRecordSchema.parse(await (await request(`/workspace/${project.id}/ui-views`, "owner", "POST", input)).json());
    expect((await fetch(`${base}/workspace/${project.id}/ui-views/${view.id}`, { headers })).status).toBe(200);
    expect(view.owner).toEqual({ kind: "workspace", id: project.id });
    expect((await fetch(`${base}/workspace/${other.id}/ui-views`, { headers })).status).toBe(403);
    expect((await request(`/workspace/${project.id}/ui-views/${view.id}`, "viewer", "PUT", { baseRevision: view.revision, input })).status).toBe(403);
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Private wiki" })).json());
    expect((await fetch(`${base}/workspace/${wiki.workspaceId}/ui-views`, { headers })).status).toBe(403);
    const { workspace: child } = await registerLocalProject(config, { folderPath: join(project.path, "nested"), name: "Nested", preset: "starter" });
    await grantWikiAgentSession(config, { sessionId: "child-agent", directory: child.path, scope: "owner" });
    const childHeaders = { ...headers, "x-legalwork-wiki-agent-session": "child-agent", "x-legalwork-wiki-agent-directory": encodeURIComponent(child.path) };
    expect((await fetch(`${base}/workspace/${project.id}/ui-views`, { headers: childHeaders })).status).toBe(403);
    expect((await fetch(`${base}/workspace/${project.id}/ui-views`, { method: "POST", headers: childHeaders, body: JSON.stringify(input) })).status).toBe(403);
    expect((await fetch(`${base}/workspace/${project.id}/ui-views/${view.id}`, { method: "PUT", headers: childHeaders, body: JSON.stringify({ baseRevision: view.revision, input }) })).status).toBe(403);
    expect((await fetch(`${base}/workspace/${child.id}/ui-views`, { method: "POST", headers: childHeaders, body: JSON.stringify(input) })).status).toBe(403);
  });

  test("compact graph and revision endpoints retain private wiki authorization", async () => {
    const { request } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Private graph" })).json());
    for (const suffix of ["graph", "graph/revision"]) {
      const path = `/wikis/${wiki.id}/${suffix}`;
      expect((await request(path, "anonymous")).status).toBe(401);
      expect((await request(path, "collaborator")).status).toBe(404);
      expect((await request(path, "viewer")).status).toBe(404);
      expect((await request(path, "owner")).status).toBe(200);
    }
    const graph = z.object({ kind: z.literal("snapshot"), revision: z.string(), nodes: z.array(z.object({ id: z.string(), path: z.string(), title: z.string(), type: z.string() })) }).parse(await (await request(`/wikis/${wiki.id}/graph`, "owner")).json());
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(await (await request(`/wikis/${wiki.id}/graph?revision=${encodeURIComponent(graph.revision)}`, "owner")).json()).toEqual({ kind: "unchanged", revision: graph.revision });
    expect((await request(`/wikis/${wiki.id}/graph?revision=${"x".repeat(201)}`, "owner")).status).toBe(400);
  });

  test("explorer actions require wiki access and revisions, and expose recoverable trash", async () => {
    const { request, config } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Explorer", template: "blank" })).json());
    const entries = `/wikis/${wiki.id}/entries`;
    const create = { action: "create-folder", path: "Notes/Empty" };
    expect((await request(entries, "anonymous", "POST", create)).status).toBe(401);
    expect((await request(entries, "collaborator", "POST", create)).status).toBe(404);
    expect((await request(entries, "viewer", "POST", create)).status).toBe(404);
    expect((await request(entries, "owner", "POST", create)).status).toBe(200);
    expect((await request(entries, "owner", "POST", { action: "create-folder", path: "../Outside" })).status).toBe(400);
    expect((await request(entries, "owner", "POST", { action: "move", path: "Notes", destination: "Moved" })).status).toBe(400);
    const shape = z.object({ path: z.string(), kind: z.literal("folder"), revision: z.string() });
    const entry = shape.parse(await (await request(`/wikis/${wiki.id}/entry?path=Notes`, "owner")).json());
    expect((await request(entries, "owner", "POST", { action: "trash", path: "Notes", baseRevision: "stale" })).status).toBe(409);
    expect((await request(entries, "owner", "POST", { action: "trash", path: entry.path, baseRevision: entry.revision })).status).toBe(200);
    expect((await request(`/wikis/${wiki.id}/trash`, "viewer")).status).toBe(404);
    const trash = z.object({ items: z.array(z.object({ id: z.string(), path: z.string() })) }).parse(await (await request(`/wikis/${wiki.id}/trash`, "owner")).json());
    expect(trash.items[0].path).toBe("Notes");
    config.readOnly = true;
    expect((await request(entries, "owner", "POST", { action: "restore", trashId: trash.items[0].id })).status).toBe(403);
    config.readOnly = false;
    expect((await request(entries, "owner", "POST", { action: "restore", trashId: trash.items[0].id })).status).toBe(200);
    const snapshot = z.object({ folders: z.array(z.string()) }).parse(await (await request(`/wikis/${wiki.id}`, "owner")).json());
    expect(snapshot.folders).toContain("Notes/Empty");
  });

  test("hides personal wiki schedules and inbox entries while retaining ordinary project results", async () => {
    const { request, config, root } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Private schedules" })).json());
    const project = (await registerLocalProject(config, { folderPath: join(root, "Project"), name: "Ordinary project", preset: "starter" })).workspace;
    const input = { title: "Review", prompt: "Review this folder", sessionId: null,
      schedule: { kind: "once", startAt: new Date(Date.now() + 86400000).toISOString(), timeZone: "Europe/Berlin" } };
    const scheduled = z.object({ task: z.object({ id: z.string(), revision: z.number() }) });
    const privateTask = scheduled.parse(await (await request(`/workspace/${wiki.workspaceId}/scheduled-tasks`, "owner", "POST", input)).json()).task;
    const projectTask = scheduled.parse(await (await request(`/workspace/${project.id}/scheduled-tasks`, "collaborator", "POST", input)).json()).task;
    const db = new Database(join(root, "inbox-fixture.sqlite"));
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);");
    db.query("INSERT INTO session VALUES (?, ?, ?, NULL)").run("private-chat", wiki.root, Date.now());
    db.query("INSERT INTO session VALUES (?, ?, ?, NULL)").run("project-chat", project.path, Date.now());
    const previousDb = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = join(root, "inbox-fixture.sqlite");
    const tasks = z.object({ tasks: z.array(z.object({ id: z.string(), workspaceId: z.string() })) });
    const projects = z.object({ projects: z.array(z.object({ id: z.string() })) });
    const inbox = z.object({ sessions: z.array(z.object({ sessionId: z.string(), workspaceId: z.string() })) });
    try {
      expect(tasks.parse(await (await request("/scheduled-tasks", "owner")).json()).tasks.map(item => item.id)).toContain(privateTask.id);
      expect(projects.parse(await (await request("/scheduled-tasks/projects", "owner")).json()).projects.map(item => item.id)).toContain(wiki.workspaceId);
      expect(inbox.parse(await (await request("/session-inbox", "owner")).json()).sessions.map(item => item.sessionId)).toContain("private-chat");
      const groupBatch = `/session-groups/events?${new URLSearchParams({ cursors: JSON.stringify({ [wiki.workspaceId]: null, [project.id]: null }) })}`;
      const groups = z.object({ items: z.array(z.object({ workspaceId: z.string() })) });
      expect(groups.parse(await (await request(groupBatch, "owner")).json()).items.map(item => item.workspaceId)).toContain(wiki.workspaceId);
      const actors: Array<"collaborator" | "viewer"> = ["collaborator", "viewer"];
      for (const actor of actors) {
        expect(tasks.parse(await (await request("/scheduled-tasks", actor)).json()).tasks.map(item => item.id)).toEqual([projectTask.id]);
        expect(projects.parse(await (await request("/scheduled-tasks/projects", actor)).json()).projects.map(item => item.id)).toEqual([project.id]);
        expect(inbox.parse(await (await request("/session-inbox", actor)).json()).sessions.map(item => item.sessionId)).toEqual(["project-chat"]);
        expect(groups.parse(await (await request(groupBatch, actor)).json()).items.map(item => item.workspaceId)).toEqual([project.id]);
        expect((await request(`/workspace/${wiki.workspaceId}/scheduled-tasks/${privateTask.id}`, actor)).status).toBe(404);
      }
      expect((await request(`/workspace/${wiki.workspaceId}/scheduled-tasks`, "collaborator", "POST", input)).status).toBe(404);
      expect((await request(`/workspace/${wiki.workspaceId}/scheduled-tasks/${privateTask.id}`, "collaborator", "PATCH", { revision: privateTask.revision, status: "paused" })).status).toBe(404);
      expect((await request(`/workspace/${wiki.workspaceId}/scheduled-tasks/${privateTask.id}`, "collaborator", "DELETE", { revision: privateTask.revision })).status).toBe(404);
    } finally {
      if (previousDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previousDb;
      db.close();
    }
  });

  test("keeps wiki sharing separate from project sync and guards programmatic project registration", async () => {
    const { request, config, root } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Independent wiki" })).json());
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await request(`/workspace/${wiki.workspaceId}/project/sync`, "owner", method, method === "PUT" ? {} : undefined);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "wiki_project_sync" });
    }
    for (const folderPath of [wiki.root, join(wiki.root, "Nested project")]) {
      await expect(registerLocalProject(config, { folderPath, name: "Cannot expose the wiki", preset: "starter" })).rejects.toMatchObject({ code: "wiki_workspace_overlap" });
    }
    expect(config.workspaces.find(item => item.id === wiki.workspaceId)?.preset).toBe("wiki");
    const project = (await registerLocalProject(config, { folderPath: join(root, "Project"), name: "Separate project", preset: "starter" })).workspace;
    expect((await request(`/workspace/${project.id}/project/sync`, "collaborator")).status).toBe(200);
    expect((await request(`/workspace/${wiki.workspaceId}/project`, "owner")).status).toBe(200);
  });

  test("a scheduled run replaces a prior owner origin with collaborator scope before prompting", async () => {
    const { request, config, root, base } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "owner", "POST", { name: "Private scheduled knowledge" })).json());
    expect((await request(`/wikis/${wiki.id}`, "owner", "PATCH", { allowInProjects: true })).status).toBe(200);
    const project = (await registerLocalProject(config, { folderPath: join(root, "Project"), name: "Scheduled project", preset: "starter" })).workspace;
    const token = await ensureWikiAgentToken(config), sessionId = "existing-owner-chat";
    await grantWikiAgentSession(config, { sessionId, directory: project.path, scope: "owner" });
    const headers = { "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": sessionId, "x-legalwork-wiki-agent-directory": encodeURIComponent(project.path) };
    expect((await fetch(`${base}/wikis/${wiki.id}/page?path=Instructions.md`, { headers })).status).toBe(200);
    let restartedBase = "", privateReadStatus: number | undefined;
    let ready = () => {};
    const serverReady = new Promise<void>(resolve => { ready = resolve; });
    const engine = Bun.serve({ port: 0, fetch: async req => {
      const path = new URL(req.url).pathname;
      if (path === "/agent") return Response.json([{ name: "legalwork-scheduled-project", permission: [{ permission: "*", pattern: "*", action: "deny" }] }]);
      if (path === "/session/status") return Response.json({});
      if (path === `/session/${sessionId}`) return Response.json({ id: sessionId, directory: project.path, time: {} });
      if (path === `/session/${sessionId}/prompt_async`) {
        await serverReady;
        privateReadStatus = (await fetch(`${restartedBase}/wikis/${wiki.id}/page?path=Instructions.md`, { headers })).status;
        return new Response(null, { status: 204 });
      }
      return Response.json({});
    } });
    try {
      project.baseUrl = `http://127.0.0.1:${engine.port}`;
      const stopInitial = stops.pop();
      if (!stopInitial) throw new Error("Expected the initial fixture server");
      await stopInitial();
      const store = await ScheduledTaskStore.open(runtimeDbPath(config));
      const due = Date.now() - 60000;
      const task = store.create(project.id, { title: "Scheduled review", prompt: "Read available knowledge", sessionId,
        schedule: { kind: "once", startAt: new Date(due).toISOString(), timeZone: "Europe/Berlin" } }, due - 60000);
      const server = await startServer(config);
      stops.push(() => server.stop());
      restartedBase = `http://127.0.0.1:${server.port}`;
      ready();
      for (let attempt = 0; attempt < 200 && store.runs(task.id)[0]?.status !== "sent"; attempt++) await Bun.sleep(10);
      expect(store.runs(task.id)[0]?.status).toBe("sent");
      expect(privateReadStatus).toBe(404);
    } finally { ready(); engine.stop(true); }
  });

  test("enforces authentication, owner-only registration and personal wiki access through both API surfaces", async () => {
    const { request, config, base } = await fixture();
    expect((await request("/wikis", "anonymous")).status).toBe(401);
    expect((await request("/wikis", "collaborator", "POST", { name: "Denied" })).status).toBe(403);
    const created = await request("/wikis", "owner", "POST", { name: "Private wiki" });
    expect(created.status).toBe(201);
    const { wiki } = wikiSchema.parse(await created.json());
    expect(wiki.writable).toBe(true);
    expect((await request(`/wikis/${wiki.id}`, "host")).status).toBe(200);
    expect((await fetch(`${base}/wikis/${wiki.id}`, { headers: { "x-legalwork-host-token": config.hostToken } })).status).toBe(200);
    expect((await fetch(`${base}/wikis/${wiki.id}`, { headers: { authorization: `Bearer ${config.token}`, "x-legalwork-host-token": "invalid-host-token" } })).status).toBe(404);
    expect((await request(`/wikis/${wiki.id}`, "collaborator")).status).toBe(404);
    expect((await request(`/wikis/${wiki.id}/page?path=Instructions.md`, "viewer")).status).toBe(404);
    expect(await (await request("/wikis", "viewer")).json()).toEqual({ items: [] });
    expect((await request(`/workspace/${wiki.workspaceId}/files/raw?path=Instructions.md`, "collaborator")).status).toBe(404);
    expect((await request(`/workspace/${wiki.workspaceId}/files/raw?path=Instructions.md`, "owner")).status).toBe(200);
    expect((await request("/workspaces/local", "host", "POST", { folderPath: wiki.root, name: "Cannot expose wiki as a project" })).status).toBe(409);
    expect((await request("/workspaces/local", "host", "POST", { folderPath: join(wiki.root, "Nested project"), name: "Nested" })).status).toBe(409);
    expect((await request(`/wikis/${wiki.id}`, "owner", "PATCH", { name: "Renamed" })).status).toBe(200);
    expect((await request(`/wikis/${wiki.id}`, "host", "DELETE")).status).toBe(200);
    expect(await readFile(join(wiki.root, "Instructions.md"), "utf8")).toContain("Working in this wiki");
  });

  test("round-trips Markdown and binary assets, rejects stale saves, and restores deleted pages", async () => {
    const { request } = await fixture();
    const { wiki } = wikiSchema.parse(await (await request("/wikis", "host", "POST", { name: "Editable" })).json());
    const base = `/wikis/${wiki.id}`, path = "Processes/Financing.md";
    const created = await request(`${base}/page`, "host", "PUT", { path, content: "# Financing\n\nEvidence [source](../Attachments/source.pdf).\n", baseRevision: null });
    expect(created.status).toBe(200);
    const original = documentSchema.parse(await created.json());
    expect((await request(`${base}/page`, "host", "PUT", { path, content: "Overwritten", baseRevision: null })).status).toBe(409);
    const saved = await request(`${base}/page`, "host", "PUT", { path, content: "# Updated financing\n", baseRevision: original.revision });
    expect(saved.status).toBe(200);
    const updated = documentSchema.parse(await saved.json());
    expect((await request(`${base}/page`, "host", "DELETE", { path, baseRevision: original.revision })).status).toBe(409);
    expect((await request(`${base}/page`, "host", "DELETE", { path, baseRevision: updated.revision })).status).toBe(200);
    const history = z.object({ items: z.array(z.object({ id: z.string(), path: z.string(), action: z.string() })) }).parse(await (await request(`${base}/history?path=${encodeURIComponent(path)}`)).json());
    expect(history.items[0].action).toBe("delete");
    const first = history.items[history.items.length - 1];
    const restored = await request(`${base}/restore`, "host", "POST", { path, revisionId: first.id, baseRevision: null });
    expect(restored.status).toBe(200);
    expect(documentSchema.parse(await restored.json()).content).toBe(original.content);
    const bytes = Buffer.from([0, 128, 255, 80, 75]), assetPath = "Attachments/source.pdf";
    expect((await request(`${base}/asset`, "host", "POST", { path: assetPath, dataBase64: bytes.toString("base64"), baseRevision: null })).status).toBe(200);
    const asset = await request(`${base}/asset?path=${encodeURIComponent(assetPath)}`);
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(bytes);
    expect((await request(`${base}/asset`, "host", "POST", { path: "../escape.pdf", dataBase64: "AQ==" })).status).toBe(400);
    expect((await request(`${base}/asset`, "host", "POST", { path: "Attachments/bad.pdf", dataBase64: "!!!" })).status).toBe(400);
    const search = z.object({ items: z.array(z.object({ path: z.string() })) }).parse(await (await request(`${base}/search?q=Financing`)).json());
    expect(search.items.some((item) => item.path === path)).toBe(true);
  });

  test("legacy bindings remain local and cannot expose wiki contents through project storage", async () => {
    const { request, config } = await fixture();
    const store = new WikiStore(config);
    const wiki = await store.create({ name: "Legacy", attach: true, sync: { workspaceId: "origin-project", connectionId: "old-connection", path: "Shared knowledge" } });
    await store.write(wiki.id, "Shared.md", "# Retained local knowledge", "");
    await store.close();
    const base = `/wikis/${wiki.id}`;
    expect((await request(base, "viewer")).ok).toBe(false);
    expect((await request(`${base}/page`, "collaborator", "PUT", { path: "Denied.md", content: "# Denied", baseRevision: null })).ok).toBe(false);
    expect((await request(`${base}/page?path=Shared.md`, "owner")).status).toBe(200);
    expect(await (await request("/wikis", "viewer")).json()).toEqual({ items: [] });
    expect((await request("/wikis", "owner", "POST", { name: "No project bindings", sync: { workspaceId: "project", connectionId: "storage", path: "Knowledge" } })).status).toBe(400);
    expect((await request(base, "owner", "PATCH", { sync: null })).status).toBe(400);
  });

  test("team sharing has global endpoints and requires a firm account, without selecting a project", async () => {
    const { request, config } = await fixture();
    expect(config.workspaces).toHaveLength(0);
    expect((await request("/wikis/team", "viewer")).status).toBe(403);
    expect((await request("/wikis/team", "owner")).ok).toBe(false);
    expect((await request("/wikis", "owner", "POST", { name: "Firm Wiki", sharing: { access: "org", memberIds: [] } })).ok).toBe(false);
    expect(await (await request("/wikis", "owner")).json()).toEqual({ items: [] });
    expect((await request("/wikis/join", "collaborator", "POST", { wikiId: "cbb04c84-15f4-4a2b-a9f7-a5bd00d4a919" })).status).toBe(403);
  });

  test("server read-only mode blocks registration even for the owner", async () => {
    const { request } = await fixture(true);
    expect((await request("/wikis", "host", "POST", { name: "Read only" })).status).toBe(403);
  });
});
