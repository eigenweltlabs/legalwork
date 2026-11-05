import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../types.js";
import { authenticateWikiAgentRequest, configureWikiAgentSessionLookup, ensureWikiAgentToken, grantWikiAgentSession, revokeWikiAgentSession, verifiedWikiSessionOrigin } from "./agent-access.js";
import { grantWikiProjectAccess, wikiProjectAccessRevision, wikiProjectAccessSignal, wikiProjectGrants } from "./project-access.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-wiki-origin-"));
  roots.push(root);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "collaborator", hostToken: "host",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [{ id: "project", name: "Project", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false };
  const token = await ensureWikiAgentToken(config);
  const request = (path = "/wikis", input?: { token?: string; session?: string; directory?: string; method?: string }) =>
    new Request(`http://127.0.0.1${path}`, { method: input?.method ?? "GET", headers: {
      "x-legalwork-wiki-agent-token": input?.token ?? token,
      "x-legalwork-wiki-agent-session": input?.session ?? "session-1",
      "x-legalwork-wiki-agent-directory": encodeURIComponent(input?.directory ?? root),
    } });
  return { root, config, token, request };
}

test("runtime credential is stable per running server and never an owner/host credential", async () => {
  const { config, token, request } = await fixture();
  expect(await ensureWikiAgentToken(config)).toBe(token);
  expect(token).not.toBe(config.token);
  expect(token).not.toBe(config.hostToken);
  expect(await authenticateWikiAgentRequest(config, new Request("http://localhost/wikis"))).toBeNull();
  await expect(authenticateWikiAgentRequest(config, request())).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  await expect(authenticateWikiAgentRequest(config, request("/wikis", { token: config.hostToken }))).rejects.toMatchObject({ code: "wiki_agent_unauthorized" });
});

test("server-recorded origin controls actor scope and collaborator takeover downgrades immediately", async () => {
  const { config, root, request } = await fixture();
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "owner" });
  const owner = await authenticateWikiAgentRequest(config, request());
  expect(owner?.actor.scope).toBe("owner");
  expect(owner?.actor.type).toBe("remote");
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "collaborator" });
  expect((await authenticateWikiAgentRequest(config, request()))?.actor.scope).toBe("collaborator");
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "viewer" });
  expect((await authenticateWikiAgentRequest(config, request()))?.actor.scope).toBe("viewer");
});

test("session directory claims require the canonical recorded directory", async () => {
  const { config, root, request } = await fixture();
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "owner" });
  const alias = `${root}-alias`;
  roots.push(alias);
  await symlink(root, alias);
  expect((await authenticateWikiAgentRequest(config, request("/wikis", { directory: alias })))?.directory).toBe(await realpath(root));
  const other = join(root, "other");
  await mkdir(other);
  await expect(authenticateWikiAgentRequest(config, request("/wikis", { directory: other }))).rejects.toMatchObject({ code: "wiki_agent_directory_mismatch" });
  await expect(grantWikiAgentSession(config, { sessionId: "session-1", directory: other, scope: "owner" })).rejects.toMatchObject({ code: "wiki_agent_directory_mismatch" });
});

test("Unicode directories use encoded headers and unavailable remote directories revoke stale grants", async () => {
  const { config, root, request } = await fixture();
  const unicode = join(root, "Prüfung 東京");
  await mkdir(unicode);
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: unicode, scope: "owner" });
  expect((await authenticateWikiAgentRequest(config, request("/wikis", { directory: unicode })))?.directory).toBe(await realpath(unicode));
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: join(root, "remote-unavailable"), scope: "collaborator" });
  await expect(authenticateWikiAgentRequest(config, request("/wikis", { directory: unicode }))).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
});

