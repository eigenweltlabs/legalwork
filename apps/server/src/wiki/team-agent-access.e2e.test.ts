import { nativeToolBefore } from "../opencode-plugins/native-plugin-test-support.js";
const LegalWorkWikiTools = (context = {}) => nativePluginTools(LegalWorkWikiToolsDefinition, context);
import { nativePluginTools } from "../opencode-plugins/native-plugin-test-support.js";
const LegalWorkStorageTools = (context = {}) => nativePluginTools(LegalWorkStorageToolsDefinition, context);
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PDFDocument } from "pdf-lib";
import { ViewRecordSchema, ViewPreviewSchema, type WikiDataResult } from "@legalwork/types/views";
import { startServer } from "../server.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import LegalWorkWikiToolsDefinition from "../opencode-plugins/legalwork-wiki-tools.js";
import LegalWorkStorageToolsDefinition from "../opencode-plugins/legalwork-storage-tools.js";
import { resolveWorkspaceId, workspaceToolHeaders } from "../opencode-plugins/office-plugin-shared.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "./agent-access.js";
import { listApprovals, respondApproval, waitForApprovals } from "./approval.test-helpers.js";
import { wikiTeamFixture } from "./team-test-helper.js";
import { AgentSandboxService } from "../agent-sandbox/service.js";
import { VmSandbox } from "../agent-sandbox/vm.js";
import { writeSandboxDefault } from "../agent-sandbox/settings.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { ApprovalService } from "../approvals.js";

