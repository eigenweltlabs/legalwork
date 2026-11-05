import { expect, test } from "bun:test";
import { resolveDocumentProject } from "../src/react-app/domains/session/artifacts/document-project";

test("task documents and browsers resolve a manually selected server's own project list and saved session directory", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let bootstraps = 0, foreign = false;
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer manual-project-fixture");
    const pathname = new URL(request.url).pathname; calls.push(pathname);
    if (pathname === "/workspaces") return Response.json({ items: [{ id: "manual", name: "Actual server project", path: "/server/manual", preset: "starter", workspaceType: "local" }] });
    if (pathname === "/workspace/manual/sessions/chat") return Response.json({ item: { id: "chat", agent: "legalwork", location: { directory: foreign ? "/another-project" : "/server/manual" }, title: "Actual server chat", time: { created: 1, updated: 1 } } });
    return new Response(null, { status: 404 });
  } });
  const storage = new Map([["legalwork.server.urlOverride", server.url.origin], ["legalwork.server.token", "manual-project-fixture"]]);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null }, __LEGALWORK_ELECTRON__: { invokeDesktop: async (command: string) => { if (command === "workspaceBootstrap") bootstraps++; throw new Error("The local desktop server is unavailable; a manual server is selected."); } } } });
  try {
    const project = await resolveDocumentProject("chat");
    expect(project).toMatchObject({ projectId: "manual", workspaceId: "manual", workspaceRoot: "/server/manual" });
    expect(project.client.baseUrl).toBe(server.url.origin); expect(project.client.token).toBe("manual-project-fixture");
    expect(bootstraps).toBe(0); expect(calls).toEqual(["/workspaces", "/workspace/manual/sessions/chat"]);
    foreign = true; await expect(resolveDocumentProject("chat")).rejects.toThrow("project is unavailable");
  } finally { server.stop(true); if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});
