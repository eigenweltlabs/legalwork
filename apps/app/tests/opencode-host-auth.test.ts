import { describe, expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";

describe("OpenCode host authorization", () => {
  test("Native create and paginated session reads use the local host credential", async () => {
    const requests: { path: string; auth: string | null; host: string | null }[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ path, auth: request.headers.get("authorization"), host: request.headers.get("x-legalwork-host-token") });
      return Response.json(request.method==="GET" ? {data:[],cursor:{}} : { id: "session-test" });
    } });
    try {
      const client = createClient(`${server.url.origin}/workspace/wiki/opencode`, "/wiki", { token: "test-client", hostToken: "test-host", mode: "legalwork" });
      await client.session.create({ location:{directory:"/wiki"} });
      await client.session.list();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual({ path: "/workspace/wiki/opencode/api/session", auth: "Bearer test-client", host: "test-host" });
      expect(requests[1]).toEqual({ path: "/workspace/wiki/opencode/api/session", auth: "Bearer test-client", host: "test-host" });
    } finally { server.stop(true); }
  });
  test("basic OpenCode auth does not send the LegalWork host credential", async () => {
    let header: string | null = "not-called";
    const server = Bun.serve({ port: 0, fetch(request) { header = request.headers.get("x-legalwork-host-token"); return Response.json({ id: "s" }); } });
    try {
      await createClient(server.url.origin, "/wiki", { username: "user", password: "pass", hostToken: "test-host", mode: "basic" }).session.create({});
      expect(header).toBeNull();
    } finally { server.stop(true); }
  });
  test("remote workspaces never inherit the desktop host secret", () => {
    const local = { baseUrl: "http://localhost:5555", token: "local-client", hostToken: "local-host" };
    const remote = resolveWorkspaceEndpoint({ id: "rem_test", workspaceType: "remote", baseUrl: "https://worker.example", legalworkToken: "remote-client" }, local);
    const own = resolveWorkspaceEndpoint({ id: "wiki", workspaceType: "local" }, local);
    expect(remote?.hostToken).toBeUndefined();
    expect(remote).toBeNull();
    expect(own?.hostToken).toBe("local-host");
  });
});