test("runtime auth permits only the page tool endpoints and refuses broader management/proxy access", async () => {
  const { config, root, request } = await fixture();
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "owner" });
  for (const [path, method] of [["/wikis", "GET"], ["/wikis/wiki-id", "GET"], ["/workspaces", "GET"], ["/wikis/wiki-id/search?q=note", "GET"],
    ["/wikis/wiki-id/page?path=Note.md", "GET"], ["/wikis/wiki-id/page", "PUT"], ["/wikis/wiki-id/page", "DELETE"]])
    expect((await authenticateWikiAgentRequest(config, request(path, { method })))?.actor.scope).toBe("owner");
  for (const [path, method] of [["/wikis/deleted", "GET"], ["/wikis/wiki-id/archive", "POST"], ["/wikis/wiki-id/restore-wiki", "POST"], ["/wikis", "POST"], ["/wikis/wiki-id", "PATCH"], ["/workspaces", "POST"],
    ["/workspace/project/opencode/session", "POST"], ["/tokens", "GET"], ["/wikis/wiki-id/restore", "POST"],
    ["/wikis/team", "GET"], ["/wikis/join", "POST"], ["/wikis/wiki-id/share", "POST"],
    ["/wikis/wiki-id/share", "PATCH"], ["/wikis/wiki-id/share", "DELETE"]])
    await expect(authenticateWikiAgentRequest(config, request(path, { method }))).rejects.toMatchObject({ code: "wiki_agent_endpoint_denied" });
});

test("engine-verified descendants inherit current ancestor scope without becoming independent grants", async () => {
  const { config, root, request } = await fixture();
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner" });
  const parents: Record<string, string | undefined> = { grandchild: "child", child: "parent", parent: undefined };
  configureWikiAgentSessionLookup(config, async (workspace, id, directory) => {
    expect(workspace.id).toBe("project");
    expect(directory).toBe(await realpath(root));
    return { id, directory: root, parentID: parents[id] };
  });
  const descendant = request("/wikis", { session: "grandchild" });
  expect(await authenticateWikiAgentRequest(config, descendant)).toMatchObject({ sessionId: "grandchild", actor: { clientId: "wiki-agent:grandchild", scope: "owner" } });
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "collaborator" });
  expect((await authenticateWikiAgentRequest(config, descendant))?.actor.scope).toBe("collaborator");
  await grantWikiAgentSession(config, { sessionId: "parent", directory: join(root, "unavailable"), scope: "owner" });
  await expect(authenticateWikiAgentRequest(config, descendant)).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
});

test("claimed parents, mismatched engine IDs and changed directories cannot grant descendant access", async () => {
  const { config, root, request } = await fixture();
  const other = join(root, "other");
  await mkdir(other);
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner" });
  const child = request("/wikis", { session: "child" });
  child.headers.set("x-legalwork-wiki-agent-parent-session", "parent");
  for (const record of [
    { id: "child", directory: root },
    { id: "different-child", directory: root, parentID: "parent" },
    { id: "child", directory: other, parentID: "parent" },
    { id: "child", directory: root, parentID: ["parent"] },
  ]) {
    configureWikiAgentSessionLookup(config, async () => record);
    await expect(authenticateWikiAgentRequest(config, child)).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  }
  configureWikiAgentSessionLookup(config, async () => { throw new Error("Unavailable engine"); });
  await expect(authenticateWikiAgentRequest(config, child)).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
});

test("descendants inherit saved scheduled project scope and cannot retain an earlier broader grant", async () => {
  const { config, root, request } = await fixture();
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory: root, ...(id === "child" ? { parentID: "parent" } : {}) }));
  const child = request("/recorder/recordings", { session: "child" });
  child.headers.set("x-legalwork-scheduled-projects", "all");
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner", scheduledProjects: "all" });
  const all = await authenticateWikiAgentRequest(config, child);
  expect(all?.scheduledProjects).toBe("all");
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner", scheduledProjects: ["project"] });
  const limited = await authenticateWikiAgentRequest(config, child);
  expect(limited?.scheduledProjects).toEqual(["project"]);
  expect(limited?.generation).not.toBe(all?.generation);
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner" });
  const interactive = await authenticateWikiAgentRequest(config, child);
  expect(interactive?.scheduledProjects).toBeUndefined();
  expect(interactive?.generation).not.toBe(limited?.generation);
});

