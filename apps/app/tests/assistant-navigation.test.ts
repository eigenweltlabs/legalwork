import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { resolveAssistantChat } from "../src/react-app/shell/assistant-navigation";

function current(date: string, sessionId: string): Awaited<ReturnType<LegalworkServerClient["mainAssistantCurrent"]>> {
  return { workspace: { id: "assistant", path: "/projects/Assistant", name: "Assistant", preset: "main-assistant", workspaceType: "local" }, day: { date, sessionId }, profile: { name: "Josi", icon: "cat" } };
}

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
