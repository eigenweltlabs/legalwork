import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { ensureWikiAgentToken, grantWikiAgentSession, revokeWikiAgentSession } from "./agent-access.js";
import { waitForApprovals, respondApproval } from "./approval.test-helpers.js";
import { prepareLocalProjects } from "../project-storage.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wiki-project-access-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "Matter"); await mkdir(project); await writeFile(join(project, "note.txt"), "Private project note");
  await writeFile(join(root, "secret.txt"), "Outside"); await symlink(join(root, "secret.txt"), join(project, "escape.txt"));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 3000 }, corsOrigins: ["*"], workspaces: [{ id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  config.projectsDirectory = join(root, "homes");
  await prepareLocalProjects(config);
  const token = await ensureWikiAgentToken(config), server = await startServer(config);
  cleanup.push(() => server.stop()); const url = `http://127.0.0.1:${server.port}`;
  const host = (path: string, method = "GET", body?: unknown) => fetch(`${url}${path}`, { method, headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const { wiki } = z.object({ wiki: z.object({ id: z.string(), root: z.string(), engineDirectory: z.string() }) }).parse(await (await host("/wikis", "POST", { name: "Knowledge", root: join(root, "Knowledge"), template: "blank" })).json());
  for (const sessionId of ["chat", "other"]) await grantWikiAgentSession(config, { sessionId, directory: wiki.engineDirectory, scope: "owner" });
  const base = `/wikis/${wiki.id}/sessions/chat/projects`;
  const agent = (path: string, method = "GET", session = "chat") => fetch(`${url}${path}`, { method, headers: {
    "x-legalwork-wiki-agent-token": token, "x-legalwork-wiki-agent-session": session, "x-legalwork-wiki-agent-directory": encodeURIComponent(wiki.engineDirectory),
  } });
  const requestAccess = async (reply: "allow" | "deny") => {
    const response = agent(`${base}/matter/access`, "POST");
    const [approval] = await waitForApprovals(url, config.hostToken);
    expect(approval).toMatchObject({ action: "wiki.project.read", sessionID: "chat" });
    await respondApproval(url, config.hostToken, approval, reply);
    return response;
  };
  return { config, project, base, url, wiki, host, agent, requestAccess };
}

test("wiki project access requires manual Allow, supports Deny and Revoke, and cannot leak across sessions", async () => {
  const f = await fixture(), read = `${f.base}/matter/read?path=note.txt`;
  expect((await f.agent(read)).status).toBe(403);
  expect((await f.requestAccess("deny")).status).toBe(403);
  expect((await f.agent(read)).status).toBe(403);
  expect((await f.requestAccess("allow")).status).toBe(200);
  expect(await (await f.agent(read)).json()).toMatchObject({ content: "Private project note", content_is_data: true });
  expect((await f.agent(read, "GET", "other")).status).toBe(403);
  expect((await f.agent(read.replace("/chat/", "/other/"), "GET", "other")).status).toBe(403);
  expect((await f.agent(`${f.base}/matter/access`, "DELETE")).status).toBe(403);
  expect((await f.host(`${f.base}/matter/access`, "DELETE")).status).toBe(200);
  expect((await f.agent(read)).status).toBe(403);
});

test("approved project tools reject traversal, symlink escape, writes and broad API access", async () => {
  const f = await fixture(); expect((await f.requestAccess("allow")).status).toBe(200);
  for (const path of ["../secret.txt", "escape.txt", "/etc/passwd", ".legalwork/private.json"])
    expect((await f.agent(`${f.base}/matter/read?path=${encodeURIComponent(path)}`)).status).toBe(403);
  for (const method of ["PUT", "PATCH", "DELETE", "POST"]) expect([403, 404]).toContain((await f.agent(`${f.base}/matter/read?path=note.txt`, method)).status);
  expect((await f.agent("/workspace/matter/files/content?path=note.txt")).status).toBe(403);
  expect(await readFile(join(f.project, "note.txt"), "utf8")).toBe("Private project note");
});

test("scope changes and deleted chats revoke grants; revoke while approval is pending cannot regrant", async () => {
  const f = await fixture(); expect((await f.requestAccess("allow")).status).toBe(200);
  await grantWikiAgentSession(f.config, { sessionId: "chat", directory: f.wiki.engineDirectory, scope: "collaborator" });
  expect([403, 404]).toContain((await f.agent(`${f.base}/matter/read?path=note.txt`)).status);
  await grantWikiAgentSession(f.config, { sessionId: "chat", directory: f.wiki.engineDirectory, scope: "owner" });
  const pending = f.agent(`${f.base}/matter/access`, "POST");
  const [approval] = await waitForApprovals(f.url, f.config.hostToken);
  expect((await f.host(`${f.base}/matter/access`, "DELETE")).status).toBe(200);
  expect(approval.action).toBe("wiki.project.read");
  expect((await pending).status).toBe(403);
  expect((await f.agent(`${f.base}/matter/read?path=note.txt`)).status).toBe(403);
  expect((await f.requestAccess("allow")).status).toBe(200);
  revokeWikiAgentSession(f.config, "chat");
  expect((await f.agent(`${f.base}/matter/read?path=note.txt`)).status).toBe(403);
});


test("project reads reject missing, invalid and non-file paths without blocking on FIFOs", async () => {
  const f = await fixture(); expect((await f.requestAccess("allow")).status).toBe(200);
  expect((await f.agent(`${f.base}/matter/files?path=note.txt`)).status).toBe(404);
  expect((await f.agent(`${f.base}/matter/read?path=missing.txt`)).status).toBe(404);
  for (const path of ["%00", "%FF", "%E0%A4"])
    expect((await f.agent(`${f.base}/matter/read?path=${path}`)).status).toBe(400);
  expect((await f.agent(`${f.base}/matter/read?path=`)).status).toBe(400);
  if (process.platform !== "win32") {
    const fifo = join(f.project, "pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const response = await fetch(`${f.url}${f.base}/matter/read?path=pipe`, { headers: { "x-legalwork-host-token": f.config.hostToken }, signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(400);
    const listing = z.object({ items: z.array(z.object({ name: z.string() })) }).parse(await (await f.agent(`${f.base}/matter/files`)).json());
    expect(listing.items.some(item => item.name === "pipe")).toBe(false);
  }
});


test("unregistering a project cancels its pending approval before any grant is issued", async () => {
  const f = await fixture();
  const pending = f.agent(`${f.base}/matter/access`, "POST");
  await waitForApprovals(f.url, f.config.hostToken);
  expect((await f.host("/workspaces/matter", "DELETE")).status).toBe(200);
  expect((await pending).status).toBe(403);
  expect(f.config.workspaces.some(item => item.id === "matter")).toBe(false);
});