test("cycles and excessive ancestry fail closed, and revoked ancestors cannot fall back to an older grant", async () => {
  const { config, root, request } = await fixture();
  const child = request("/wikis", { session: "child" });
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory: root, parentID: id === "child" ? "loop" : "child" }));
  await expect(authenticateWikiAgentRequest(config, child)).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  let lookups = 0;
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory: root, parentID: `ancestor-${++lookups}` }));
  await expect(authenticateWikiAgentRequest(config, child)).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  expect(lookups).toBe(64);
  await grantWikiAgentSession(config, { sessionId: "older", directory: root, scope: "owner" });
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner" });
  await grantWikiAgentSession(config, { sessionId: "parent", directory: join(root, "unavailable"), scope: "owner" });
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory: root, parentID: id === "child" ? "parent" : "older" }));
  await expect(authenticateWikiAgentRequest(config, child)).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
});

test("ancestor downgrades during engine lookup and explicit child grants cannot be elevated", async () => {
  const { config, root, request } = await fixture();
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner" });
  configureWikiAgentSessionLookup(config, async (_workspace, id) => {
    if (id === "parent") await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "viewer" });
    return { id, directory: root, ...(id === "child" ? { parentID: "parent" } : {}) };
  });
  expect((await authenticateWikiAgentRequest(config, request("/wikis", { session: "child" })))?.actor.scope).toBe("viewer");
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner" });
  await grantWikiAgentSession(config, { sessionId: "child", directory: root, scope: "collaborator" });
  configureWikiAgentSessionLookup(config, async () => { throw new Error("A directly registered child must not use ancestor permissions"); });
  expect((await authenticateWikiAgentRequest(config, request("/wikis", { session: "child" })))?.actor.scope).toBe("collaborator");
});

test("workspace tools retain the session origin and cannot borrow another workspace or chat", async () => {
  const { config, root, request } = await fixture();
  const nested = join(root, "wiki"); await mkdir(nested);
  config.workspaces.push({ id: "wiki", name: "Wiki", path: nested, preset: "starter", workspaceType: "local" });
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "owner" });
  for (const path of ["/workspace/project/storage/roots", "/workspace/project/storage/source/children", "/workspace/project/sandbox/session/session-1"])
    expect((await authenticateWikiAgentRequest(config, request(path)))?.actor.scope).toBe("owner");
  await expect(authenticateWikiAgentRequest(config, request("/workspace/wiki/storage/roots"))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
  await expect(authenticateWikiAgentRequest(config, request("/workspace/project/sandbox/session/another-chat"))).rejects.toMatchObject({ code: "wiki_agent_session_mismatch" });
  await expect(authenticateWikiAgentRequest(config, request("/workspace/project/storage", { method: "POST" }))).rejects.toMatchObject({ code: "wiki_agent_endpoint_denied" });
  await expect(authenticateWikiAgentRequest(config, request("/workspace/project/sandbox/settings", { method: "POST" }))).rejects.toMatchObject({ code: "wiki_agent_endpoint_denied" });
  const shellRequest = request("/workspace/project/sandbox/execute", { method: "POST" });
  const shell = (sessionID: string) => new Request(shellRequest.url, { method: "POST", headers: shellRequest.headers, body: JSON.stringify({ sessionID, command: "pwd" }) });
  expect((await authenticateWikiAgentRequest(config, shell("session-1")))?.actor.scope).toBe("owner");
  expect((await authenticateWikiAgentRequest(config, request("/workspace/project/sessions/session-1/review-recovery", { method: "POST" })))?.actor.scope).toBe("owner");
  await expect(authenticateWikiAgentRequest(config, request("/workspace/project/sessions/other/review-recovery", { method: "POST" }))).rejects.toMatchObject({ code: "wiki_agent_session_mismatch" });
  await expect(authenticateWikiAgentRequest(config, request("/workspace/wiki/sessions/session-1/review-recovery", { method: "POST" }))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
  await expect(authenticateWikiAgentRequest(config, shell("another-chat"))).rejects.toMatchObject({ code: "wiki_agent_session_mismatch" });
  await grantWikiAgentSession(config, { sessionId: "nested", directory: nested, scope: "owner" });
  expect((await authenticateWikiAgentRequest(config, request("/workspace/wiki/storage/roots", { session: "nested", directory: nested })))?.actor.scope).toBe("owner");
  await expect(authenticateWikiAgentRequest(config, request("/workspace/project/storage/roots", { session: "nested", directory: nested }))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "viewer" });
  expect((await authenticateWikiAgentRequest(config, request("/workspace/project/storage/roots")))?.actor.scope).toBe("viewer");
});

