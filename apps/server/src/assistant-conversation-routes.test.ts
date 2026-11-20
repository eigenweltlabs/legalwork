import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantConversations } from "./assistant-conversations.js";
import { AssistantSubmissions, type SubmissionPayload } from "./assistant-submissions.js";
import { registerLauncherRoutes } from "./routes/launcher.js";
import { registerAssistantConversationRoutes } from "./routes/assistant-conversations.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { AssistantSessionAccess } from "./assistant-session-access.js";
import { currentWikiAgentSession } from "./wiki/agent-access.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { matchRoute, type Route, type RequestContext } from "./routes/registry.js";

test("concurrent project-command retries reuse one destination and its original payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-command-route-"));
  const assistant: WorkspaceInfo = { id: "assistant", name: "Assistant", path: join(root, "assistant"), preset: "main-assistant", workspaceType: "local" };
  const project: WorkspaceInfo = { id: "matter", name: "Matter", path: join(root, "matter"), preset: "starter", workspaceType: "local" };
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "config.json"), workspaces: [assistant, project], authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let created = 0, sends = 0, stored = false;
  const payloads: SubmissionPayload[] = [];
  try {
    await Promise.all([mkdir(assistant.path), mkdir(project.path)]);
    await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }) });
    const sessionAccess = await AssistantSessionAccess.open(join(root, "runtime.sqlite"), config);
    const conversations = await AssistantConversations.open(join(root, "runtime.sqlite"), () => []);
    const conversation = await conversations.create(assistant, { create: async title => ({ id: "origin", title, directory: assistant.path, time: {} }) });
    const submissions = await AssistantSubmissions.open(join(root, "runtime.sqlite"), {
      hasMessage: async () => stored, outcome: async () => "running",
      send: async (entry, payload) => {
        expect(entry.workspaceId).toBe("matter"); expect(entry.sessionId).toBe("command-session");
        payloads.push(payload); sends++;
        if (sends === 1) throw new Error("temporary connection loss");
        stored = true;
      },
    });
    const routes: Route[] = [];
    // Minimal HTTP-handler fixture: unrelated services are not started.
    registerAssistantConversationRoutes({ routes, config, conversations, submissions, sessionAccess,
      ensureWritable: () => {}, requireClientScope: () => {}, changed: () => {}, assistant: {}, delegations: { track: () => {} },
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }), readJsonBodyLimited: (request: Request) => request.json(),
      resolveWorkspace: async (_config: unknown, id: string) => id === "matter" ? project : assistant,
      client: (workspace: typeof project) => ({
        native: { plugin: { list: async () => ({ data: [{ id: "legalwork.commands", state: { status: "active" } }] }) }, command: { list: async () => ({ data: [{ name: "compare" }] }) } },
        session: { get: async () => ({ data: { directory: workspace.path, time: {} } }), messages: async () => ({ data: [] }),
          create: async () => { created++; return { data: { id: "command-session", directory: project.path } }; } },
      }),
    } as unknown as Parameters<typeof registerAssistantConversationRoutes>[0]);
    const route = matchRoute(routes, "POST", `/assistant/conversations/${conversation.id}/messages`)!;
    const input = { requestId: "request_original", messageId: "msg_1234567890abc", text: "/compare original", command: { name: "compare", arguments: "original" },
      context: { items: [], target: { kind: "project", workspaceId: "matter" }, searchScope: null, capturedAt: 1 } };
    const send = async (arguments_: string) => {
      const request = new Request(`http://localhost/assistant/conversations/${conversation.id}/messages`, { method: "POST", body: JSON.stringify({ ...input, command: { ...input.command, arguments: arguments_ } }) });
      const ctx = { request, url: new URL(request.url), params: { id: conversation.id }, actor: { type: "host" } } as unknown as RequestContext;
      return (await route.handler(ctx)).json();
    };
    expect((await send("original")).submission.state).toBe("unconfirmed");
    const retries = await Promise.all([send("changed"), send("also changed")]);
    expect(retries.every(result => ["accepted", "running"].includes(result.submission.state))).toBe(true);
    expect(created).toBe(1); expect(sends).toBe(2);
    expect(currentWikiAgentSession(config, "origin")?.scope).toBe("owner");
    expect(currentWikiAgentSession(config, "command-session")?.directory).toBe(await realpath(project.path));
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[1].command?.arguments).toBe("original");
    expect(payloads[1].queue).toMatchObject({ id: expect.any(String), draft: { command: { name: "compare", arguments: "original" } } });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("project conversations submit without an Assistant plan while Assistant execution stays blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-project-subscription-"));
  const project: WorkspaceInfo = { id: "matter", name: "Matter", path: root, preset: "starter", workspaceType: "local" };
  const assistant: WorkspaceInfo = { ...project, id: "assistant", preset: "main-assistant" };
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "config.json"), workspaces: [project, assistant], authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  try {
    const conversations = await AssistantConversations.open(join(root, "runtime.sqlite"), () => []);
    const sessionAccess = await AssistantSessionAccess.open(join(root, "runtime.sqlite"), config);
    const create = async (title: string) => ({ id: crypto.randomUUID(), title, directory: root, time: {} });
    const projectChat = await conversations.create(project, { create });
    const assistantChat = await conversations.create(assistant, { create });
    let sent = 0;
    const payloads: SubmissionPayload[] = [];
    const submissions = await AssistantSubmissions.open(join(root, "runtime.sqlite"), {
      hasMessage: async () => sent > 0, outcome: async () => "accepted", send: async (_entry, payload) => { payloads.push(payload); sent++; },
    });
    const routes: Route[] = [];
    const routeOptions = { routes, config, conversations, submissions, sessionAccess,
      ensureWritable: () => {}, requireClientScope: () => {}, changed: () => {}, assistant: {},
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }), readJsonBodyLimited: (request: Request) => request.json(),
      resolveWorkspace: async (_config: unknown, id: string) => id === project.id ? project : assistant,
      client: () => ({ session: { get: async () => ({ data: { directory: root, model: { providerID: "native", id: "selected-model", variant: "deep" }, agent: "selected-agent", time: {} } }), messages: async () => ({ data: [] }) } }),
    } as unknown as Parameters<typeof registerAssistantConversationRoutes>[0];
    registerAssistantConversationRoutes(routeOptions);
    registerLauncherRoutes({ ...routeOptions, guardLauncherWorkspace: async () => {}, launcherFolderVisible: async () => true,
      launcherRecordingAccess: async () => ({ authorize: async () => {}, check: async () => {}, visible: () => true, scope: { projects: "all", globalRecordings: true, transcriptAccess: "" } }),
    });
    const attachmentDir = ".legalwork/attachments/1234-abcd";
    const name = "region-2026-11-20T12-00-00-000Z.png";
    const path = `${attachmentDir}/${name}`;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7d8AAAAASUVORK5CYII=";
    await mkdir(join(root, attachmentDir), { recursive: true });
    await writeFile(join(root, path), Buffer.from(png, "base64"));
    const send = (id: string, attachmentPath = path, draftAccount?: string) => {
      const context = { items: [{ id: "image", type: "image", workspaceId: project.id, name, capture: "region", sourceApp: null, sourceWindow: null, capturedAt: 1, path: attachmentPath }], target: { kind: "project", workspaceId: project.id }, searchScope: null, capturedAt: 1 };
      const request = new Request(`http://localhost/assistant/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ requestId: `request_${id}`, messageId: `msg_${id.replaceAll("_", "")}`, text: "Review the file", context, draftAccount }) });
      return matchRoute(routes, "POST", new URL(request.url).pathname)!.handler({ request, url: new URL(request.url), params: { id }, actor: { type: "host" } } as unknown as RequestContext);
    };
    const request = new Request("http://localhost/launcher/assistant-availability");
    const availability = await matchRoute(routes, "GET", new URL(request.url).pathname)!.handler({ request, url: new URL(request.url), params: {}, actor: { type: "host" } } as RequestContext);
    expect(await availability.json()).toEqual({ included: false });
    const resolveDraftAccount = async () => {
      const request = new Request("http://localhost/launcher/draft-account");
      const response = await matchRoute(routes, "GET", new URL(request.url).pathname)!.handler({ request, url: new URL(request.url), params: {}, actor: { type: "host" } } as RequestContext);
      return (await response.json()).account;
    };
    const signedOut = await resolveDraftAccount();
    const account = { userId: "account-a", orgId: "firm-a", userName: null, userEmail: null, orgName: "Demo firm" };
    await writeEigenweltConnection(config, { account, platformToken: "first-token" });
    const first = await resolveDraftAccount();
    expect(first).not.toBe(signedOut);
    await writeEigenweltConnection(config, { platformToken: "rotated-token" });
    expect(await resolveDraftAccount()).toBe(first);
    await writeEigenweltConnection(config, { account: { ...account, userId: "account-b" } });
    const second = await resolveDraftAccount();
    expect(second).not.toBe(first);
    await expect(send(projectChat.id, path, first)).rejects.toMatchObject({ status: 409, code: "draft_account_changed" });
    expect(sent).toBe(0);
    const symlinkPath = `${attachmentDir}/window-2026-11-20T12-00-00-000Z.png`;
    await symlink(join(root, path), join(root, symlinkPath));
    await expect(send(projectChat.id, symlinkPath)).rejects.toMatchObject({ status: 400, code: "capture_missing" });
    expect((await send(projectChat.id, path, second)).status).toBe(202);
    expect(currentWikiAgentSession(config, projectChat.sessionId)?.scope).toBe("owner");
    await expect(send(assistantChat.id)).rejects.toMatchObject({ status: 403, code: "assistant_subscription_required" });
    expect(sent).toBe(1);
    const url = `data:image/png;base64,${png}`;
    expect(payloads[0].parts).toContainEqual({ type: "file", filename: name, mime: "image/png", url });
    expect(payloads[0]).toMatchObject({ model: { providerID: "native", modelID: "selected-model" }, variant: "deep", agent: "selected-agent",
      queue: { id: expect.any(String), draft: { text: "Review the file", attachments: [{ kind: "image", name, data: url }] } } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