const previewResult = z.object({ metadata: z.object({ legalworkViewPreview: ViewPreviewSchema }) }).transform(result => result.metadata.legalworkViewPreview);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const wikiResult = z.object({ wiki: z.object({ id: z.string(), root: z.string(), workspaceId: z.string(), sync: z.object({ wikiId: z.string() }) }) });
async function host(config: ServerConfig) {
  const server = await startServer(config);
  cleanup.push(async () => { await server.stop(); });
  const url = `http://127.0.0.1:${server.port}`;
  return { url, request: (path: string, method = "GET", body?: unknown) => fetch(`${url}${path}`, {
    method, headers: { "content-type": "application/json", "x-legalwork-host-token": config.hostToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) };
}

async function teamFlow(sandbox?: VmSandbox) {
  const cloud = await wikiTeamFixture(); cleanup.push(() => cloud.close());
  const owner = await cloud.account(), member = await cloud.account("member");
  member.config.approval.timeoutMs = 5000;
  const projectPath = join(cloud.root, "matter"); await mkdir(projectPath, { recursive: true });
  const project: WorkspaceInfo = { id: "matter", name: "Matter", path: await realpath(projectPath), preset: "starter", workspaceType: "local" };
  member.config.workspaces.push(project);
  member.config.authorizedRoots.push(project.path);
  const a = await host(owner.config), b = await host(member.config);
  const original = wikiResult.parse(await (await a.request("/wikis", "POST", { name: "Team agent fixture", template: "firm", sharing: { access: "members", memberIds: ["member"] } })).json()).wiki;
  expect((await a.request(`/wikis/${original.id}/page`, "PUT", { path: "Shared.md", content: "# Shared source\n", baseRevision: null })).status).toBe(200);
  await a.request(`/wikis/${original.id}/sync`, "POST");
  const wiki = wikiResult.parse(await (await b.request("/wikis/join", "POST", { wikiId: original.sync.wikiId })).json()).wiki;
  await b.request(`/wikis/${wiki.id}/sync`, "POST");
  const skills = await (await b.request(`/workspace/${wiki.workspaceId}/skills`)).json();
  expect(skills.items.filter((item: { name: string }) => item.name.startsWith("wiki-")).map((item: { name: string }) => item.name).sort()).toEqual(["wiki-capture", "wiki-maintain", "wiki-setup", "wiki-use"]);
  const setup = await (await b.request(`/workspace/${wiki.workspaceId}/skills/wiki-setup/composed`)).json();
  expect(setup.chain[0].content).toContain("do not crawl connected storage");
  expect(setup.chain[0].directory).toBe(join(wiki.root, "Skills/wiki-setup"));

  await b.request(`/wikis/${wiki.id}`, "PATCH", { allowInProjects: true, projectWorkspaceIds: [project.id] });
  const agentToken = await ensureWikiAgentToken(member.config);
  for (const [sessionId, directory] of [["matter-agent", project.path], ["wiki-agent", wiki.root]])
    await grantWikiAgentSession(member.config, { sessionId, directory, scope: "owner" });
  const previous = { LEGALWORK_SERVER_URL: process.env.LEGALWORK_SERVER_URL, LEGALWORK_SERVER_TOKEN: process.env.LEGALWORK_SERVER_TOKEN, LEGALWORK_WIKI_AGENT_TOKEN: process.env.LEGALWORK_WIKI_AGENT_TOKEN };
  Object.assign(process.env, { LEGALWORK_SERVER_URL: b.url, LEGALWORK_SERVER_TOKEN: member.config.token, LEGALWORK_WIKI_AGENT_TOKEN: agentToken });
  cleanup.push(async () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const outside = await LegalWorkWikiTools({ directory: project.path, sessionID: "matter-agent" });
  const inside = await LegalWorkWikiTools({ directory: wiki.root, sessionID: "wiki-agent" });
  expect(parseToolJson(await outside.tool.wiki_list.execute({})).wikis.map((item: { id: string }) => item.id)).toContain(wiki.id);
  expect(parseToolJson(await inside.tool.wiki_list.execute({})).current_wiki_id).toBe(wiki.id);
  for (const tools of [inside, outside]) {
    expect(parseToolJson(await tools.tool.wiki_read.execute({ wiki_id: wiki.id, path: "Shared.md" })).content).toContain("Shared source");
    expect(parseToolJson(await tools.tool.wiki_query.execute({ wiki_id: wiki.id, query: { fields: ["title"] } })).rows.some((row: { title: string }) => row.title === "Shared source")).toBe(true);
  }
  expect(await listApprovals(b.url, member.config.hostToken)).toEqual([]);
  const staged = parseToolJson(await outside.tool.wiki_write.execute({ wiki_id: wiki.id, path: "From-project.md", content: "# Approved project knowledge\n", base_revision: null }));
  expect(staged.staged).toBe(true);
  expect(staged.published).toBe(false);
  expect((await b.request(`/wikis/${wiki.id}/page?path=From-project.md`)).status).toBe(404);
  expect(await listApprovals(b.url, member.config.hostToken)).toEqual([]);
  expect(await readFile(join(project.path, staged.suggestion.filePath), "utf8")).toBe("# Approved project knowledge\n");
  expect((await b.request(`/workspace/${project.id}/wiki-suggestions/${staged.suggestion.id}/save`, "POST", { revision: staged.suggestion.revision })).status).toBe(200);
  expect(parseToolJson(await inside.tool.wiki_write.execute({ wiki_id: wiki.id, path: "From-wiki.md", content: "# Wiki knowledge\n", base_revision: null })).ok).toBe(true);
  expect(await listApprovals(b.url, member.config.hostToken)).toEqual([]);
  const view = previewResult.parse(await inside.tool.view_create.executeResult({ wiki_id: wiki.id, input: { version: 1, title: "Firm overview", mode: "dashboard", catalog: "legalwork-1", queries: {}, program: 'root = Text("No firm records reviewed yet")' } }));
  expect(view).not.toHaveProperty("error");
  expect(view.status).toBe("preview");
  expect((await (await b.request(`/wikis/${wiki.id}/ui-views`)).json()).items).toEqual([]);
  const savedView = ViewRecordSchema.parse(await (await b.request(`/wikis/${wiki.id}/ui-views`, "POST", view.input)).json());
  const views = await (await b.request(`/wikis/${wiki.id}/ui-views`)).json();
  expect(views.items.find((item: { id: string }) => item.id === savedView.id).path).toBe(`Dashboards/${savedView.id}.view.json`);

  // A project report/dashboard needs no wiki destination or wiki query.
  const datasets: Record<string, WikiDataResult> = { invoices: { rows: [{ path: "invoice.csv", amount: 42 }], total: 1, revision: "invoice-1", asOf: Date.now(), truncated: false, sourceOwner: { kind: "workspace", id: project.id } } };
  for (const mode of ["report", "dashboard"]) {
    const raw = previewResult.parse(await outside.tool.view_create.executeResult({ input: { version: 1, title: `Invoice ${mode}`, mode, catalog: "legalwork-1", queries: {}, datasets, program: 'invoice = Query("data", {name:"invoices"}, {rows:[],total:0})\nroot = Table(invoice.rows, [{field:"amount",label:"Amount"}])' } }));
    expect(raw).not.toHaveProperty("error");
    expect(raw.status).toBe("preview");
    const saved = ViewRecordSchema.parse(await (await b.request(`/workspace/${project.id}/ui-views`, "POST", raw.input)).json());
    expect(saved.owner).toEqual({ kind: "workspace", id: project.id });
    expect(saved.datasets).toEqual(datasets);
    expect(parseToolJson(await outside.tool.view_read.execute({ view_id: saved.id })).revision).toBe(saved.revision);
  }

  if (sandbox) {
    await writeSandboxDefault(member.config, { enabled: true, networkMode: "block" });
    await writeRuntimeOpencodeConfig(member.config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "shell", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }, { action: "external_directory", resource: "*", effect: "allow" }] }));
    const service = new AgentSandboxService(member.config, new ApprovalService(member.config.approval), sandbox);
    const own = member.config.workspaces.find(item => item.id === wiki.workspaceId);
    if (!own) throw new Error("Wiki workspace missing");
    const insideResult = await service.run(own, { sessionID: "wiki-agent", command: "cat Shared.md && printf '# Sandbox knowledge\\n' > Sandbox.md", write: true, timeoutMs: 30_000 }, { type: "host" }, AbortSignal.timeout(240_000));
    expect(insideResult).toMatchObject({ sandbox: "virtual-machine", exitCode: 0 });
    expect(insideResult.output).toContain("Shared source");
    expect(await readFile(join(wiki.root, "Sandbox.md"), "utf8")).toBe("# Sandbox knowledge\n");
    await writeRuntimeOpencodeConfig(member.config, project.id, () => ({ permissions: [{ action: "external_directory", resource: `${wiki.root}/*`, effect: "allow" }] }));
    const outsideResult = await service.run(project, { sessionID: "matter-agent", command: "cat /authorized/0/Shared.md && if printf bypass > /authorized/0/Bypass.md; then exit 9; fi; printf 'project output' > output.txt", write: true, timeoutMs: 30_000 }, { type: "host" }, AbortSignal.timeout(240_000));
    expect(outsideResult).toMatchObject({ sandbox: "virtual-machine", exitCode: 0 });
    expect(outsideResult.output).toContain("Shared source");
    expect(await Bun.file(join(wiki.root, "Bypass.md")).exists()).toBe(false);
    expect(await readFile(join(project.path, "output.txt"), "utf8")).toBe("project output");
  }
  await b.request(`/wikis/${wiki.id}/sync`, "POST"); await a.request(`/wikis/${original.id}/sync`, "POST");
  for (const path of ["From-project.md", "From-wiki.md", ...(sandbox ? ["Sandbox.md"] : [])])
    expect((await a.request(`/wikis/${original.id}/page?path=${path}`)).status).toBe(200);
  await a.request(`/wikis/${original.id}/share`, "PATCH", { access: "members", memberIds: [] });
  for (const tools of [inside, outside]) expect(parseToolJson(await tools.tool.wiki_read.execute({ wiki_id: wiki.id, path: "Shared.md" })).ok).toBe(false);
}

