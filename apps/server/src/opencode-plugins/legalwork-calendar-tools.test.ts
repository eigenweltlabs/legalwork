import { expect, test } from "bun:test";
import { LegalWorkCalendarTools } from "./legalwork-calendar-tools.js";

test("calendar tools use the chat's closest project and link the creating session", async () => {
  const oldUrl = process.env.LEGALWORK_SERVER_URL, oldToken = process.env.LEGALWORK_SERVER_TOKEN;
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/workspaces") return Response.json({ items: [
      { id: "parent", path: "/matters" }, { id: "child", path: "/matters/current" },
    ] });
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    requests.push({ path: url.pathname, method: request.method, body: request.method === "GET" ? null : await request.json() });
    return Response.json({});
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin;
  process.env.LEGALWORK_SERVER_TOKEN = "fixture-token";
  try {
    const { tool } = await LegalWorkCalendarTools();
    const context = { directory: "/matters/current/subfolder", sessionID: "ses_own" };
    await tool.legalwork_calendar_create.execute({ title: "Response", start: "2026-02-27", sessionIds: ["ses_own"] }, context);
    const itemId = "08745cc6-4e59-4d81-953b-19d8ec595ee4";
    await tool.legalwork_calendar_get.execute({ itemId }, context);
    await tool.legalwork_calendar_update.execute({ itemId, patch: { revision: 1, title: "Updated response" } }, context);
    expect(requests.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: "/workspace/child/calendar", method: "POST" },
      { path: `/workspace/child/calendar/${itemId}`, method: "GET" },
      { path: `/workspace/child/calendar/${itemId}`, method: "PATCH" },
    ]);
    expect(requests[0].body).toMatchObject({ sessionIds: ["ses_own"] });
    expect(requests[2].body).toEqual({ revision: 1, title: "Updated response" });
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken;
  }
});

test("calendar tools never fall back to the only project for an unrelated or unknown chat", async () => {
  const oldUrl = process.env.LEGALWORK_SERVER_URL, oldToken = process.env.LEGALWORK_SERVER_TOKEN;
  let calendarRequests = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/workspaces") return Response.json({ items: [{ id: "only", path: "/matters/current" }] });
    calendarRequests++;
    return Response.json({});
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin;
  process.env.LEGALWORK_SERVER_TOKEN = "fixture-token";
  try {
    const { tool } = await LegalWorkCalendarTools();
    for (const context of [{}, { directory: "/elsewhere" }, { directory: "/matters/current-other" }, { directory: "/matters/current/../outside" }]) {
      const result = JSON.parse(await tool.legalwork_calendar_create.execute({ title: "Response", start: "2026-02-27" }, context));
      expect(result.ok).toBe(false);
    }
    expect(calendarRequests).toBe(0);
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken;
  }
});
