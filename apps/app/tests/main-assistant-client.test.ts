import { expect, test } from "bun:test";
import type { ProjectField } from "@legalwork/types/workspace";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

test("resolving the daily Assistant sends valid JSON with or without project defaults", async () => {
  const received: unknown[] = [];
  const current = { workspace: { id: "assistant" }, day: { date: "2026-10-07", sessionId: "today" }, profile: { name: "Johann", icon: "bird" } };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/assistant/current");
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer fixture");
      try {
        received.push(await request.json());
        return Response.json(current);
      } catch {
        return Response.json({ code: "invalid_json", message: "Invalid JSON body" }, { status: 400 });
      }
    },
  });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "fixture" });
    const fields: ProjectField[] = [{ id: "our_client", label: "Our client", type: "text", value: null }];
    expect(await client.mainAssistantCurrent()).toEqual(current);
    expect(await client.mainAssistantCurrent(fields)).toEqual(current);
    expect(await client.mainAssistantCurrent([])).toEqual(current);
    expect(received).toEqual([{}, { projectFields: fields }, { projectFields: [] }]);
  } finally {
    await server.stop(true);
  }
});


test("the Assistant panel reads only explicitly presented cards and hiding never presents a candidate", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    requests.push({ path: url.pathname + url.search, method: request.method, body: request.method === "POST" ? await request.json() : null });
    return Response.json(request.method === "GET" ? { items: [], nextCursor: null, unavailable: [] } : { ok: true });
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "fixture" });
    const item = { id: "request", revision: "current", workspaceId: "matter", sessionId: "child" };
    await client.assistantAttention();
    await client.assistantAttention("next/child");
    await client.setAssistantAttentionVisibility(item, false);
    expect(requests).toEqual([
      { path: "/assistant/attention?presented=true", method: "GET", body: null },
      { path: "/assistant/attention?presented=true&cursor=next%2Fchild", method: "GET", body: null },
      { path: "/assistant/attention/visibility", method: "POST", body: { ...item, visible: false } },
    ]);
  } finally { await server.stop(true); }
});
