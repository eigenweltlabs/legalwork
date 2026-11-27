import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import type { WorkspaceInfo } from "./types.js";
import { registerFileRoutes } from "./routes/files.js";
import { matchRoute, type RequestContext, type Route } from "./routes/registry.js";

test("capture saves only into an existing project document folder without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-capture-save-"));
  const documents = join(root, "documents"), engine = join(root, "engine"), outside = join(root, "outside");
  try {
    await Promise.all([mkdir(join(documents, "Evidence"), { recursive: true }), mkdir(engine), mkdir(outside)]);
    await symlink(outside, join(documents, "Outside"), "junction");
    const routes: Route[] = [];
    const workspace: WorkspaceInfo = { id: "project", name: "Synthetic project", contentPath: documents, path: engine, preset: "starter", workspaceType: "local" };
    registerFileRoutes({
      routes, config: backOfficeTestConfig(root, { workspaces: [workspace] }), jsonResponse: (data: unknown, status?: number) => Response.json(data, { status }),
      readJsonBody: (request: Request) => request.json(), ensureWritable: () => {}, requireApproval: async () => {}, requireClientScope: () => {},
      resolveWorkspace: async () => workspace,
      resolveInboxEnabled: () => false, resolveOutboxEnabled: () => false, resolveInboxMaxBytes: () => 1000, scopeRank: () => 9,
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7d8AAAAASUVORK5CYII=", "base64");
    const save = (path: string) => {
      const url = new URL("http://localhost/workspace/project/files/raw");
      url.search = new URLSearchParams({ path, createOnly: "true", requireExistingParent: "true" }).toString();
      const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: png });
      const matched = matchRoute(routes, request.method, url.pathname);
      if (!matched) throw new Error("Capture save route missing");
      return matched.handler({ request, url, params: matched.params, actor: { type: "host" } } as RequestContext);
    };
    expect((await (await save("Evidence/Region.png")).json()).path).toBe("Evidence/Region.png");
    expect(await readFile(join(documents, "Evidence", "Region.png"))).toEqual(png);
    expect(await stat(join(engine, "Evidence")).catch(() => null)).toBeNull();
    await expect(save("Evidence/Region.png")).rejects.toMatchObject({ status: 409, code: "file_exists" });
    await expect(save("Missing/Region.png")).rejects.toMatchObject({ status: 404, code: "dir_not_found" });
    expect(await stat(join(documents, "Missing")).catch(() => null)).toBeNull();
    await expect(save("Outside/Region.png")).rejects.toMatchObject({ status: 403 });
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