test("skill tools keep the session origin and stay limited to their own workspace", async () => {
  const { config, root, request } = await fixture();
  const nested = join(root, "wiki"); await mkdir(nested);
  config.workspaces.push({ id: "wiki", name: "Wiki", path: nested, preset: "starter", workspaceType: "local" });
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "owner" });
  for (const [path, method] of [["/workspace/project/skills", "GET"], ["/workspace/project/skills/vertrag/composed", "GET"],
    ["/workspace/project/skills/vertrag/package-file", "GET"], ["/workspace/project/skills", "POST"], ["/workspace/project/skills/vertrag/resources", "POST"]])
    expect((await authenticateWikiAgentRequest(config, request(path, { method })))?.actor.scope).toBe("owner");
  await expect(authenticateWikiAgentRequest(config, request("/workspace/wiki/skills/vertrag/composed"))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
  for (const [path, method] of [["/workspace/project/skills/vertrag", "DELETE"], ["/workspace/project/skills/hub/resources", "POST"], ["/workspace/project/skills/vertrag/promote-workflow", "POST"]])
    await expect(authenticateWikiAgentRequest(config, request(path, { method }))).rejects.toMatchObject({ code: "wiki_agent_endpoint_denied" });
});

test("ordinary Office, command, HTTP and review worker calls retain their recorded workspace and chat", async () => {
  const { config, root, request } = await fixture();
  const nested = join(root, "wiki"); await mkdir(nested);
  config.workspaces.push({ id: "wiki", name: "Wiki", path: nested, preset: "starter", workspaceType: "local" });
  await grantWikiAgentSession(config, { sessionId: "session-1", directory: root, scope: "collaborator" });
  const routes = [
    ["office-tools/execute", "POST"], ["sandbox/command", "POST"], ["sandbox/http", "POST"],
    ["reviews/workers/session-1/contract", "GET"], ["reviews/workers/session-1/submit", "POST"],
  ];
  for (const [route, method] of routes) {
    const make = (workspace = "project", sessionID = "session-1") => {
      const original = request(`/workspace/${workspace}/${route}`, { method });
      return new Request(original, method === "POST" ? { body: JSON.stringify({ sessionID }) } : undefined);
    };
    expect(await authenticateWikiAgentRequest(config, make())).toMatchObject({ sessionId: "session-1", actor: { scope: "collaborator" } });
    await expect(authenticateWikiAgentRequest(config, make("wiki"))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
    if (route.startsWith("sandbox/"))
      await expect(authenticateWikiAgentRequest(config, make("project", "other"))).rejects.toMatchObject({ code: "wiki_agent_session_mismatch" });
  }
  for (const [route, method] of [["reviews/workers/other/contract", "GET"], ["reviews/workers/other/submit", "POST"]])
    await expect(authenticateWikiAgentRequest(config, request(`/workspace/project/${route}`, { method }))).rejects.toMatchObject({ code: "wiki_agent_session_mismatch" });
  for (const [route, method] of [["office-tools/poll", "GET"], ["office-tools/requests/other/result", "POST"],
    ["reviews/settings", "PUT"], ["reviews/workers/session-1/contract", "POST"], ["reviews/workers/session-1/submit", "GET"], ["sandbox/command", "PATCH"]])
    await expect(authenticateWikiAgentRequest(config, request(`/workspace/project/${route}`, { method }))).rejects.toMatchObject({ code: "wiki_agent_endpoint_denied" });
});

test("new first-party routes do not turn Wiki roots or descendants into owner credentials", async () => {
  const { config, root, request } = await fixture();
  const wiki = join(root, "wiki"); await mkdir(wiki);
  config.workspaces.push({ id: "wiki", name: "Wiki", path: wiki, preset: "starter", workspaceType: "local" });
  await grantWikiAgentSession(config, { sessionId: "wiki-root", directory: wiki, scope: "collaborator" });
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory: wiki, ...(id === "child" ? { parentID: "wiki-root" } : {}) }));
  for (const session of ["wiki-root", "child"]) {
    const own = request("/workspace/wiki/office-tools/execute", { session, directory: wiki, method: "POST" });
    expect((await authenticateWikiAgentRequest(config, own))?.actor.scope).toBe("collaborator");
    await expect(authenticateWikiAgentRequest(config, request("/workspace/project/office-tools/execute", { session, directory: wiki, method: "POST" }))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
    await expect(authenticateWikiAgentRequest(config, request("/workspace/wiki/office-tools/execute", { session, directory: root, method: "POST" }))).rejects.toMatchObject({ code: session === "child" ? "wiki_agent_session_unknown" : "wiki_agent_directory_mismatch" });
  }
  await grantWikiAgentSession(config, { sessionId: "wiki-root", directory: wiki, scope: "viewer" });
  expect((await authenticateWikiAgentRequest(config, request("/workspace/wiki/office-tools/execute", { session: "child", directory: wiki, method: "POST" })))?.actor.scope).toBe("viewer");
  revokeWikiAgentSession(config, "wiki-root");
  await expect(authenticateWikiAgentRequest(config, request("/workspace/wiki/office-tools/execute", { session: "child", directory: wiki, method: "POST" }))).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
  for (const header of ["x-legalwork-wiki-agent-session", "x-legalwork-wiki-agent-directory"]) {
    const missing = request("/workspace/wiki/office-tools/execute", { session: "child", directory: wiki, method: "POST" });
    missing.headers.delete(header);
    await expect(authenticateWikiAgentRequest(config, missing)).rejects.toMatchObject({ code: header.endsWith("session") ? "wiki_agent_session_unknown" : "wiki_agent_directory_mismatch" });
  }
});

