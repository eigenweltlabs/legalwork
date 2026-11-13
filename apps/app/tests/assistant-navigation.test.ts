import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { AssistantConversation } from "@legalwork/types/launcher";
import { assistantShellQueryKey, localAssistantDate, resolveAssistantConversation, type AssistantShellState } from "../src/react-app/launcher/assistant-navigation";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { currentAssistantQuery, resolveAssistantChat, seedSavedAssistant } from "../src/react-app/shell/assistant-navigation";

test("background Assistant observation never provisions, and a timed-out open can be retried explicitly", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 1 } } });
  let requests = 0;
  const today = current("2026-11-07", "recovered");
  const client = { baseUrl: "http://server", mainAssistantCurrent: async () => {
    requests++;
    if (requests === 1) throw new Error("Assistant setup timed out");
    return today;
  } };
  const observer = new QueryObserver(cache, currentAssistantQuery(client));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await Bun.sleep(10);
    expect(requests).toBe(0);
    await expect(resolveAssistantChat(client, cache, new Date(2026, 10, 7))).rejects.toThrow("timed out");
    await Bun.sleep(30);
    expect(requests).toBe(1);
    expect(await resolveAssistantChat(client, cache, new Date(2026, 10, 7))).toEqual(today);
    expect(observer.getCurrentResult().data).toEqual(today);
    expect(requests).toBe(2);
  } finally { unsubscribe(); cache.clear(); }
});

test("saved status advances the daily chat without initializing and never rolls it back", async () => {
  const cache = new QueryClient();
  let requests = 0;
  const client = { baseUrl: "http://server", mainAssistantCurrent: async () => { requests++; throw new Error("Not needed"); } };
  try {
    seedSavedAssistant(cache, client.baseUrl, current("2026-11-06", "yesterday"));
    seedSavedAssistant(cache, client.baseUrl, current("2026-11-07", "today"));
    seedSavedAssistant(cache, client.baseUrl, current("2026-11-06", "stale-response"));
    expect(await resolveAssistantChat(client, cache, new Date(2026, 10, 7))).toEqual(current("2026-11-07", "today"));
    expect(requests).toBe(0);
  } finally { cache.clear(); }
});

test("on-demand Assistant initialization preserves project field defaults", async () => {
  const cache = new QueryClient();
  const fields: Parameters<LegalworkServerClient["mainAssistantCurrent"]>[0] = [{ id: "client", label: "Client", type: "text", value: null }];
  let received: typeof fields;
  const client = { baseUrl: "http://server", mainAssistantCurrent: async (input?: typeof fields) => { received = input; return current("2026-11-07", "today"); } };
  try {
    await resolveAssistantChat(client, cache, new Date(2026, 10, 7), fields);
    expect(received).toEqual(fields);
  } finally { cache.clear(); }
});

const workspace = { id: "assistant", path: "/projects/Assistant", name: "Assistant", preset: "main-assistant", workspaceType: "local" as const };
const profile = { name: "Josi", icon: "cat" as const };
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

test("the local calendar date keys daily history, including just after midnight", () => {
  expect(localAssistantDate(new Date(2026, 9, 22, 0, 1))).toBe("2026-10-22");
  expect(localAssistantDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
});

function current(date: string, sessionId: string) { return { workspace, day: { date, sessionId }, profile }; }
