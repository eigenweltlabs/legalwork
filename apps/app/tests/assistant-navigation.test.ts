import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AssistantConversation } from "@legalwork/types/launcher";
import { assistantShellQueryKey, localAssistantDate, resolveAssistantConversation, type AssistantShellState } from "../src/react-app/launcher/assistant-navigation";

const workspace = { id: "assistant", path: "/projects/Assistant", name: "Assistant", preset: "main-assistant", workspaceType: "local" as const };
const profile = { name: "Josi", icon: "cat" as const };
const conversation = (id: string, updatedAt: number): AssistantConversation => ({ id, workspaceId: "assistant", sessionId: `ses_${id}`, title: id, kind: "conversation", date: null, createdAt: updatedAt, updatedAt, pinned: false, archivedAt: null, origin: "panel" });

test("navigation resumes the current conversation without creating one, and creates only when none exists", async () => {
  const cache = new QueryClient();
  let created = 0;
  const existing = conversation("conv_1", 10);
  const client = { baseUrl: "http://server", assistantConversationCurrent: async () => ({ workspace, conversation: existing, day: null, profile }), createAssistantConversation: async () => { created++; return { conversation: conversation("conv_new", 20) }; } };
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

test("the local calendar date keys daily history, including just after midnight", () => {
  expect(localAssistantDate(new Date(2026, 9, 22, 0, 1))).toBe("2026-10-22");
  expect(localAssistantDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
});
