import { expect, test } from "bun:test";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { createClient } from "../src/app/lib/opencode";
import { createSessionActionsStore } from "../src/react-app/domains/session/sync/actions-store";
import { clearSessionDraft, getSessionDraft, saveSessionDraft } from "../src/react-app/domains/session/sync/draft-store";

function fixture(baseUrl: string) {
  const workspaceId = "home-deletion-project";
  const session = (id: string): Session => ({ id, slug: id, projectID: workspaceId,
    directory: "/project", title: id, version: "1", time: { created: 1, updated: 1 } });
  const client = createClient(baseUrl);
  let selectedId: string | null = "active";
  let sessions = [session("active"), session("other")];
  let remembered: Record<string, string> = { [workspaceId]: "active", unrelated: "unrelated-chat" };
  let status: Record<string, string> = { active: "idle", other: "idle" };
  const navigations: { path: string; replace?: boolean }[] = [];
  const noop = () => {};
  const actions = createSessionActionsStore({
    client: () => client, baseUrl: () => baseUrl, developerMode: () => false,
    prompt: () => "", setPrompt: noop, selectedSessionId: () => selectedId,
    selectedSession: () => null, sessions: () => sessions, messages: () => [],
    setSessions: (next) => { sessions = next; }, sessionStatusById: () => status,
    setSessionStatusById: (next) => { status = next; }, setBusy: noop,
    setBusyLabel: noop, setBusyStartedAt: noop, setCreatingSession: noop, setError: noop,
    selectWorkspace: noop, workspaceRootForId: () => "/project",
    selectedWorkspaceId: () => workspaceId, selectedWorkspaceRoot: () => "/project",
    runtimeWorkspaceRoot: () => "/project", ensureWorkspaceRuntime: async () => true,
    selectSession: async () => {}, refreshSidebarWorkspaceSessions: async () => {
      // Navigation and local cleanup still work if the sidebar refresh fails.
      throw new Error("Refresh unavailable");
    }, abortRefreshes: noop,
    modelConfig: { applyPendingSessionChoice: noop, setSessionModelById: noop, clearSessionModelOverride: noop },
    selectedSessionModel: () => ({ providerID: "test", modelID: "test" }),
    modelVariant: () => null, sanitizeModelVariantForRef: (_ref, value) => value,
    resolveCodexReasoningEffort: () => undefined, messageIdFromInfo: () => "",
    restorePromptFromUserMessage: noop, upsertLocalSession: noop,
    readSessionByWorkspace: () => remembered,
    writeSessionByWorkspace: (next) => { remembered = next; },
    setSelectedSessionId: (next) => { selectedId = next; },
    locationPath: () => "/workspace/home-deletion-project/session/active",
    navigate: (path, options) => navigations.push({ path, ...options }),
    renameSession: async () => {}, appendSessionErrorTurn: noop,
  });
  return { actions, workspaceId, navigations, state: () => ({ selectedId, sessions, remembered, status }) };
}

test("deleting the active chat opens Home and clears only that chat's saved state", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json(true);
  } });
  const f = fixture(String(server.url));
  saveSessionDraft(f.workspaceId, "active", { text: "Old draft", mode: "prompt" });
  try {
    await f.actions.deleteSessionById("active");
    expect(requests).toEqual(["DELETE /session/active"]);
    expect(f.navigations).toEqual([{ path: "/home", replace: true }]);
    expect(f.state().selectedId).toBeNull();
    expect(f.state().sessions.map((session) => session.id)).toEqual(["other"]);
    expect(f.state().remembered).toEqual({ unrelated: "unrelated-chat" });
    expect(f.state().status).toEqual({ other: "idle" });
    expect(getSessionDraft(f.workspaceId, "active")).toBeNull();
  } finally { server.stop(true); clearSessionDraft(f.workspaceId, "active"); }
});

test("deleting another chat keeps the open chat and its project memory", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(true) });
  const f = fixture(String(server.url));
  try {
    await f.actions.deleteSessionById("other");
    expect(f.navigations).toEqual([]);
    expect(f.state().selectedId).toBe("active");
    expect(f.state().remembered[f.workspaceId]).toBe("active");
    expect(f.state().sessions.map((session) => session.id)).toEqual(["active"]);
  } finally { server.stop(true); }
});

test("a rejected deletion keeps the chat, draft, and navigation intact", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ message: "Forbidden" }, { status: 403 }) });
  const f = fixture(String(server.url));
  saveSessionDraft(f.workspaceId, "active", { text: "Keep this draft", mode: "prompt" });
  try {
    await expect(f.actions.deleteSessionById("active")).rejects.toBeDefined();
    expect(f.navigations).toEqual([]);
    expect(f.state().selectedId).toBe("active");
    expect(f.state().sessions).toHaveLength(2);
    expect(f.state().remembered[f.workspaceId]).toBe("active");
    expect(getSessionDraft(f.workspaceId, "active")?.text).toBe("Keep this draft");
  } finally { server.stop(true); clearSessionDraft(f.workspaceId, "active"); }
});