test("team wiki tools separate wiki and project chats, stage project drafts for human Save and retain project datasets", () => teamFlow(), 30_000);

test("PDF fallback accepts scoped agent credentials only in their own project", async () => {
  const cloud = await wikiTeamFixture(); cleanup.push(() => cloud.close());
  const owner = await cloud.account();
  const projects: WorkspaceInfo[] = [];
  for (const id of ["pdf-own", "pdf-other"]) {
    const path = join(cloud.root, id); await mkdir(path);
    projects.push({ id, name: id, path: await realpath(path), preset: "starter", workspaceType: "local" });
  }
  owner.config.workspaces.push(...projects);
  owner.config.authorizedRoots.push(...projects.map(project => project.path));
  const server = await host(owner.config);
  const project = projects[0]!;
  await grantWikiAgentSession(owner.config, { sessionId: "pdf-agent", directory: project.path, scope: "collaborator" });
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("Scoped PDF marker");
  const body = JSON.stringify({ dataBase64: Buffer.from(await pdf.save()).toString("base64") });
  const headers = { "content-type": "application/json", "x-legalwork-wiki-agent-token": await ensureWikiAgentToken(owner.config),
    "x-legalwork-wiki-agent-session": "pdf-agent", "x-legalwork-wiki-agent-directory": encodeURIComponent(project.path) };
  const own = await fetch(`${server.url}/workspace/${project.id}/pdf/read`, { method: "POST", headers, body });
  expect(own.status).toBe(200);
  expect(await own.text()).toContain("Scoped PDF marker");
  const other = await fetch(`${server.url}/workspace/${projects[1]!.id}/pdf/read`, { method: "POST", headers, body });
  expect(other.status).toBe(403);
  expect(await other.text()).toContain("wiki_agent_workspace_denied");
}, 30_000);

