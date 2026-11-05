import { nativePluginTools } from "./native-plugin-test-support.js";
import { nativeToolBefore } from "./native-plugin-test-support.js";
const LegalWorkWikiTools = (context = {}) => nativePluginTools(LegalWorkWikiToolsDefinition, context);
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ViewPreviewSchema } from "@legalwork/types/views";
import { startServer } from "../server.js";
import { serve } from "../serve-node.js";
import { WikiStore } from "../wiki/store.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "../wiki/agent-access.js";
import { listApprovals } from "../wiki/approval.test-helpers.js";
import type { ServerConfig } from "../types.js";
import LegalWorkWikiToolsDefinition from "./legalwork-wiki-tools.js";

const previewResult = z.object({ metadata: z.object({ legalworkViewPreview: ViewPreviewSchema }) }).transform(result => result.metadata.legalworkViewPreview);

const previousUrl = process.env.LEGALWORK_SERVER_URL;
const previousToken = process.env.LEGALWORK_SERVER_TOKEN;
const previousAgentToken = process.env.LEGALWORK_WIKI_AGENT_TOKEN;
const stops: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
  else process.env.LEGALWORK_SERVER_URL = previousUrl;
  if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
  else process.env.LEGALWORK_SERVER_TOKEN = previousToken;
  if (previousAgentToken === undefined) delete process.env.LEGALWORK_WIKI_AGENT_TOKEN;
  else process.env.LEGALWORK_WIKI_AGENT_TOKEN = previousAgentToken;
});

