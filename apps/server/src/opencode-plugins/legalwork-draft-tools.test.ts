import { expect, test } from "bun:test";
import pluginDefinition from "./legalwork-draft-tools.js";
import { nativePluginTools } from "./native-plugin-test-support.js";
const LegalWorkDraftTools = (context = {}) => nativePluginTools(pluginDefinition, context);

test("meeting requests use the editable card without a connected calendar or background save", async () => {
  const plugin = await LegalWorkDraftTools(), output = { system: [{type:"text",text:"Existing instructions"}] };
  await plugin.runtime.hook("session", "context", output);
  expect(output.system[0].text).toBe("Existing instructions");
  expect(output.system[1].text).toContain("legalwork_calendar_event_draft");
  expect(output.system[1].text).toContain("without connecting Google or Outlook");
  expect(output.system[1].text).toContain("do not save the event in the background");
  expect(output.system[1].text).toContain("guest emails in attendees");
  expect(plugin.tool.legalwork_calendar_event_draft.description).toContain("Add to LegalWork calendar");
});

test("draft tools use the chat's project, carry revisions, and surface server conflicts", async () => {
  const oldUrl = process.env.LEGALWORK_SERVER_URL, oldToken = process.env.LEGALWORK_SERVER_TOKEN, oldConnectorToken = process.env.LEGALWORK_CONNECTOR_TOKEN;
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/workspaces") return Response.json({ items: [{ id: "parent", path: "/matters" }, { id: "child", path: "/matters/current" }] });
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    expect(request.headers.get("x-legalwork-connector-token")).toBe(request.method === "POST" && url.pathname.endsWith("/email-drafts") ? "fixture-mail-capability" : null);
    requests.push({ path: url.pathname, method: request.method, body: request.method === "GET" ? null : await request.json() });
    return request.method === "PUT" ? Response.json({ error: "draft_conflict" }, { status: 409 }) : Response.json({ draft: { title: "untrusted content" } });
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin;
  process.env.LEGALWORK_SERVER_TOKEN = "fixture-token";
  process.env.LEGALWORK_CONNECTOR_TOKEN = "fixture-mail-capability";
  try {
    const { tool } = await LegalWorkDraftTools();
    const context = { directory: "/matters/current/subfolder", sessionID: "session" };
    const previous = { id: "08745cc6-4e59-4d81-953b-19d8ec595ee4", revision: "08745cc6-4e59-4d81-953b-19d8ec595ee5" };
    const event = { title: "Review", start: "2026-10-13", end: "2026-10-14" };
    const email = JSON.parse(await tool.legalwork_email_draft.execute({ subject: "Review" }, context));
    expect(email.ok).toBe(true);
    expect(email.instruction).toContain("untrusted");
    await tool.legalwork_email_draft_get.execute(previous, context);
    expect(JSON.parse(await tool.legalwork_email_draft_update.execute(previous, context)).ok).toBe(false);
    await tool.legalwork_calendar_event_draft.execute(event, context);
    await tool.legalwork_calendar_event_draft_get.execute(previous, context);
    expect(JSON.parse(await tool.legalwork_calendar_event_draft_update.execute({ ...event, ...previous }, context)).ok).toBe(false);
    expect(requests.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: "/workspace/child/email-drafts", method: "POST" },
      { path: `/workspace/child/email-drafts/${previous.id}`, method: "GET" },
      { path: `/workspace/child/email-drafts/${previous.id}`, method: "PUT" },
      { path: "/workspace/child/calendar-drafts", method: "POST" },
      { path: `/workspace/child/calendar-drafts/${previous.id}`, method: "GET" },
      { path: `/workspace/child/calendar-drafts/${previous.id}`, method: "PUT" },
    ]);
    expect(requests[0].body).toMatchObject({ account: "auto" });
    expect(requests[2].body).toMatchObject({ revision: previous.revision });
    expect(requests[5].body).toMatchObject({ ...event, revision: previous.revision });
    for (const unknown of [{}, { directory: "/elsewhere" }]) {
      expect(JSON.parse(await tool.legalwork_email_draft.execute({}, unknown)).ok).toBe(false);
      expect(JSON.parse(await tool.legalwork_calendar_event_draft.execute(event, unknown)).ok).toBe(false);
    }
    expect(requests).toHaveLength(6);
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl;
    if (oldConnectorToken === undefined) delete process.env.LEGALWORK_CONNECTOR_TOKEN; else process.env.LEGALWORK_CONNECTOR_TOKEN = oldConnectorToken;
    if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken;
  }
});
