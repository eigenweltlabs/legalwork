import { nativePluginTools } from "./native-plugin-test-support.js";
const LegalWorkProjectTools = (context = {}) => nativePluginTools(LegalWorkProjectToolsDefinition, context);
import { expect, test } from "bun:test";
import LegalWorkProjectToolsDefinition from "./legalwork-project-tools.js";

test("history provenance binds the actual caller, asks for the exact chat resource and retains complete records", async () => {
  const oldUrl = process.env.LEGALWORK_SERVER_URL, oldToken = process.env.LEGALWORK_SERVER_TOKEN;
  const full = "preserved-reference".repeat(12_000); let read = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/workspaces") return Response.json({ items: [{ id: "history", path: "/history" }] });
    expect(url.pathname).toBe("/workspace/history/sessions/ses_parent/history-provenance");
    expect(url.searchParams.get("callerSessionID")).toBe("ses_actual"); read++;
    return Response.json({ sessionID: "ses_parent", provenance: { version: 1, status: "available", messages: { msg_source: { attachments: [{ partID: "part", mime: "text/plain", bytes: "reference-only", reference: full }] } } } });
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture";
  try {
    const plugin = await LegalWorkProjectTools({ directory: "/history" }), asks: unknown[] = [];
    const result = await plugin.tool.legalwork_history_provenance.execute({ sessionID: "ses_parent", callerSessionID: "ses_forged" }, { sessionID: "ses_actual", directory: "/history", ask: async input => { asks.push(input); } });
    expect(JSON.parse(result).provenance.messages.msg_source.attachments[0].reference).toBe(full);
    expect(asks).toMatchObject([{ permission: "legalwork_history_provenance", patterns: ["session:ses_parent"], always: ["session:ses_parent"] }]);
    await expect(plugin.tool.legalwork_history_provenance.execute({ sessionID: "ses_parent" }, { sessionID: "ses_actual", directory: "/history", ask: async () => { throw new Error("History denied"); } })).rejects.toThrow("History denied"); expect(read).toBe(1);
    await plugin.runtime.close();
  } finally { server.stop(true); if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl; if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken; }
});

test("project tools resolve the closest project, carry pagination and reject unrelated directories", async () => {
  const oldUrl = process.env.LEGALWORK_SERVER_URL;
  const oldToken = process.env.LEGALWORK_SERVER_TOKEN;
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer fixture-token");
      const url = new URL(request.url);
      if (url.pathname === "/workspaces") return Response.json({ items: [
        { id: "parent", path: "/matters" }, { id: "child", path: "/matters/current" },
      ] });
      requests.push(url.pathname + url.search);
      return Response.json({ version: 1, project: { id: "child", name: "Example", fields: [] }, sections: [] });
    },
  });
  process.env.LEGALWORK_SERVER_URL = server.url.origin;
  process.env.LEGALWORK_SERVER_TOKEN = "fixture-token";
  try {
    const plugin = await LegalWorkProjectTools();
    const output = { system: [] };
    await plugin.runtime.hook("session", "context", output);
    expect(output.system.map((item: {text:string})=>item.text).join(" ")).toContain("untrusted");
    expect(output.system.map((item: {text:string})=>item.text).join(" ")).toContain("interactive cards");
    expect(output.system.map((item: {text:string})=>item.text).join(" ")).toContain("Do not assume the current project's recordings are the full library");
    expect(plugin.tool).toHaveProperty("legalwork_recordings_list");
    expect(plugin.tool).toHaveProperty("legalwork_recording_read");
    const result = await plugin.tool.legalwork_project_list.execute({ kind: "notes", cursor: "Notes/Page 1.md" }, { directory: "/matters/current/subfolder" });
    expect(JSON.parse(result).project.id).toBe("child");
    expect(requests[0]).toContain("/workspace/child/project/contents?");
    expect(requests[0]).toContain("cursor=Notes%2FPage+1.md");
    await plugin.tool.legalwork_project_read.execute({ kind: "recordings", id: "rec-1", offset: 12000 }, { directory: "/matters/current" });
    expect(requests[1]).toContain("kind=recordings&id=rec-1&offset=12000");
    const rejected = await plugin.tool.legalwork_project_list.execute({}, { directory: "/outside" });
    expect(JSON.parse(rejected).error).toContain("not inside");
    expect(requests.length).toBe(2);
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken;
  }
});

test("sessions receive folder configuration and can finish setup without storing a summary", async () => {
  const oldUrl = process.env.LEGALWORK_SERVER_URL;
  const oldToken = process.env.LEGALWORK_SERVER_TOKEN;
  let saved = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/workspaces") return Response.json({ items: [{ id: "mapped", path: "/mapped-project" }] });
    expect(url.pathname).toBe("/workspace/mapped/project/setup");
    if (request.method === "PATCH") {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      const body = await request.json();
      expect(body.revision).toBe(2); expect(body.name).toBe("New matter name");
      expect(body).not.toHaveProperty("context"); saved = true;
    }
    return Response.json({ revision: 2, remote: { initialization: saved ? "ready" : "pending", folders: [{ id: "mapped-folder" }] } });
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin;
  process.env.LEGALWORK_SERVER_TOKEN = "fixture-token";
  try {
    const plugin = await LegalWorkProjectTools({ directory: "/mapped-project" });
    const systemText = async () => {
      const output: { system: Array<{type:"text";text:string}> } = { system: [] };
      await plugin.runtime.hook("session", "context", output);
      return output.system.map((item: {text:string})=>item.text).join(" ");
    };
    const before = await systemText();
    expect(plugin.tool).not.toHaveProperty("legalwork_project_set_context");
    expect(plugin.tool).not.toHaveProperty("legalwork_project_get_context");
    expect(before).toContain("DEFAULT scope");
    expect(before).toContain("independent of LegalMemory");
    // The configuration itself changes during setup, so it arrives as a reminder.
    expect(before).not.toContain('"initialization"');
    const message = { sessionID: "ses_project", messageID:"msg_test", prompt:{text:"Set up the project"} };
    await plugin.runtime.hook("session", "prompt", message);
    expect(message.prompt.text).toContain('"initialization":"pending"');

    const result = { sessionID:"ses_project",status:"completed",result:{content: await plugin.tool.legalwork_project_complete_setup.execute({ revision: 2, name: "New matter name" }, { directory: "/mapped-project" }) } };
    await plugin.runtime.hook("tool", "execute.after", result);
    expect(JSON.stringify(result.result)).toContain('system-reminder topic=\\"project\\"');
    expect(JSON.stringify(result.result)).toContain('\\"initialization\\":\\"ready\\"');
    expect(JSON.stringify(result.result)).not.toContain("saved context");
    expect(await systemText()).toBe(before);
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken;
  }
});
