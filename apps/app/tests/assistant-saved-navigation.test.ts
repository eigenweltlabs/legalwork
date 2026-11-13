import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { resolveAssistantChat, seedSavedAssistant } from "../src/react-app/shell/assistant-navigation";

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