test("private wiki setup can discover its own connected storage and execution settings through agent tools", async () => {
  const cloud = await wikiTeamFixture(); cleanup.push(() => cloud.close());
  const owner = await cloud.account();
  const server = await host(owner.config);
  const result = await (await server.request("/wikis", "POST", { name: "Private setup", template: "firm" })).json();
  const wiki = z.object({ id: z.string(), root: z.string(), workspaceId: z.string() }).parse(result.wiki);
  const context = { directory: wiki.root, sessionID: "private-setup" };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === `/api/session/${context.sessionID}`
    ? Response.json({ data: { id: context.sessionID, location: { directory: wiki.root } } })
    : Response.json({ error: "Not found" }, { status: 404 }) });
  cleanup.push(async () => { await engine.stop(true); });
  const workspace = owner.config.workspaces.find(item => item.id === wiki.workspaceId);
  if (!workspace) throw new Error("Wiki workspace missing");
  workspace.baseUrl = `http://127.0.0.1:${engine.port}`;
  const previous = { LEGALWORK_SERVER_URL: process.env.LEGALWORK_SERVER_URL, LEGALWORK_SERVER_TOKEN: process.env.LEGALWORK_SERVER_TOKEN, LEGALWORK_WIKI_AGENT_TOKEN: process.env.LEGALWORK_WIKI_AGENT_TOKEN };
  Object.assign(process.env, { LEGALWORK_SERVER_URL: server.url, LEGALWORK_SERVER_TOKEN: owner.config.token, LEGALWORK_WIKI_AGENT_TOKEN: await ensureWikiAgentToken(owner.config) });
  cleanup.push(async () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  // Existing chats have no in-memory grant after a server restart. Authenticated
  // queue interaction restores it without trusting caller-supplied scope.
  await expect(resolveWorkspaceId(context, { requireDirectory: true })).rejects.toThrow("Workspace lookup failed");
  expect((await server.request(`/workspace/${wiki.workspaceId}/sessions/${context.sessionID}/queue`, "POST", { type: "pause", paused: true })).status).toBe(200);
  expect(await resolveWorkspaceId(context, { requireDirectory: true })).toBe(wiki.workspaceId);
  const storage = await LegalWorkStorageTools();
  const listed = parseToolJson(await storage.tool.storage_list_connections.execute({}, context));
  expect(listed).toHaveProperty("connections");
  expect(listed).not.toHaveProperty("error");
  const settings = await fetch(`${server.url}/workspace/${wiki.workspaceId}/sandbox/session/${context.sessionID}`, { headers: await workspaceToolHeaders(context) });
  expect(settings.status).toBe(200);
  await grantWikiAgentSession(owner.config, { sessionId: context.sessionID, directory: wiki.root, scope: "collaborator" });
  await expect(resolveWorkspaceId(context, { requireDirectory: true })).rejects.toThrow("No LegalWork workspace");
  expect(parseToolJson(await storage.tool.storage_list_connections.execute({}, context))).toHaveProperty("error");
}, 30_000);

test.skipIf(!process.env.LEGALWORK_WIKI_VM_RESOURCES)("team wiki access works through the real sandbox VM inside and outside its workspace", async () => {
  const vm = new VmSandbox(process.env.LEGALWORK_WIKI_VM_RESOURCES);
  cleanup.push(() => VmSandbox.shutdown());
  await teamFlow(vm);
}, 600_000);

function parseToolJson(value: string | { output: string }) {
  return JSON.parse(typeof value === "string" ? value : value.output);
}