test("verified descendants retain live scope and ancestor changes abort grants and pending approvals", async () => {
  const { config, root, request } = await fixture();
  const parents: Record<string, string | undefined> = { child: "middle", middle: "parent" };
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory: root, parentID: parents[id] }));
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "owner" });
  const origin = await verifiedWikiSessionOrigin(config, config.workspaces[0], "child", "owner", new AbortController().signal);
  const revision = wikiProjectAccessRevision(config, "child"), signal = wikiProjectAccessSignal(config, "child");
  const grant = { wikiId: "wiki", projectId: "project", root, scope: "owner", origin: origin.generation } satisfies Parameters<typeof grantWikiProjectAccess>[2];
  grantWikiProjectAccess(config, "child", grant, revision);
  await grantWikiAgentSession(config, { sessionId: "parent", directory: root, scope: "collaborator" });
  expect((await authenticateWikiAgentRequest(config, request("/wikis", { session: "child" })))?.actor.scope).toBe("collaborator");
  const current = await verifiedWikiSessionOrigin(config, config.workspaces[0], "child", "collaborator", new AbortController().signal);
  expect(current.generation).not.toBe(origin.generation);
  expect(signal.aborted).toBe(true);
  expect(wikiProjectGrants(config, "child")).toEqual([]);
  expect(() => grantWikiProjectAccess(config, "child", grant, revision)).toThrow();
  const nextSignal = wikiProjectAccessSignal(config, "child");
  revokeWikiAgentSession(config, "middle");
  expect(nextSignal.aborted).toBe(true);
  await expect(authenticateWikiAgentRequest(config, request("/wikis", { session: "child" }))).rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
});