test("an agent captures an authorized source into real Markdown through the server API", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-wiki-agent-http-"));
  roots.push(root);
  const project = join(root, "matter");
  await mkdir(project);
  const sourcePath = join(project, "Closing note.md");
  await writeFile(sourcePath, "# Closing note\n\nThe practice team used a closing checklist. An incomplete signature delayed closing.\n");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "wiki-agent-client", hostToken: "wiki-agent-host",
    configPath: join(root, "configuration", "server.json"), approval: { mode: "auto", timeoutMs: 5000 }, corsOrigins: ["*"],
    workspaces: [{ id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  const agentToken = await ensureWikiAgentToken(config);
  await grantWikiAgentSession(config, { sessionId: "session-capture", directory: project, scope: "owner" });
  const server = await startServer(config);
  stops.push(async () => { await server.stop(); });
  const url = `http://127.0.0.1:${server.port}`;
  const approved = async (result: Promise<string>, _action: string) => {
    const raw = await result;
    const response = JSON.parse(raw);
    if (!response.suggestion) return raw;
    const draft = response.suggestion;
    const reviewed = await fetch(`${url}/workspace/matter/wiki-suggestions/${draft.id}/save`, { method: "POST", headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" }, body: JSON.stringify({ revision: draft.revision }) });
    const saved = await reviewed.json();
    if (!reviewed.ok) return JSON.stringify(saved);
    const page = await fetch(`${url}/wikis/${draft.destination.wikiId}/page?path=${encodeURIComponent(draft.destination.path)}`, { headers: { "x-legalwork-host-token": config.hostToken } });
    return JSON.stringify({ ok: true, ...await page.json() });
  };
  process.env.LEGALWORK_SERVER_URL = url;
  process.env.LEGALWORK_SERVER_TOKEN = config.token;
  process.env.LEGALWORK_WIKI_AGENT_TOKEN = agentToken;
  const headers = { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" };
  const created = await fetch(`${url}/wikis`, { method: "POST", headers,
    body: JSON.stringify({ name: "Practice knowledge", root: join(root, "knowledge"), template: "firm" }) });
  expect(created.status).toBe(201);
  const { wiki } = z.object({ wiki: z.object({ id: z.string(), root: z.string() }) }).parse(await created.json());
  const { tool } = await LegalWorkWikiTools({ directory: project, sessionID: "session-capture" });
  // Preview chunks are ephemeral and scoped to the authenticated originating session.
  const streamAbort = new AbortController();
  const previewUrl = `${url}/workspace/matter/view-generations/session-capture`;
  const preview = await fetch(previewUrl, { headers, signal: streamAbort.signal });
  expect(preview.status).toBe(200);
  const reader = preview.body!.getReader();
  await reader.read(); // connected comment
  const agentHeaders = { "Content-Type": "application/json", "x-legalwork-wiki-agent-token": agentToken,
    "x-legalwork-wiki-agent-session": "session-capture", "x-legalwork-wiki-agent-directory": encodeURIComponent(project) };
  const chunk = { callId: "preview-call", tool: "view_create", raw: '{"input":{"program":"root = Stack(' };
  expect((await fetch(previewUrl, { method: "POST", headers, body: JSON.stringify(chunk) })).status).toBe(403);
  expect((await fetch(previewUrl.replace("session-capture", "other-session"), { method: "POST", headers: agentHeaders, body: JSON.stringify(chunk) })).status).toBe(403);
  expect((await fetch(previewUrl, { method: "POST", headers: agentHeaders, body: JSON.stringify(chunk) })).status).toBe(200);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(JSON.stringify(chunk));
  streamAbort.abort();
  await reader.cancel().catch(() => {});
  expect(await listApprovals(url, config.hostToken)).toEqual([]);
  const skills = JSON.parse(await tool.wiki_read.execute({ wiki_id: wiki.id, path: "Skills/wiki-capture/SKILL.md" }));
  expect(skills.content).toContain("Capture useful knowledge");
  expect(skills.guidance.some((entry: { path: string }) => entry.path === "AGENTS.md")).toBe(true);
  const guidance = JSON.parse(await tool.wiki_guidance.execute({ wiki_id: wiki.id }));
  expect(guidance.access_mode).toBe("suggestion");
  expect(guidance.guidance[0].content).toContain("Skills/wiki-capture/SKILL.md");
  expect(await listApprovals(url, config.hostToken)).toEqual([]);

  const proposal = "# General research finding\n\nA reusable finding with its scope, exceptions and public sources.\n";
  const proposed = JSON.parse(await tool.wiki_write.execute({ wiki_id: wiki.id, path: "Knowledge/Proposed finding.md", content: proposal, base_revision: null }));
  expect(proposed.staged).toBe(true);
  expect(await Bun.file(join(wiki.root, "Knowledge/Proposed finding.md")).exists()).toBe(false);
  expect((await fetch(`${url}/workspace/matter/wiki-suggestions/${proposed.suggestion.id}/dismiss`, { method: "POST", headers, body: JSON.stringify({ revision: proposed.suggestion.revision }) })).status).toBe(200);
  expect(await Bun.file(join(wiki.root, "Knowledge/Proposed finding.md")).exists()).toBe(false);
  await grantWikiAgentSession(config, { sessionId: "session-own-wiki", directory: wiki.root, scope: "owner" });
  const inside = (await LegalWorkWikiTools({ directory: wiki.root, sessionID: "session-own-wiki" })).tool;

  // A source read is required before capture. No model or remote document system
  // is simulated here: this fixture tests the actual tool -> HTTP -> file/index path.
  const source = await readFile(sourcePath, "utf8");
  expect(source).toContain("incomplete signature");
  const content = "---\ntype: process\nstatus: draft\n---\n# Closing checklist\n\nObserved in one closing: validate all signatures before closing.\n\n## Sources\nLocal authorized matter file: Closing note.md, Closing note section.\n\nSee [[Processes/Knowledge capture.md]].\n";
  const saved = JSON.parse(await approved(tool.wiki_write.execute({ wiki_id: wiki.id, path: "Processes/Closing checklist.md", content, base_revision: null }), "wiki.write"));
  expect(saved.ok).toBe(true);
  expect(await readFile(join(wiki.root, saved.path), "utf8")).toBe(content);
  const found = JSON.parse(await tool.wiki_search.execute({ wiki_id: wiki.id, query: "signatures", type: "process" }));
  expect(found.pages.some((page: { path: string }) => page.path === saved.path)).toBe(true);
  const opened = JSON.parse(await tool.wiki_read.execute({ wiki_id: wiki.id, path: saved.path }));
  const replacement = JSON.parse(await approved(tool.wiki_write.execute({ wiki_id: wiki.id, path: saved.path,
    content: content + "\nReview each signature block.\n", base_revision: opened.revision }), "wiki.write"));
  expect(replacement.ok).toBe(true);
  const stale = JSON.parse(await approved(tool.wiki_write.execute({ wiki_id: wiki.id, path: saved.path,
    content: "# Stale overwrite\n", base_revision: opened.revision }), "wiki.write"));
  expect(stale.code).toBe("wiki_revision_conflict");
  expect(await readFile(join(wiki.root, saved.path), "utf8")).toContain("Review each signature block");

  const patched = JSON.parse(await approved(inside.wiki_properties_update.execute({ wiki_id: wiki.id, path: saved.path,
    base_revision: replacement.revision, patch: { set: { status: "reviewed", score: 0 } } }), "wiki.properties.update"));
  expect(patched.content).toContain('status: "reviewed"');
  expect(patched.content).toContain("Review each signature block.");
  const fields = JSON.parse(await tool.wiki_fields.execute({ wiki_id: wiki.id }));
  expect(fields.fields.some((field: { id: string }) => field.id === "properties.score")).toBe(true);
  const query = { fields: ["title", "properties.status", "properties.score"], filters: [{ field: "properties.status", op: "eq", value: "reviewed" }] };
  const queried = JSON.parse(await tool.wiki_query.execute({ wiki_id: wiki.id, query }));
  expect(queried.sourceOwner).toEqual({ kind: "wiki", id: wiki.id });
  expect(queried.rows).toEqual([
    { path: saved.path, title: "Closing checklist", "properties.status": "reviewed", "properties.score": 0 },
  ]);
  expect(JSON.parse(await tool.view_catalog.execute({})).components.Board).toContain("Board");
  const input = { version: 1, title: "Closing review", mode: "report", catalog: "legalwork-1", program: 'root = Text("Closing review")', queries: {} };
  const { content_is_data, ...dataset } = queried;
  expect(content_is_data).toBe(true);
  const projectPreview = previewResult.parse(await tool.view_create.executeResult({ input: { ...input, datasets: { reviewed: dataset } } }));
  expect(projectPreview.status).toBe("preview");
  expect(projectPreview.owner).toEqual({ kind: "workspace", id: "matter" });
  expect(projectPreview.input.datasets?.reviewed.sourceOwner).toEqual({ kind: "wiki", id: wiki.id });
  expect(projectPreview).not.toHaveProperty("id");
  expect(JSON.parse(await tool.view_list.execute({})).items).toEqual([]);
  const longValue = "x".repeat(60_000);
  const large = await tool.view_create.executeResult({ input: { ...input, datasets: { large: { rows: [{ value: longValue }], total: 1, revision: "large", asOf: 1, truncated: false } } } });
  expect(JSON.stringify(large.content).length).toBeLessThan(1_000);
  expect(previewResult.parse(large).input.datasets?.large.rows[0].value).toBe(longValue);

  expect((await fetch(`${url}/workspace/matter/ui-views`, { method: "POST", headers: agentHeaders, body: JSON.stringify(input) })).status).toBe(403);
  const projectSave = await fetch(`${url}/workspace/matter/ui-views`, { method: "POST", headers, body: JSON.stringify(projectPreview.input) });
  expect(projectSave.status).toBe(201);
  const projectReport = await projectSave.json();
  expect(JSON.parse(await tool.view_list.execute({})).items.map((view: { id: string }) => view.id)).toContain(projectReport.id);
  const wikiOwner = { kind: "wiki", id: wiki.id };
  const reportPreview = previewResult.parse(await inside.view_create.executeResult({ owner: wikiOwner, input: { ...input, queries: { reviewed: query } } }));
  expect(reportPreview.status).toBe("preview");
  expect(reportPreview.input.datasets?.reviewed.rows[0]["properties.score"]).toBe(0);
  expect(JSON.parse(await inside.view_list.execute({ owner: wikiOwner })).items).toEqual([]);
  expect((await fetch(`${url}/wikis/${wiki.id}/ui-views`, { method: "POST", headers: agentHeaders, body: JSON.stringify(input) })).status).toBe(403);
  const wikiSave = await fetch(`${url}/wikis/${wiki.id}/ui-views`, { method: "POST", headers, body: JSON.stringify(reportPreview.input) });
  expect(wikiSave.status).toBe(201);
  const report = await wikiSave.json();
  const reread = JSON.parse(await tool.view_read.execute({ owner: wikiOwner, view_id: report.id }));
  expect(reread.revision).toBe(report.revision);
  const updated = previewResult.parse(await inside.view_update.executeResult({ owner: wikiOwner, view_id: report.id,
    base_revision: report.revision, input: { ...reportPreview.input, title: "Reviewed closing" } }));
  expect(updated.status).toBe("preview");
  expect(updated.input.title).toBe("Reviewed closing");
  expect(updated.target).toEqual({ viewId: report.id, baseRevision: report.revision });
  expect(JSON.parse(await tool.view_read.execute({ owner: wikiOwner, view_id: report.id })).title).toBe(report.title);
  const updateSave = await fetch(`${url}/wikis/${wiki.id}/ui-views/${report.id}`, { method: "PUT", headers, body: JSON.stringify({ input: updated.input, baseRevision: updated.target?.baseRevision }) });
  expect(updateSave.status).toBe(200);
  expect(JSON.parse(await inside.view_update.execute({ owner: wikiOwner, view_id: report.id, base_revision: report.revision, input })).code).toBe("view_revision_conflict");

  const controller = new AbortController();
  controller.abort();
  await expect(tool.wiki_write.execute({ wiki_id: wiki.id, path: "Cancelled.md", content: "# Cancelled proposal\n", base_revision: null }, { abort: controller.signal })).rejects.toThrow();
  expect(await Bun.file(join(wiki.root, "Cancelled.md")).exists()).toBe(false);

  const revoked = await fetch(`${url}/wikis/${wiki.id}`, { method: "PATCH", headers, body: JSON.stringify({ allowInProjects: false }) });
  expect(revoked.status).toBe(200);
  expect(JSON.parse(await tool.wiki_read.execute({ wiki_id: wiki.id, path: saved.path })).code).toBe("wiki_access_denied");
  await grantWikiAgentSession(config, { sessionId: "session-wiki", directory: wiki.root, scope: "owner" });
  const ownSession = await LegalWorkWikiTools({ directory: wiki.root, sessionID: "session-wiki" });
  expect(JSON.parse(await ownSession.tool.wiki_read.execute({ wiki_id: wiki.id, path: saved.path })).revision).toBe(patched.revision);
  await grantWikiAgentSession(config, { sessionId: "session-wiki", directory: wiki.root, scope: "collaborator" });
  const collaborator = JSON.parse(await ownSession.tool.wiki_read.execute({ wiki_id: wiki.id, path: saved.path }));
  expect(collaborator.ok).toBe(false);
  const unknown = await LegalWorkWikiTools({ directory: project, sessionID: "session-unknown" });
  expect(JSON.parse(await unknown.tool.wiki_list.execute({})).code).toBe("wiki_agent_session_unknown");
});

test("authenticated proxy session origin grants local wiki access and a collaborator prompt downgrades it", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-wiki-proxy-origin-"));
  roots.push(root);
  const project = join(root, "Prüfung 東京");
  await mkdir(project);
  const engine = await serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const session = (id: string) => ({ id, location: { directory: project }, title: "Matter", time: { created: 1, updated: 1 } });
    if (request.method === "GET" && path === "/api/plugin") return Response.json({ location: { directory: project }, data: [{ id: "legalwork.commands", state: { status: "active" } }] });
    if (request.method === "GET" && path === "/api/command") return Response.json({ location: { directory: project }, data: [{ name: "capture", description: "Capture the requested knowledge." }] });
    if (request.method === "POST" && path === "/api/session") return Response.json({ data: session("ses_http_origin") });
    if (request.method === "GET" && /^\/api\/session\/ses_http_(?:origin|fork)$/.test(path)) return Response.json({ data: session(path.split("/").at(-1)!) });
    if (request.method === "POST" && path === "/api/session/ses_http_origin/prompt") return Response.json({ data: { type: "user", id: "msg_fixture", payload: { text: "Continue" } } });
    if (request.method === "POST" && path === "/api/session/ses_http_origin/fork") return Response.json({ data: session("ses_http_fork") });
    return Response.json({ ok: true });
  } });
  stops.push(async () => { await engine.stop(); });
  const engineUrl = `http://127.0.0.1:${engine.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "origin-client", hostToken: "origin-host", opencodeBaseUrl: engineUrl,
    configPath: join(root, "configuration", "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [{ id: "origin-matter", name: "Matter", path: project, preset: "starter", workspaceType: "local", baseUrl: engineUrl }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  const store = new WikiStore(config);
  const wiki = await store.create({ name: "Personal knowledge", root: join(root, "wiki"), template: "blank" });
  await store.close();
  const runtimeToken = await ensureWikiAgentToken(config);
  const server = await startServer(config);
  stops.unshift(async () => { await server.stop(); });
  const url = `http://127.0.0.1:${server.port}`;
  const proxyPath = `${url}/workspace/origin-matter/opencode/session`;
  const query = new URLSearchParams({ "location[directory]": project });
  const created = await fetch(`${proxyPath}?${query}`, { method: "POST",
    headers: { "x-legalwork-host-token": config.hostToken, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Matter" }) });
  expect(created.status).toBe(200);
  expect(z.object({ data: z.object({ id: z.string() }) }).parse(await created.json()).data.id).toBe("ses_http_origin");
  process.env.LEGALWORK_SERVER_URL = url;
  process.env.LEGALWORK_SERVER_TOKEN = config.token;
  process.env.LEGALWORK_WIKI_AGENT_TOKEN = runtimeToken;
  const { tool } = await LegalWorkWikiTools({ directory: project, sessionID: "ses_http_origin" });
  const listed = JSON.parse(await tool.wiki_list.execute({}));
  expect(listed.wikis.some((entry: { id: string }) => entry.id === wiki.id)).toBe(true);
  expect(JSON.parse(await tool.wiki_read.execute({ wiki_id: wiki.id, path: "Structure.md" })).content).toContain("Wiki structure");

  const prompted = await fetch(`${proxyPath}/ses_http_origin/prompt?${query}`, { method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Continue" }) });
  expect(prompted.status).toBe(200);
  const denied = JSON.parse(await tool.wiki_read.execute({ wiki_id: wiki.id, path: "Structure.md" }));
  expect(denied.ok).toBe(false);
  expect(denied.code).toBe("wiki_access_denied");

  const hostCommand = await fetch(`${proxyPath}/ses_http_origin/command?${query}`, { method: "POST",
    headers: { "x-legalwork-host-token": config.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "capture", text: "" }) });
  expect(hostCommand.status).toBe(200);
  expect(JSON.parse(await tool.wiki_read.execute({ wiki_id: wiki.id, path: "Structure.md" })).content).toContain("Wiki structure");
  const forked = await fetch(`${proxyPath}/ses_http_origin/fork?${query}`, { method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "owner" }) });
  expect(forked.status).toBe(200);
  const forkId = z.object({ data: z.object({ id: z.string() }) }).parse(await forked.json()).data.id;
  const fork = await LegalWorkWikiTools({ directory: project, sessionID: forkId });
  expect(JSON.parse(await fork.tool.wiki_read.execute({ wiki_id: wiki.id, path: "Structure.md" })).code).toBe("wiki_access_denied");
  expect(JSON.parse(await tool.wiki_read.execute({ wiki_id: wiki.id, path: "Structure.md" })).code).toBe("wiki_access_denied");

  const narrow = await fetch(`${url}/tokens`, { headers: {
    "x-legalwork-wiki-agent-token": runtimeToken, "x-legalwork-wiki-agent-session": "ses_http_origin",
    "x-legalwork-wiki-agent-directory": encodeURIComponent(project),
  } });
  expect(narrow.status).toBe(404);
});
