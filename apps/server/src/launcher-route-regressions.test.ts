import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLauncherRoutes } from "./routes/launcher.js";
import { matchRoute, type Route, type RequestContext } from "./routes/registry.js";

// These HTTP-handler fixtures implement only the dependencies used by the route
// under test, rather than starting unrelated server services.
function context(request: Request): RequestContext { return { request, url: new URL(request.url), params: {}, actor: { type: "host" } } as RequestContext; }

test("saved searches have no registered API or launcher catalog source", async () => {
  const routes: Route[] = [];
  registerLauncherRoutes({ routes, config: { workspaces: [] }, requireClientScope: () => {},
    quickActions: { list: () => [] }, jsonResponse: (body: unknown) => Response.json(body),
  } as unknown as Parameters<typeof registerLauncherRoutes>[0]);
  for (const [method, path] of [["GET", "/launcher/searches"], ["POST", "/launcher/searches"], ["DELETE", "/launcher/searches/old"], ["POST", "/launcher/searches/old/used"]]) {
    expect(matchRoute(routes, method, path)).toBeNull();
  }
  const route = matchRoute(routes, "GET", "/launcher/catalog");
  if (!route) throw new Error("Missing launcher catalog");
  const response = await route.handler(context(new Request("http://localhost/launcher/catalog")));
  expect(await response.json()).toEqual({ entries: [], unavailable: [] });
});

test("copy/move rejects destination links, rechecks after approval and never replaces an existing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-transfer-"));
  const source = join(root, "source"), target = join(root, "target"), outside = join(root, "outside");
  try {
    await Promise.all([mkdir(source), mkdir(target), mkdir(outside)]);
    await writeFile(join(source, "file.txt"), "source");
    await symlink(outside, join(target, "linked"));
    const workspaces = [{ id: "source", name: "Source", path: source }, { id: "target", name: "Target", path: target }];
    let approved = 0, swap = false, createExisting = false;
    const routes: Route[] = [];
    registerLauncherRoutes({ routes, config: { workspaces }, jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
      requireClientScope: () => {}, ensureWritable: () => {}, readJsonBodyLimited: (request: Request) => request.json(),
      resolveWorkspace: async (_config: unknown, id: string) => workspaces.find(item => item.id === id),
      assistant: { profile: () => ({ name: "Assistant" }) }, fileIndex: { ensure: async () => {} },
      requireApproval: async () => {
        approved++;
        if (swap) { await rm(join(target, "folder"), { recursive: true }); await symlink(outside, join(target, "folder")); }
        if (createExisting) await writeFile(join(target, "file.txt"), "keep this");
      },
    } as unknown as Parameters<typeof registerLauncherRoutes>[0]);
    const route = matchRoute(routes, "POST", "/launcher/files/transfer")!;
    const send = (folder: string, mode = "copy") => route.handler(context(new Request("http://localhost/launcher/files/transfer", { method: "POST", body: JSON.stringify({ sourceWorkspaceId: "source", targetWorkspaceId: "target", path: "file.txt", folder, mode }) })));
    await expect(send("linked")).rejects.toThrow("linked folder");
    expect(approved).toBe(0);
    await mkdir(join(target, "folder")); swap = true;
    await expect(send("folder")).rejects.toThrow("linked folder");
    expect(await readFile(join(outside, "file.txt"), "utf8").catch(() => null)).toBeNull();
    swap = false; createExisting = true;
    await expect(send("", "move")).rejects.toThrow();
    expect(await readFile(join(target, "file.txt"), "utf8")).toBe("keep this");
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("source");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Work applies status before pagination and exposes older running jobs", async () => {
  const routes: Route[] = [];
  const assistant = { id: "assistant", name: "Assistant", path: "/fixture/assistant", preset: "main-assistant" };
  const project = { id: "matter", name: "Matter", path: "/fixture/matter" };
  const tracked = Array.from({ length: 141 }, (_, index) => ({ sourceWorkspaceId: assistant.id, sourceSessionId: "origin", workspaceId: project.id, sessionId: `job_${index}`, title: `Job ${index}`, scope: "fixture", model: null }));
  const empty = async () => ({ data: [] }), emptyV2 = async () => ({ data: { data: [] } });
  const client = { session: { get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID, title: sessionID, directory: project.path, time: { created: 1, updated: 2 } } }), status: async () => ({ data: { job_140: { type: "busy" } } }), messages: empty }, question: { list: empty }, permission: { list: empty }, v2: { session: { question: { list: emptyV2 }, permission: { list: emptyV2 } } } };
  registerLauncherRoutes({ routes, config: { workspaces: [assistant, project] }, requireClientScope: () => {},
    jsonResponse: (body: unknown) => Response.json(body), resolveWorkspace: async (_config: unknown, id: string) => id === assistant.id ? assistant : project,
    assistant: { profile: () => ({ name: "Assistant" }) }, delegations: { list: () => tracked }, conversations: { bySession: () => ({ id: "origin" }) }, sessionQueue: { list: () => [] }, client: () => client,
  } as unknown as Parameters<typeof registerLauncherRoutes>[0]);
  const route = matchRoute(routes, "GET", "/assistant/work")!;
  const run = async (query: string) => (await route.handler(context(new Request(`http://localhost/assistant/work?${query}`)))).json();
  const running = await run("status=running");
  expect(running.items.map((item: { sessionId: string }) => item.sessionId)).toEqual(["job_140"]);
  expect(running.nextOffset).toBeNull();
  const page = await run("limit=100");
  expect(page.items).toHaveLength(100); expect(page.nextOffset).toBe(100);
  expect((await run("limit=100&offset=100")).items).toHaveLength(41);
});

