import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
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

function current(date: string, sessionId: string): Awaited<ReturnType<LegalworkServerClient["mainAssistantCurrent"]>> {
  return { workspace: { id: "assistant", path: "/projects/Assistant", name: "Assistant", preset: "main-assistant", workspaceType: "local" }, day: { date, sessionId }, profile: { name: "Josi", icon: "cat" } };
}

test("saved Assistant history is available while the online current-day request is unresolved", async () => {
  const cache = new QueryClient();
  const saved = current("2026-10-07", "saved-chat");
  const next = current("2026-10-08", "today");
  let finish = (_value: typeof next) => {};
  const client = { baseUrl: "http://server", mainAssistantCurrent: () => new Promise<typeof next>(resolve => { finish = resolve; }) };
  const request = resolveAssistantChat(client, cache, new Date(2026, 9, 8));
  try {
    seedSavedAssistant(cache, client.baseUrl, saved);
    expect(cache.getQueryData(["main-assistant", client.baseUrl])).toEqual(saved);
    expect(cache.isFetching()).toBe(1);
    finish(next);
    expect(await request).toEqual(next);
    seedSavedAssistant(cache, client.baseUrl, saved);
    expect(cache.getQueryData(["main-assistant", client.baseUrl])).toEqual(next);
  } finally { finish(next); cache.clear(); }
});

test("saved Assistant bootstrap stays scoped to its server and cannot invent a first chat", () => {
  const cache = new QueryClient();
  try {
    seedSavedAssistant(cache, "http://old-server", current("2026-10-07", "old-chat"));
    seedSavedAssistant(cache, "http://new-server", { workspace: null, profile: { name: null, icon: "flower" }, day: null });
    expect(cache.getQueryData(["main-assistant", "http://new-server"])).toBeUndefined();
    expect(cache.getQueryData(["main-assistant", "http://old-server"])).toEqual(current("2026-10-07", "old-chat"));
  } finally { cache.clear(); }
});

test("opening today's known Assistant never waits for another provisioning request", async () => {
  const cache = new QueryClient();
  const client = { baseUrl: "http://server", mainAssistantCurrent: async () => { throw new Error("Navigation must use the existing chat"); } };
  const today = current("2026-10-07", "today");
  cache.setQueryData(["main-assistant", client.baseUrl], today);
  try {
    expect(await resolveAssistantChat(client, cache, new Date(2026, 9, 7, 23, 59))).toEqual(today);
  } finally { cache.clear(); }
});

test("midnight resolves the new daily chat and concurrent navigation shares one request", async () => {
  const cache = new QueryClient();
  let requests = 0;
  const tomorrow = current("2026-10-08", "tomorrow");
  const client = { baseUrl: "http://server", mainAssistantCurrent: async () => { requests++; return tomorrow; } };
  cache.setQueryData(["main-assistant", client.baseUrl], current("2026-10-07", "yesterday"));
  try {
    expect(await Promise.all([
      resolveAssistantChat(client, cache, new Date(2026, 9, 8, 0, 0)),
      resolveAssistantChat(client, cache, new Date(2026, 9, 8, 0, 0)),
    ])).toEqual([tomorrow, tomorrow]);
    expect(requests).toBe(1);
    expect(cache.getQueryData(["main-assistant", client.baseUrl])).toEqual(tomorrow);
  } finally { cache.clear(); }
});

test("a different server cannot reuse the previous server's daily Assistant", async () => {
  const cache = new QueryClient();
  let requests = 0;
  const next = current("2026-10-07", "other-server-chat");
  cache.setQueryData(["main-assistant", "http://previous-server"], current("2026-10-07", "previous-chat"));
  const client = { baseUrl: "http://new-server", mainAssistantCurrent: async () => { requests++; return next; } };
  try {
    expect(await resolveAssistantChat(client, cache, new Date(2026, 9, 7))).toEqual(next);
    expect(requests).toBe(1);
  } finally { cache.clear(); }
});
