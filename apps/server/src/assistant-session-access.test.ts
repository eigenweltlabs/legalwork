import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./types.js";
import { AssistantSessionAccess, assistantRequestAuthority, assertAssistantDispatchAuthority } from "./assistant-session-access.js";
import { authenticateWikiAgentRequest, configureWikiAgentSessionLookup, currentWikiAgentSession, ensureWikiAgentToken, grantWikiAgentSession, revokeWikiAgentSession } from "./wiki/agent-access.js";
import { createAssistantSessionQueue } from "./assistant-session-executor.js";
import { MainAssistant } from "./main-assistant.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "assistant-session-access-")); roots.push(root);
  const source = join(root, "assistant"), project = join(root, "matter");
  await mkdir(source); await mkdir(project);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "collaborator", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [
      { id: "assistant", name: "Assistant", path: source, preset: "main-assistant", workspaceType: "local" },
      { id: "matter", name: "Matter", path: project, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const path = join(root, "runtime.sqlite");
  const access = await AssistantSessionAccess.open(path, config);
  const request = async (sessionId: string, directory: string, pathname = "/workspaces", body?: unknown, active = config) => new Request(`http://localhost${pathname}`, {
    method: body ? "POST" : "GET", headers: { authorization: "Bearer collaborator", "content-type": "application/json",
      "x-legalwork-wiki-agent-token": await ensureWikiAgentToken(active), "x-legalwork-wiki-agent-session": sessionId,
      "x-legalwork-wiki-agent-directory": encodeURIComponent(directory) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { config, access, path, source, project, request };
}

test("delegation uses verified source scope, permits its project tools, and rejects forged source or wider endpoints", async () => {
  const { config, access, source, project, request } = await fixture();
  await grantWikiAgentSession(config, { sessionId: "day", directory: source, scope: "owner" });
  for (const path of ["/assistant/delegate", "/assistant/follow-up", "/assistant/session-control"]) {
    const req = await request("day", source, path, { sourceSessionId: "day", scope: "viewer" });
    const origin = await assistantRequestAuthority(config, req, { type: "remote", scope: "collaborator" });
    expect(origin).toMatchObject({ scope: "owner", sourceSessionId: "day" });
    const authority = await access.captureSource("day", source, origin);
    await access.authorize("worker", project, authority);
    for (const resource of ["/workspaces", "/wikis", "/workspace/matter/skills", "/workspace/matter/storage/roots"])
      expect((await authenticateWikiAgentRequest(config, await request("worker", project, resource)))?.actor.scope).toBe("owner");
    await expect(authenticateWikiAgentRequest(config, await request("day", source, path, { sourceSessionId: "someone-else" })))
      .rejects.toMatchObject({ code: "wiki_agent_session_mismatch" });
  }
  await expect(authenticateWikiAgentRequest(config, await request("worker", project, "/workspace/assistant/skills"))).rejects.toMatchObject({ code: "wiki_agent_workspace_denied" });
  await expect(authenticateWikiAgentRequest(config, await request("day", source, "/assistant/settings", { sourceSessionId: "day" }))).rejects.toMatchObject({ code: "wiki_agent_endpoint_denied" });
  await expect(assistantRequestAuthority(config, await request("unknown", source, "/assistant/delegate", { sourceSessionId: "unknown" }), { type: "remote", scope: "owner" }))
    .rejects.toMatchObject({ code: "wiki_agent_session_unknown" });
});

test("durable dispatch restores authority after restart and preserves later source/target downgrades and revocation", async () => {
  const { config, access, path, source, project, request } = await fixture();
  const authority = await access.captureSource("day", source, { scope: "owner", scheduledProjects: ["matter"] });
  await access.authorize("worker", project, authority);
  await grantWikiAgentSession(config, { sessionId: "day", directory: source, scope: "collaborator", scheduledProjects: ["matter"] });
  const restartedConfig = { ...config };
  const restarted = await AssistantSessionAccess.open(path, restartedConfig);
  expect(currentWikiAgentSession(restartedConfig, "worker")).toBeUndefined();
  expect(await restarted.prepare("worker", project, authority)).toMatchObject({ scope: "collaborator", scheduledProjects: ["matter"] });
  expect((await authenticateWikiAgentRequest(restartedConfig, await request("worker", project, "/wikis", undefined, restartedConfig)))?.actor.scope).toBe("collaborator");
  await restarted.prepareReturn("tomorrow", source, await restarted.prepare("worker", project, authority));
  expect(currentWikiAgentSession(restartedConfig, "tomorrow")?.scope).toBe("collaborator");
  await grantWikiAgentSession(restartedConfig, { sessionId: "worker", directory: project, scope: "viewer" });
  await expect(restarted.prepare("worker", project, authority)).rejects.toMatchObject({ code: "assistant_dispatch_forbidden" });
  revokeWikiAgentSession(restartedConfig, "day");
  const again = await AssistantSessionAccess.open(path, { ...config });
  await expect(again.prepare("worker", project, authority)).rejects.toMatchObject({ code: "assistant_session_reauthorization" });
});

test("verified inherited source keeps its ancestor as the durable ceiling without flattening child lineage", async () => {
  const { config, access, path, source, project, request } = await fixture();
  await grantWikiAgentSession(config, { sessionId: "day", directory: source, scope: "owner" });
  configureWikiAgentSessionLookup(config, async (_workspace, id) => ({ id, directory: source, ...(id === "research" ? { parentID: "day" } : {}) }));
  const origin = await assistantRequestAuthority(config, await request("research", source, "/assistant/delegate", { sourceSessionId: "research" }));
  expect(origin.sourceSessionId).toBe("day");
  const authority = await access.captureSource("research", source, origin);
  await access.authorize("worker", project, authority);
  expect(currentWikiAgentSession(config, "research")).toBeUndefined();
  await grantWikiAgentSession(config, { sessionId: "day", directory: source, scope: "collaborator" });
  expect((await authenticateWikiAgentRequest(config, await request("research", source)))?.actor.scope).toBe("collaborator");
  const restarted = await AssistantSessionAccess.open(path, { ...config });
  expect((await restarted.prepare("worker", project, authority)).scope).toBe("collaborator");
});

test("legacy records require authenticated reauthorization, and scheduled scope never expands on dispatch or returns", async () => {
  const { access, config, source, project } = await fixture();
  await expect(access.prepare("legacy", project, undefined)).rejects.toMatchObject({ code: "assistant_session_reauthorization" });
  await expect(access.prepare("legacy", project, { scope: "owner" })).rejects.toMatchObject({ code: "assistant_session_reauthorization" });
  const authority = await access.captureSource("day", source, { scope: "collaborator", scheduledProjects: ["matter"] });
  await access.authorize("legacy", project, authority);
  expect((await access.prepare("legacy", project, authority)).scope).toBe("collaborator");
  expect(() => assertAssistantDispatchAuthority(authority, "other-matter")).toThrow("not authorized");
  await grantWikiAgentSession(config, { sessionId: "legacy", directory: project, scope: "owner", scheduledProjects: "all" });
  expect(await access.prepare("legacy", project, authority)).toMatchObject({ scope: "collaborator", scheduledProjects: ["matter"] });
  await access.prepareReturn("tomorrow", source, authority);
  expect(currentWikiAgentSession(config, "tomorrow")).toMatchObject({ scope: "collaborator", scheduledProjects: ["matter"] });
  await expect(access.prepareReturn("tomorrow", project, authority)).rejects.toMatchObject({ code: "wiki_agent_directory_mismatch" });
});

test("a revoke during asynchronous preparation cannot be restored by stale background work", async () => {
  const { access, config, source, project } = await fixture();
  const authority = await access.captureSource("day", source, { scope: "owner" });
  await access.authorize("worker", project, authority);
  const check = access.checkDirectory.bind(access);
  const spy = spyOn(access, "checkDirectory").mockImplementation(async (directory, requested) => {
    await check(directory, requested);
    revokeWikiAgentSession(config, "day");
  });
  try {
    await expect(access.prepare("worker", project, authority)).rejects.toMatchObject({ code: "assistant_session_authority_changed" });
    await expect(access.authorize("new-worker", project, authority)).rejects.toMatchObject({ code: "assistant_session_reauthorization" });
    expect(currentWikiAgentSession(config, "new-worker")).toBeUndefined();
  } finally { spy.mockRestore(); }
});

test("real queued executor initializes restored project tools before dispatch and pauses revoked access until authenticated resume", async () => {
  const { config, access, path, source, project, request } = await fixture();
  let activeConfig = config, busy = true, prepared = 0;
  const delivered: string[] = [], scopes: unknown[] = [];
  const engine = Bun.serve({ port: 0, async fetch(input) {
    const url = new URL(input.url);
    if (url.pathname === "/session/status") return Response.json(busy ? { worker: { type: "busy" } } : {});
    if (url.pathname === "/permission" || url.pathname === "/question" || url.pathname.endsWith("/message")) return Response.json([]);
    if (url.pathname.includes("/message/")) {
      const id = url.pathname.split("/").at(-1)!;
      return delivered.includes(id) ? Response.json({ info: { id } }) : new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/prompt_async")) {
      const message = z.object({ messageID: z.string() }).parse(await input.json());
      expect(prepared).toBeGreaterThan(0);
      for (const resource of ["/workspaces", "/wikis", "/workspace/matter/skills"])
        scopes.push((await authenticateWikiAgentRequest(activeConfig, await request("worker", project, resource, undefined, activeConfig)))?.actor.scope);
      delivered.push(message.messageID);
      return new Response(null, { status: 204 });
    }
    return Response.json({ id: "worker", directory: project, title: "Register review", time: {}, version: "1", projectID: "matter", slug: "worker" });
  } });
  try {
    const assistant = await MainAssistant.open(config, path, () => { throw new Error("Queue must not create another chat"); }, () => {});
    const client = createOpencodeClient({ baseUrl: engine.url.origin, directory: project });
    const makeQueue = (permissions: AssistantSessionAccess) => createAssistantSessionQueue(path, {
      config: activeConfig, access: permissions, assistant, workspace: async id => {
        const workspace = config.workspaces.find(item => item.id === id); if (!workspace) throw new Error("Unknown project"); return workspace;
      }, client: () => client, changed: () => {}, preparePrompt: async () => { prepared++; },
    });
    const authority = await access.captureSource("day", source, { scope: "collaborator" });
    await access.authorize("worker", project, authority);
    const target = { workspaceId: "matter", sessionId: "worker" };
    await (await makeQueue(access)).submit(target, "Read the register and create the requested document", authority);
    expect(delivered).toEqual([]);
    activeConfig = { ...config };
    const restoredAccess = await AssistantSessionAccess.open(path, activeConfig);
    const restarted = await makeQueue(restoredAccess);
    busy = false; await restarted.tick();
    expect(delivered).toHaveLength(1); expect(scopes).toEqual(["collaborator", "collaborator", "collaborator"]);
    busy = true;
    const followUp = await restarted.submit(target, "Apply the clarification", authority);
    revokeWikiAgentSession(activeConfig, "worker");
    busy = false; await restarted.tick();
    expect(restarted.list(target)[0].state).toBe("paused"); expect(delivered).toHaveLength(1);
    await restoredAccess.authorize("worker", project, authority);
    await restarted.update(target, followUp.id, "resume", authority); await restarted.tick();
    expect(delivered).toHaveLength(2); expect(restarted.list(target)).toEqual([]);
    busy = true;
    await restarted.submit(target, "Check the remaining matter", authority);
    assistant.updateSettings({ ...assistant.settings(), projectAccess: { mode: "none", projectIds: [] } }, []);
    busy = false; await restarted.tick();
    expect(restarted.list(target)[0].state).toBe("paused"); expect(delivered).toHaveLength(2);
  } finally { await engine.stop(true); }
});