test("preview accepts the public query and reads an exact file or recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-preview-route-"));
  try {
    await writeFile(join(root, "note.txt"), "Exact file preview");
    const workspace = { id: "project", name: "Project", path: root };
    const routes: Route[] = [];
    registerLauncherRoutes({ routes, config: { workspaces: [workspace], recorder: { readRecording: async (id: string) => ["recording", "ephemeral"].includes(id) ? {
      meta: { id, title: "Meeting", createdAt: 1, durationMs: 60_000, status: "ready", ephemeral: id === "ephemeral" }, segments: [{ text: "Exact transcript" }],
    } : null } }, requireClientScope: () => {}, jsonResponse: (body: unknown) => Response.json(body),
      resolveWorkspace: async () => workspace,
    } as unknown as Parameters<typeof registerLauncherRoutes>[0]);
    const route = matchRoute(routes, "GET", "/launcher/preview");
    if (!route) throw new Error("Missing launcher preview");
    const preview = async (query: string) => (await route.handler(context(new Request(`http://localhost/launcher/preview?${query}`)))).json();
    expect(await preview("kind=files&id=note.txt&workspaceId=project")).toMatchObject({ kind: "files", title: "note.txt", text: "Exact file preview" });
    expect(await preview("kind=recordings&id=recording")).toMatchObject({ kind: "recordings", title: "Meeting", text: "Exact transcript" });
    await expect(preview("kind=files&id=missing.txt&workspaceId=project")).rejects.toThrow();
    await expect(preview("kind=recordings&id=deleted")).rejects.toThrow("no longer exists");
    await expect(preview("kind=recordings&id=ephemeral")).rejects.toThrow("no longer exists");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("chat preview checks live ownership before reading any transcript", async () => {
  const workspace = { id: "project", name: "Project", path: "/fixture/project" };
  let session: { id: string; title: string; directory: string; time: { created: number; updated: number; archived?: number } } | null = null;
  let reads = 0;
  const routes: Route[] = [];
  registerLauncherRoutes({ routes, config: { workspaces: [workspace] }, requireClientScope: () => {}, jsonResponse: (body: unknown) => Response.json(body),
    resolveWorkspace: async () => workspace,
    client: () => ({ session: { get: async () => ({ data: session }), messages: async () => { reads++; return { data: [] }; } } }),
  } as unknown as Parameters<typeof registerLauncherRoutes>[0]);
  const route = matchRoute(routes, "GET", "/launcher/preview");
  if (!route) throw new Error("Missing launcher preview");
  const run = () => route.handler(context(new Request("http://localhost/launcher/preview?kind=chats&id=chat&workspaceId=project")));
  await expect(run()).rejects.toThrow("no longer available");
  session = { id: "chat", title: "Private", directory: "/fixture/another-project", time: { created: 1, updated: 2 } };
  await expect(run()).rejects.toThrow("no longer available");
  session = { ...session, directory: workspace.path, time: { created: 1, updated: 2, archived: 3 } };
  await expect(run()).rejects.toThrow("no longer available");
  expect(reads).toBe(0);
  session = { ...session, time: { created: 1, updated: 2 } };
  expect((await run()).status).toBe(200);
  expect(reads).toBe(1);
});
