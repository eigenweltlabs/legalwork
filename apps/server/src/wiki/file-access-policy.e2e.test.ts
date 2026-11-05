import { nativePluginTools } from "../opencode-plugins/native-plugin-test-support.js";
import { nativeToolBefore } from "../opencode-plugins/native-plugin-test-support.js";
const LegalWorkWikiTools = (context = {}) => nativePluginTools(LegalWorkWikiToolsDefinition, context);
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server.js";
import { registerLocalProject } from "../routes/workspaces.js";
import LegalWorkWikiToolsDefinition from "../opencode-plugins/legalwork-wiki-tools.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "./agent-access.js";
import { WikiStore } from "./store.js";
import type { ServerConfig } from "../types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

test("wiki tools respect project access without overriding host file access", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-file-policy-api-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "file-policy-client", hostToken: "file-policy-host", configPath: join(root, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, agentSandboxEnabled: false,
  };
  const { workspace } = await registerLocalProject(config, { folderPath: join(root, "project"), name: "Project", preset: "starter" });
  const engine = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/api/session/project-session"
    ? Response.json({ data: { id: "project-session", location: { directory: workspace.path } } })
    : Response.json({ error: "Not found" }, { status: 404 }) });
  cleanup.push(async () => { engine.stop(true); });
  workspace.baseUrl = engine.url.origin;
  const store = new WikiStore(config); cleanup.push(() => store.close());
  const wiki = await store.create({ name: "Private disabled wiki", template: "blank" });
  await store.update(wiki.id, { allowInProjects: false });
  const token = await ensureWikiAgentToken(config);
  await grantWikiAgentSession(config, { sessionId: "project-session", directory: workspace.path, scope: "owner" });
  await grantWikiAgentSession(config, { sessionId: "wiki-session", directory: wiki.root, scope: "owner" });
  const server = await startServer(config); cleanup.push(async () => { await server.stop(); });
  const base = `http://127.0.0.1:${server.port}`;
  const previous = { url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN, agent: process.env.LEGALWORK_WIKI_AGENT_TOKEN };
  process.env.LEGALWORK_SERVER_URL = base; process.env.LEGALWORK_SERVER_TOKEN = config.token; process.env.LEGALWORK_WIKI_AGENT_TOKEN = token;
  cleanup.push(async () => {
    for (const [key, value] of Object.entries({ LEGALWORK_SERVER_URL: previous.url, LEGALWORK_SERVER_TOKEN: previous.token, LEGALWORK_WIKI_AGENT_TOKEN: previous.agent }))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const project = await LegalWorkWikiTools({ directory: workspace.path });
  await expect(nativeToolBefore(project.runtime,"read",{ path: join(root, "outside.txt") },"project-session")).resolves.toBeUndefined();
  expect(project).not.toHaveProperty("shell.env");
  const ownWiki = await LegalWorkWikiTools({ directory: wiki.root });
  await expect(nativeToolBefore(ownWiki.runtime,"read",{ path: join(workspace.path, "outside.txt") },"wiki-session")).rejects.toMatchObject({ code: "wiki_native_project_access" });
  await expect(nativeToolBefore(ownWiki.runtime,"write",{ path: join(workspace.path, "new.txt") },"wiki-session")).rejects.toMatchObject({ code: "wiki_native_project_access" });
  await expect(nativeToolBefore(ownWiki.runtime,"read",{ path: join(wiki.root, "AGENTS.md") },"wiki-session")).resolves.toBeUndefined();
  expect(JSON.parse(await project.tool.wiki_list.execute({}, { sessionID: "project-session", directory: workspace.path })).wikis).toEqual([]);
  const headers = { authorization: `Bearer ${config.token}`, "x-legalwork-host-token": config.hostToken, "content-type": "application/json" };
  for (const [path, code] of [["/api/session/project-session/shell", "sandbox_required"], ["/api/pty", "engine_terminal_disabled"]]) {
    const response = await fetch(`${base}/workspace/${workspace.id}/opencode${path}`, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
  }
});
