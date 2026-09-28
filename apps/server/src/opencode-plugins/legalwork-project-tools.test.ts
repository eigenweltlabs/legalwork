import { expect, test } from "bun:test";
import { LegalWorkProjectTools } from "./legalwork-project-tools.js";

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
    await plugin["experimental.chat.system.transform"]({}, output);
    expect(output.system.join(" ")).toContain("untrusted");
    expect(output.system.join(" ")).toContain("interactive cards");
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
    const first = await LegalWorkProjectTools({ directory: "/mapped-project" });
    const initial: { system: string[] } = { system: [] };
    await first["experimental.chat.system.transform"]({}, initial);
    expect(first.tool).not.toHaveProperty("legalwork_project_set_context");
    expect(first.tool).not.toHaveProperty("legalwork_project_get_context");
    expect(initial.system.join(" ")).toContain("DEFAULT scope");
    expect(initial.system.join(" ")).toContain("independent of LegalMemory");
    await first.tool.legalwork_project_complete_setup.execute({ revision: 2, name: "New matter name" }, { directory: "/mapped-project" });
    const next = await LegalWorkProjectTools({ directory: "/mapped-project" });
    const subsequent: { system: string[] } = { system: [] };
    await next["experimental.chat.system.transform"]({}, subsequent);
    expect(subsequent.system.join(" ")).not.toContain("saved context");
    expect(subsequent.system.join(" ")).toContain('"initialization":"ready"');
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = oldToken;
  }
});
