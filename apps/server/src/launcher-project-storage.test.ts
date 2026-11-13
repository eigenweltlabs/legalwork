import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { registerLauncherRoutes } from "./routes/launcher.js";
import { matchRoute, type Route, type RequestContext } from "./routes/registry.js";
import { LauncherFileIndex } from "./launcher-file-index.js";
import { searchLauncher, type LauncherSearchDeps } from "./launcher-search.js";
import type { WorkspaceInfo } from "./types.js";

test("migrated projects and wikis search, browse, save, retry and transfer from document roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-split-storage-"));
  const fileIndex = new LauncherFileIndex({ watch: false });
  const workspaces: WorkspaceInfo[] = ["project", "wiki"].map(id => ({ id, name: id, path: join(root, id, "engine"), contentPath: join(root, id, "documents"), preset: id === "wiki" ? "wiki" : "starter", workspaceType: "local" }));
  const [project, wiki] = workspaces;
  const documentRoot = project.contentPath!;
  const routes: Route[] = [];
  try {
    for (const workspace of workspaces) {
      await mkdir(workspace.path, { recursive: true });
      await mkdir(join(workspace.contentPath!, "Contracts"), { recursive: true });
      await writeFile(join(workspace.path, "Engine-only.txt"), "Internal working file");
      await writeFile(join(workspace.contentPath!, "Contracts", "Source.txt"), `${workspace.id} document`);
      // An old cached index must be replaced when the registered content root changes.
      await fileIndex.ensure(workspace.id, workspace.path, true);
    }
    const deps: LauncherSearchDeps = { workspaces: async () => ({ workspaces, unavailable: [] }), projectName: workspace => workspace.name,
      tasks: async () => [], recordings: null, fileIndex, sessionSearch: async () => ({ items: [] }), fileContentSearch: async () => ({ items: [] }) };
    const search = () => searchLauncher(deps, { query: "", kinds: ["files"], content: false, limit: 100 }, AbortSignal.timeout(3000));
    await search();
    for (const workspace of workspaces) await fileIndex.ensure(workspace.id, workspace.contentPath!, true);
    const result = await search();
    expect(result.items.some(item => item.title === "Engine-only.txt")).toBe(false);
    expect(result.items.filter(item => item.path === "Contracts/Source.txt").map(item => item.sourceKind).sort()).toEqual(["project", "wiki"]);

    const approvals: string[][] = [];
    // HTTP fixture: only the dependencies exercised by these routes are supplied.
    registerLauncherRoutes({ routes, config: { workspaces }, fileIndex,
      resolveWorkspace: async (_config: unknown, id: string) => { const workspace = workspaces.find(item => item.id === id); if (!workspace) throw new Error("Project removed"); return workspace; },
      jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }), readJsonBodyLimited: (request: Request) => request.json(),
      requireClientScope: () => {}, ensureWritable: () => {}, requireApproval: async (_ctx: unknown, request: { paths: string[] }) => { approvals.push(request.paths); },
      assistant: { profile: () => ({}) },
    } as unknown as Parameters<typeof registerLauncherRoutes>[0]);
    const call = async (method: string, path: string, body?: unknown) => {
      const request = new Request(`http://localhost${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      const route = matchRoute(routes, method, new URL(request.url).pathname);
      if (!route) throw new Error("Missing route");
      return (await route.handler({ request, url: new URL(request.url), params: {}, actor: { type: "host" } } as RequestContext)).json();
    };
    const browse = await call("GET", "/launcher/browse?workspaceId=project&path=Contracts");
    expect(browse.items.map((item: LauncherSearchResult) => item.path)).toEqual(["Contracts/Source.txt"]);
    const save = { workspaceId: project.id, operationId: "storage_document_1", folder: "Contracts", name: "Created", format: "txt", text: "Saved in the document folder" };
    expect(await call("POST", "/launcher/documents", save)).toEqual({ path: "Contracts/Created.txt" });
    expect(await call("POST", "/launcher/documents", save)).toEqual({ path: "Contracts/Created.txt" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0][0]).toBe(await realpath(join(documentRoot, "Contracts/Created.txt")));
    expect(await readFile(join(documentRoot, "Contracts/Created.txt"), "utf8")).toBe(save.text);
    expect(await stat(join(project.path, ".legalwork/launcher-documents/storage_document_1.json")).then(() => true)).toBe(true);
    expect(await stat(join(documentRoot, ".legalwork")).catch(() => null)).toBeNull();
    expect(await call("GET", "/launcher/preview?kind=files&workspaceId=project&id=Contracts/Created.txt")).toMatchObject({ text: save.text });
    expect(await call("POST", "/launcher/files/transfer", { sourceWorkspaceId: project.id, targetWorkspaceId: wiki.id, path: "Contracts/Created.txt", folder: "Contracts", mode: "move" })).toEqual({ ok: true, path: "Contracts/Created.txt" });
    expect(await stat(join(documentRoot, "Contracts/Created.txt")).catch(() => null)).toBeNull();
    expect(await readFile(join(wiki.contentPath!, "Contracts/Created.txt"), "utf8")).toBe(save.text);
    const visible = await call("POST", "/launcher/files/visible", { items: result.items });
    expect(visible.items.some((item: LauncherSearchResult) => item.title === "Engine-only.txt")).toBe(false);
    await rm(join(documentRoot, "Contracts/Source.txt"));
    expect((await call("POST", "/launcher/files/visible", { items: result.items })).items.some((item: LauncherSearchResult) => item.workspaceId === project.id && item.path === "Contracts/Source.txt")).toBe(false);
  } finally { fileIndex.dispose(); await rm(root, { recursive: true, force: true }); }
});
