import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AssistantConversation } from "@legalwork/types/launcher";
import { assistantChatIdentity, assistantShellQueryKey, resolveAssistantConversation, type AssistantShellState } from "../src/react-app/launcher/assistant-navigation";
import { isAssistantConversation } from "../src/react-app/domains/session/chat/assistant-conversation";
import { createPanelTabStore, workspacePanelKey } from "../src/react-app/domains/session/panel/panel-tab-store";
import { syncRouteChatTab } from "../src/react-app/domains/session/panel/route-chat-tab";
import type { LegalworkWorkspaceInfo } from "../src/app/lib/legalwork-server";
import type { AssistantProfile } from "@legalwork/types/main-assistant";

const workspace: LegalworkWorkspaceInfo = { id: "assistant", path: "/projects/Assistant", name: "Assistant", preset: "main-assistant", workspaceType: "local" };
const profile: AssistantProfile = { name: "Josi", icon: "cat" };
const conversation = (id: string, updatedAt: number): AssistantConversation => ({ id, workspaceId: "assistant", sessionId: `ses_${id}`, title: id, kind: "conversation", date: null, createdAt: updatedAt, updatedAt, pinned: false, archivedAt: null, origin: "panel" });

test("navigation resumes the current conversation without creating one, and creates only when none exists", async () => {
  const cache = new QueryClient();
  let created = 0;
  const existing = conversation("conv_1", 10);
  const client = { baseUrl: "http://server", ensureAssistantWorkspace: async () => { throw new Error("not set up"); }, assistantConversationCurrent: async () => ({ workspace, conversation: existing, day: null, profile }), createAssistantConversation: async () => { created++; return { conversation: conversation("conv_new", 20) }; } };
  try {
    expect((await resolveAssistantConversation(client, cache)).sessionId).toBe("ses_conv_1");
    expect(created).toBe(0);
    expect(cache.getQueryData<AssistantShellState>(assistantShellQueryKey(client.baseUrl))?.conversation?.id).toBe("conv_1");
    const fresh = { ...client, assistantConversationCurrent: async () => ({ workspace, conversation: null, day: { date: "2026-10-21", sessionId: "day-21" }, profile }) };
    expect((await resolveAssistantConversation(fresh, cache, "navigation")).sessionId).toBe("ses_conv_new");
    expect(created).toBe(1);
    await expect(resolveAssistantConversation({ ...client, assistantConversationCurrent: async () => ({ workspace: null, conversation: null, day: null, profile }) }, cache)).rejects.toThrow("not set up");
  } finally { cache.clear(); }
});

test("a resolved launcher conversation opens its Assistant tab without a daily chat or session-list metadata", () => {
  const opened = conversation("opened", 10);
  const state: AssistantShellState = { workspace, profile, day: null, conversation: conversation("newest", 20) };
  const identity = assistantChatIdentity(state, opened.sessionId, opened);
  expect(isAssistantConversation(opened.sessionId, identity?.sessionId)).toBe(true);
  expect(identity?.date).toBeNull();
  const panels = createPanelTabStore();
  const scope = workspacePanelKey(workspace.id);
  panels.getState().setAssistantWorkspace(workspace.id);
  if (isAssistantConversation(opened.sessionId, identity?.sessionId)) {
    syncRouteChatTab(panels, { scope, sessionId: opened.sessionId, label: profile.name, previousRoute: null, restoringTab: false });
  }
  expect(panels.getState().sessions[scope].tabs).toMatchObject([{ type: "chat", sessionId: opened.sessionId }]);
});

test("Assistant identity recognizes the current explicit conversation and preserves historical daily dates", () => {
  const current = conversation("current", 20);
  const state: AssistantShellState = { workspace, profile, day: null, conversation: current };
  expect(assistantChatIdentity(state, current.sessionId, null)?.sessionId).toBe(current.sessionId);
  const history: AssistantConversation = { ...conversation("history", 1), kind: "day", date: "2026-10-21" };
  expect(assistantChatIdentity(state, history.sessionId, history)).toEqual({ sessionId: history.sessionId, date: "2026-10-21" });
});

test("unresolved links, project conversations and subagents do not become the Assistant", () => {
  const state: AssistantShellState = { workspace, profile, day: null, conversation: null };
  const other = { ...conversation("other", 10), workspaceId: "project" };
  expect(assistantChatIdentity(state, other.sessionId, other)).toBeUndefined();
  expect(assistantChatIdentity(state, "unknown", conversation("different", 10))).toBeUndefined();
  expect(assistantChatIdentity(undefined, "unknown", null)).toBeUndefined();
  const day = { sessionId: "daily", date: "2026-11-13" };
  expect(assistantChatIdentity({ ...state, day }, "daily", null)).toEqual(day);
  expect(isAssistantConversation("child", day.sessionId, { parentID: day.sessionId })).toBe(false);
});
