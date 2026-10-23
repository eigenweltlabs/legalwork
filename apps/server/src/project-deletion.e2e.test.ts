import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { readProjectFileLinks, updateProjectFileLinks } from "./project-file-links.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { deleteProjectData } from "./project-deletion.js";
import { calendarStore } from "./calendar/store.js";
import { taskStore } from "./task-store.js";
import { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import { ViewRepository, workspaceViewFiles } from "./views/repository.js";
import { DocumentPreparation } from "./document-preparation/service.js";
import { OcrManager } from "./ocr/manager.js";
import { OcrService } from "./ocr/service.js";
import { withProjectMutation } from "./project-deletion-gate.js";
import { ReviewService } from "./reviews/service.js";
import { ReviewDefaults } from "./reviews/storage.js";
import { CorpusService } from "./corpus/service.js";
import { projectSyncStore } from "./project-sync-store.js";
import { recordProjectFolderOrigin, projectFolderOrigin } from "./project-folder-origin.js";
import { runtimeDbPath } from "./runtime-db.js";

const cleanup: Array<() => void | Promise<void>> = [];
const previousData = process.env.LEGALWORK_DATA_DIR;
const previousDb = process.env.LEGALWORK_RUNTIME_DB;
const previousProjects = process.env.LEGALWORK_PROJECTS_DIR;
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
  if (previousData === undefined) delete process.env.LEGALWORK_DATA_DIR; else process.env.LEGALWORK_DATA_DIR = previousData;
  if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
  if (previousProjects === undefined) delete process.env.LEGALWORK_PROJECTS_DIR; else process.env.LEGALWORK_PROJECTS_DIR = previousProjects;
});
type Chat = { id: string; directory: string; parentID?: string; time: { created: number; updated: number; archived?: number } };
const reviewSchema = z.object({ token: z.string(), deleteFolder: z.boolean(), folderItems: z.object({ total: z.number(), items: z.array(z.object({ name: z.string(), kind: z.enum(["file", "folder", "link"]) })) }).nullable(), chatCount: z.number(), taskCount: z.number(), calendarEntryCount: z.number(), scheduledTaskCount: z.number(), unsavedDashboardCount: z.number(), copies: z.array(z.object({ projectId: z.string() })) });
async function fixture(external = false, origin: "created_by_app" | "selected_existing" | "unknown" = external ? "selected_existing" : "created_by_app") {
  const root = await mkdtemp(join(tmpdir(), "legalwork-project-deletion-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  process.env.LEGALWORK_DATA_DIR = join(root, "data");
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  delete process.env.LEGALWORK_PROJECTS_DIR;
  const managed = join(root, "projects"), folder = join(external ? root : managed, "source"), other = join(managed, "other"), third = join(managed, "third"), outside = join(root, "external");
  for (const path of [folder, other, third, outside]) await mkdir(path, { recursive: true });
  await writeFile(join(folder, "contract.docx"), "Original contract");
  await writeFile(join(outside, "keep.txt"), "External original");
  const chats = new Map<string, Chat>();
  const addChat = (id: string, directory = folder, parentID?: string) => chats.set(id, { id, directory, parentID, time: { created: 1, updated: 1 } });
  addChat("chat"); addChat("child", folder, "chat"); addChat("unrelated", other);
  const state: { busy: boolean; failDelete: boolean; deleted: string[]; unsavedDashboard: boolean; beforeMessages?: () => Promise<void>; beforeDelete?: () => Promise<void> } = { busy: false, failDelete: false, deleted: [], unsavedDashboard: false };
  const dashboardPreview = { status: "preview", owner: { kind: "workspace", id: "source" }, input: { version: 1, title: "Unsaved dashboard", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Unsaved")', queries: {} } };
  const remove = (id: string) => { for (const child of [...chats.values()].filter(chat => chat.parentID === id)) remove(child.id); chats.delete(id); };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/session") return Response.json([...chats.values()].slice(0, Number(url.searchParams.get("limit") || 100)));
    if (path === "/session/status") return Response.json(state.busy ? { chat: { type: "busy" } } : {});
    const match = path.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (match) {
      const id = match[1];
      if (match[2] === "/children") return Response.json([...chats.values()].filter(chat => chat.parentID === id));
      if (match[2] === "/message") { await state.beforeMessages?.(); return Response.json(id === "chat" && state.unsavedDashboard ? [{ parts: [{ type: "tool", tool: "view_create", callID: "dashboard", state: { status: "completed", output: JSON.stringify(dashboardPreview) } }] }] : []); }
      if (!chats.has(id)) return Response.json({ error: "not_found" }, { status: 404 });
      if (request.method === "DELETE") {
        await state.beforeDelete?.();
        if (state.failDelete) return Response.json({ error: "unavailable" }, { status: 503 });
        state.deleted.push(id); remove(id); return Response.json(true);
      }
      return Response.json(chats.get(id));
    }
    return Response.json({});
  } });
  cleanup.push(() => { engine.stop(true); });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "server.json"),
    projectsDirectory: managed, opencodeBaseUrl: `http://127.0.0.1:${engine.port}`, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [ { id: "source", name: "Source", path: folder }, { id: "other", name: "Other", path: other }, { id: "third", name: "Third", path: third } ].map(item => ({ ...item, preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${engine.port}` })),
    authorizedRoots: [folder, other, third], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  await writeFile(config.configPath!, JSON.stringify({ workspaces: config.workspaces, authorizedRoots: config.authorizedRoots }));
  if (origin !== "unknown") await recordProjectFolderOrigin(config, config.workspaces[0], origin);
  const server = await startServer(config); cleanup.push(() => server.stop());
  const request = (path: string, method = "GET", body?: unknown, host = true) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers: { authorization: "Bearer client", ...(host ? { "x-legalwork-host-token": "host" } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const review = async () => {
    const response = await request("/workspaces/source/deletion");
    const payload = await response.json();
    expect(response.status).toBe(200);
    return reviewSchema.parse(payload);
  };
  const linked = async (destination: string, path = "contract.docx") => updateProjectFileLinks(destination, links => [...links, {
    id: crypto.randomUUID(), name: "contract.docx", folder: "", createdAt: 1,
    source: { projectId: "source", workspaceId: "source", path, name: "contract.docx" },
  }]);
  return { root, folder, managed, other, third, outside, state, chats, addChat, config, request, review, linked };
}

test("deletes managed files and all chats; retains external targets and independent copies in every linked project", async () => {
  const f = await fixture();
  await symlink(f.outside, join(f.folder, "linked-folder"));
  await symlink(join(f.outside, "keep.txt"), join(f.folder, "linked-file.txt"));
  await f.linked(f.other); await f.linked(f.third);
  await writeFile(join(f.other, "contract.docx"), "Keep existing destination");
  for (let index = 0; index < 150; index++) f.addChat(`older-${index}`);
  const archived = f.chats.get("older-0")!; archived.time.archived = 123;
  const review = await f.review();
  expect(review).toMatchObject({ deleteFolder: true, chatCount: 152 });
  expect(review.folderItems).toMatchObject({ total: 3 });
  expect(review.copies).toHaveLength(2);
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token });
  const payload = await response.json();
  expect(response.status).toBe(200);
  expect(payload).toMatchObject({ ok: true, copiedFiles: 2 });
  expect(await stat(f.folder).catch(() => null)).toBeNull();
  expect([...f.chats.keys()]).toEqual(["unrelated"]);
  expect(await readFile(join(f.outside, "keep.txt"), "utf8")).toBe("External original");
  expect(await readFile(join(f.other, "contract.docx"), "utf8")).toBe("Keep existing destination");
  expect(await readFile(join(f.other, "contract (2).docx"), "utf8")).toBe("Original contract");
  expect(await readFile(join(f.third, "contract.docx"), "utf8")).toBe("Original contract");
  expect(await readProjectFileLinks(f.other)).toEqual([]);
  expect(await readProjectFileLinks(f.third)).toEqual([]);
  await writeFile(join(f.other, "contract (2).docx"), "Edited independently");
  expect(await readFile(join(f.third, "contract.docx"), "utf8")).toBe("Original contract");
  expect(f.config.workspaces.map(item => item.id)).toEqual(["other", "third"]);
  expect(JSON.parse(await readFile(f.config.configPath!, "utf8")).workspaces.map((item: { id: string }) => item.id)).toEqual(["other", "third"]);
});

test("an external project folder remains intact while its chats and registration are deleted", async () => {
  const f = await fixture(true), review = await f.review();
  expect(review.deleteFolder).toBe(false);
  expect(review.folderItems).toBeNull();
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token });
  expect(response.status).toBe(200); await response.arrayBuffer();
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect([...f.chats.keys()]).toEqual(["unrelated"]);
});

test("a project root symlink outside managed storage is retained with its target", async () => {
  const f = await fixture();
  await rm(f.folder, { recursive: true }); await symlink(f.outside, f.folder);
  const review = await f.review(); expect(review.deleteFolder).toBe(false);
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token });
  expect(response.status).toBe(200); await response.arrayBuffer();
  expect(await readFile(join(f.folder, "keep.txt"), "utf8")).toBe("External original");
});

test("reports an unsaved dashboard only when a project chat actually has one", async () => {
  const f = await fixture();
  expect((await f.review()).unsavedDashboardCount).toBe(0);
  f.state.unsavedDashboard = true;
  expect((await f.review()).unsavedDashboardCount).toBe(1);
});

test("does not list calendar entries or tasks already moved to trash", async () => {
  const f = await fixture(), calendar = await calendarStore(f.config), tasks = await taskStore(f.config);
  const entry = calendar.create("source", { title: "Removed deadline", start: "2099-10-16" });
  calendar.remove("source", entry.id, entry.revision);
  const task = tasks.createTask({ projectId: "source", title: "Removed task" }, { userId: null, name: null, email: null });
  tasks.deleteTask(task.id);
  expect(await f.review()).toMatchObject({ calendarEntryCount: 0, taskCount: 0 });
});

test("new chats invalidate confirmation; active chats and foreign descendants block deletion", async () => {
  const f = await fixture(), first = await f.review();
  f.addChat("new");
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: first.token })).status).toBe(409);
  const current = await f.review(); f.state.busy = true;
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: current.token })).status).toBe(409);
  f.state.busy = false; f.addChat("foreign-child", f.other, "chat");
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: current.token })).status).toBe(409);
  expect(f.state.deleted).toEqual([]);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
});

test("a failed copy keeps the source, links and chats; engine failures never delete project files", async () => {
  const f = await fixture(); await f.linked(f.other, "missing.docx");
  const review = await f.review();
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).not.toBe(200);
  expect(f.state.deleted).toEqual([]);
  expect(await readProjectFileLinks(f.other)).toHaveLength(1);
  await updateProjectFileLinks(f.other, () => []);
  const retry = await f.review(); f.state.failDelete = true;
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: retry.token })).status).toBe(502);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect(f.config.workspaces.some(item => item.id === "source")).toBe(true);
});

test("destructive deletion requires host credentials and a review; old DELETE remains non-destructive", async () => {
  const f = await fixture();
  expect((await f.request("/workspaces/source/deletion", "GET", undefined, false)).status).toBe(401);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: "x" }, false)).status).toBe(401);
  expect((await f.request("/workspaces/source/delete-project", "POST", {})).status).toBe(400);
  expect((await f.request("/workspaces/source", "DELETE")).status).toBe(200);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect(f.state.deleted).toEqual([]);
});

test("deletion excludes new chats and cross-project link mutations until it finishes", async () => {
  const f = await fixture(), review = await f.review();
  let entered = () => {}, release = () => {};
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.state.beforeMessages = async () => { entered(); await held; };
  const deleting = f.request("/workspaces/source/delete-project", "POST", { token: review.token });
  try {
    await reached;
    expect((await f.request("/workspace/source/opencode/session", "POST", {})).status).toBe(409);
    expect((await f.request("/workspace/other/files/links", "POST", {})).status).toBe(409);
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(409);
  } finally { release(); }
  expect((await deleting).status).toBe(200);
});

test("overlapping project roots are never recursively deleted", async () => {
  const f = await fixture();
  f.config.workspaces.find(item => item.id === "other")!.path = join(f.folder, "nested");
  await mkdir(join(f.folder, "nested"));
  expect((await f.request("/workspaces/source/deletion")).status).toBe(409);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
});

test("copies the actual linked source when its workspace differs from the owning project", async () => {
  const f = await fixture();
  await writeFile(join(f.third, "contract.docx"), "The actual linked original");
  await f.linked(f.other);
  await updateProjectFileLinks(f.other, links => links.map(link => ({ ...link, source: { ...link.source, workspaceId: "third" } })));
  const review = await f.review();
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
  expect(await readFile(join(f.other, "contract.docx"), "utf8")).toBe("The actual linked original");
  expect(await readFile(join(f.third, "contract.docx"), "utf8")).toBe("The actual linked original");
  expect(await readProjectFileLinks(f.other)).toEqual([]);
});

test("connected originals become independent local copies without a remote delete", async () => {
  const f = await fixture();
  await f.linked(f.other);
  await updateProjectFileLinks(f.other, links => links.map(link => ({ ...link, source: { ...link.source, connectionId: "drive" } })));
  const workspace = f.config.workspaces[0], review = await f.review();
  const read: string[] = [];
  await deleteProjectData({ config: f.config, workspace, token: review.token, engine: createOpencodeClient({ baseUrl: workspace.baseUrl }),
    readConnected: async link => { read.push(link.source.connectionId!); return new TextEncoder().encode("Remote original"); },
    cleanupSession: async () => {}, beforeFiles: async () => {},
  });
  expect(read).toEqual(["drive"]);
  expect(await readFile(join(f.other, "contract.docx"), "utf8")).toBe("Remote original");
  expect(await readProjectFileLinks(f.other)).toEqual([]);
});

test("clears only this project's scheduled tasks, calendar and task records", async () => {
  const f = await fixture(), calendar = await calendarStore(f.config), tasks = await taskStore(f.config);
  const scheduled = await ScheduledTaskStore.open(runtimeDbPath(f.config));
  const input = { title: "Future work", prompt: "Summarize", schedule: { kind: "once", startAt: "2099-10-06T13:00:00", timeZone: "Europe/Vienna" },
    projectAccess: "project", sessionId: null, reuseChat: false, pinSession: true, model: null };
  const own = scheduled.create("source", input), kept = scheduled.create("other", input);
  calendar.create("source", { title: "Remove deadline", start: "2099-10-16" });
  const keptDeadline = calendar.create("other", { title: "Keep deadline", start: "2099-10-16" });
  const actor = { userId: null, name: null, email: null };
  const ownTask = tasks.createTask({ projectId: "source", title: "Remove task" }, actor);
  const keptTask = tasks.createTask({ projectId: "other", title: "Keep task" }, actor);
  const projects = await projectSyncStore(f.config);
  projects.saveLink({ workspaceId: "source", projectId: "remote-source", orgId: "firm", origin: "local", role: "owner", ownerUserId: null,
    settings: { access: "members", memberIds: [], scope: { documents: true, notes: true, tasks: true, recordings: false, metadata: true, reviews: false } },
    confirmed: true, remoteUpdatedAt: null, filesReconciledAt: null, state: "active", allowDeletions: false, lastSyncAt: null, lastError: null, report: null });
  const review = await f.review();
  expect(review).toMatchObject({ taskCount: 1, calendarEntryCount: 1, scheduledTaskCount: 1 });
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token });
  expect(response.status).toBe(200);
  expect(projects.tasksRemoved("remote-source", "firm")).toBe(true);
  expect(projects.linkByWorkspace("source")).toBeNull();
  expect(scheduled.list("source")).toEqual([]);
  expect(scheduled.runs(own.id)).toEqual([]);
  expect(scheduled.list("other").map(task => task.id)).toEqual([kept.id]);
  expect(calendar.list("source", true)).toEqual([]);
  expect(calendar.list("other").map(item => item.id)).toEqual([keptDeadline.id]);
  expect(tasks.getTask(ownTask.id)).toBeNull();
  expect(tasks.getTask(keptTask.id)?.id).toBe(keptTask.id);
});

test("registration persistence failure remains retryable even after the folder was removed", async () => {
  const f = await fixture(), review = await f.review();
  const path = f.config.configPath!;
  await rm(path); await mkdir(path);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(409);
  expect(f.config.workspaces.some(workspace => workspace.id === "source")).toBe(true);
  expect(await stat(f.folder).catch(() => null)).toBeNull();
  await rm(path, { recursive: true }); await writeFile(path, "{}");
  const retry = await f.review();
  expect(retry.chatCount).toBe(0);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: retry.token })).status).toBe(200);
  expect(f.config.workspaces.some(workspace => workspace.id === "source")).toBe(false);
});


test("duplicate dashboard links become distinct, readable and editable copies", async () => {
  const f = await fixture();
  const repository = new ViewRepository({ kind: "workspace", id: "source" }, workspaceViewFiles(f.folder));
  const input = { version: 1, title: "Saved dashboard", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Hello")', queries: {},
    datasets: { source: { rows: [{ title: "Evidence" }], total: 1, revision: "original", asOf: 1, truncated: false } } } satisfies import("@legalwork/types/views").ViewInput;
  const view = await repository.create(input), path = await repository.location(view.id);
  await mkdir(join(f.other, "Documents"));
  // An existing independent copy with the original ID must also remain usable.
  await writeFile(join(f.other, "original.view.json"), await readFile(join(f.folder, path)));
  await updateProjectFileLinks(f.other, () => ["", "Documents"].map(folder => ({ id: crypto.randomUUID(), name: folder ? "Dashboard v1.2" : "dashboard.view.json", folder, createdAt: 1,
    source: { projectId: "source", workspaceId: "source", path, name: "dashboard.view.json" } })));
  const review = await f.review();
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
  const copies = new ViewRepository({ kind: "workspace", id: "other" }, workspaceViewFiles(f.other));
  const listed = await copies.list();
  expect(listed.issues).toEqual([]); expect(listed.items).toHaveLength(3);
  expect(new Set(listed.items.map(item => item.id)).size).toBe(3);
  for (const item of listed.items) expect(await copies.read(item.id)).toMatchObject(input);
  const copied = listed.items.find(item => item.id !== view.id)!;
  await copies.update(copied.id, { ...input, title: "Edited copy" }, copied.revision);
  expect((await copies.read(view.id)).title).toBe("Saved dashboard");
  expect(await readProjectFileLinks(f.other)).toEqual([]);
});

test("an invalid linked dashboard blocks deletion without discarding the source or link", async () => {
  const f = await fixture();
  await writeFile(join(f.folder, "broken.view.json"), "{broken");
  await f.linked(f.other, "broken.view.json");
  const review = await f.review();
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(409);
  expect(f.state.deleted).toEqual([]);
  expect(await readProjectFileLinks(f.other)).toHaveLength(1);
  expect(await readFile(join(f.folder, "broken.view.json"), "utf8")).toBe("{broken");
});

test("queued and cancelled document preparation block deletion until their final writes finish", async () => {
  const f = await fixture();
  await writeFile(join(f.folder, "document.pdf"), "fixture rendered by injected renderer");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const jobs: Promise<void>[] = [];
  const preparation = new DocumentPreparation(new OcrManager(join(f.root, "ocr")), {
    runBackground: run => { const job = withProjectMutation(f.config, run); jobs.push(job); return job; },
    snapshot: async () => ({ fingerprint: "fixture", service: new OcrService([{ info: { id: "test", label: "Test", execution: "local", model: "test", languages: null, regions: true, warnings: [] },
      recognize: async () => ({ text: "Evidence", regions: [], truncated: false }) }], "test") }),
    open: async () => ({ pageCount: 1, close: async () => {}, page: async number => {
      entered(); await held;
      return { nativeText: "Confidential source text. ".repeat(20), image: { pageNumber: number, mimeType: "image/png", width: 10, height: 10, data: new Uint8Array() } };
    } }),
  });
  try {
    const first = await preparation.start(f.folder, { files: ["document.pdf"], ocr: "missing-text" });
    await started;
    const queued = await preparation.start(f.folder, { files: ["document.pdf"], ocr: "missing-text" });
    expect(queued.status).toBe("queued");
    await preparation.cancel(f.folder, first.id); await preparation.cancel(f.folder, queued.id);
    const review = await f.review();
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(409);
    expect(f.state.deleted).toEqual([]);
    release(); await Promise.all(jobs);
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
    expect(await stat(f.folder).catch(() => null)).toBeNull();
  } finally { release(); await Promise.allSettled(jobs); }
});

test("background corpus classification blocks deletion through cancellation and final persistence", async () => {
  const f = await fixture();
  await writeFile(join(f.folder, "evidence.txt"), "Evidence");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const jobs: Promise<void>[] = [];
  const corpus = new CorpusService({
    selection: async () => ({ providerId: "test", model: "test" }),
    extract: async () => ({ text: "Evidence", pages: [{ page: 1, text: "Evidence" }], complete: true, extraction: "native", hash: "source" }),
    infer: async () => { entered(); await held; return { model: "test", answers: { answer: { type: "noul", noul: 1 } } }; },
  }, run => { const job = withProjectMutation(f.config, run); jobs.push(job); return job; });
  try {
    const job = await corpus.query(f.config.workspaces[0], { paths: ["evidence.txt"], question: "Does this contain evidence?", waitSeconds: 0 });
    await started;
    await corpus.query(f.config.workspaces[0], { jobId: job.jobId, cancel: true, waitSeconds: 0 });
    const review = await f.review();
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(409);
    release(); await Promise.all(jobs);
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
    expect(await stat(f.folder).catch(() => null)).toBeNull();
  } finally { release(); await Promise.allSettled(jobs); await corpus.stop(); }
});


test("a detached tabular review blocks deletion until results and history have finished saving", async () => {
  const f = await fixture(), workspace = f.config.workspaces[0];
  await writeFile(join(f.folder, "evidence.md"), "Assignment is permitted.");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const jobs: Promise<void>[] = [];
  const service = new ReviewService({
    models: async () => ({ settings: { mode: "llm", llm: { providerId: "test", model: "test" }, jev: null }, allowedKinds: ["yes_no"], errors: [],
      models: [{ backend: "llm", providerId: "test", model: "test", name: "Test", providerName: "Test" }] }),
    execute: async (_workspace, _review, question, evidence) => {
      entered(); await held;
      return { value: "Yes", reason: "", citations: [], confidence: null, evidence: "uncited", backend: "llm", providerId: "test", model: "test", requestedModel: "test",
        sourceHash: evidence.hash, prompt: question, completedAt: Date.now(), chunks: [] };
    },
  }, new DocumentPreparation(new OcrManager(join(f.root, "ocr"))), new ReviewDefaults(join(f.root, "defaults")), undefined,
  run => { const job = withProjectMutation(f.config, run); jobs.push(job); return job; });
  try {
    const saved = await service.create(workspace, { requestId: crypto.randomUUID(), name: "Review", files: ["evidence.md"],
      columns: [{ key: "assignment", label: "Assignment", question: "Is assignment permitted?", kind: "yes_no", options: [], hint: "" }] });
    await service.start(workspace, saved.id, { revision: saved.revision });
    await started;
    const review = await f.review();
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(409);
    expect(f.state.deleted).toEqual([]);
    release(); await Promise.all(jobs);
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
    expect(await stat(f.folder).catch(() => null)).toBeNull();
  } finally { release(); await Promise.allSettled(jobs); await service.stop(); }
});


test("selected source folders inside the default project directory are retained, including attachments", async () => {
  const f = await fixture(false, "selected_existing");
  await mkdir(join(f.folder, ".legalwork", "attachments"), { recursive: true });
  await writeFile(join(f.folder, ".legalwork", "attachments", "uploaded.txt"), "Keep this upload");
  // Project metadata / caller-supplied flags cannot grant recursive deletion.
  await writeFile(join(f.folder, ".legalwork", "project.json"), JSON.stringify({ folderOrigin: "created_by_app" }));
  const review = await f.review(); expect(review.deleteFolder).toBe(false);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token, deleteFolder: true, folderOrigin: "created_by_app" })).status).toBe(200);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect(await readFile(join(f.folder, ".legalwork", "attachments", "uploaded.txt"), "utf8")).toBe("Keep this upload");
  expect([...f.chats.keys()]).toEqual(["unrelated"]);
});

for (const backup of [false, true]) {
  test(`legacy folders inside managed storage are deleted with chats and linked copies, backup=${backup}`, async () => {
    const f = await fixture(false, "unknown"), destination = join(f.root, "backups");
    await mkdir(destination); await f.linked(f.other); await f.linked(f.third);
    const review = await f.review(); expect(review.deleteFolder).toBe(true);
    const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token, ...(backup ? { backupDirectory: destination } : {}) });
    expect(response.status).toBe(200);
    const result = z.object({ backupPath: z.string().nullable() }).parse(await response.json());
    if (backup) {
      expect(result.backupPath).not.toBeNull();
      expect(await readFile(join(result.backupPath!, "contract.docx"), "utf8")).toBe("Original contract");
    } else expect(result.backupPath).toBeNull();
    expect(await stat(f.folder).catch(() => null)).toBeNull();
    expect([...f.chats.keys()]).toEqual(["unrelated"]);
    for (const folder of [f.other, f.third]) {
      expect(await readProjectFileLinks(folder)).toEqual([]);
      expect(await readFile(join(folder, "contract.docx"), "utf8")).toBe("Original contract");
    }
  });
}

test("legacy folders outside managed storage retain files while chats and registration are removed", async () => {
  const f = await fixture(true, "unknown"); await f.linked(f.other);
  const review = await f.review(); expect(review.deleteFolder).toBe(false);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect(await readFile(join(f.other, "contract.docx"), "utf8")).toBe("Original contract");
  expect(await readProjectFileLinks(f.other)).toEqual([]);
  expect([...f.chats.keys()]).toEqual(["unrelated"]);
  expect(f.config.workspaces.some(item => item.id === "source")).toBe(false);
});

test("a legacy folder reached through an internal directory symlink keeps its external files", async () => {
  const f = await fixture(true, "unknown"), alias = join(f.managed, "linked");
  await symlink(f.root, alias);
  f.config.workspaces[0].path = join(alias, "source");
  const review = await f.review(); expect(review.deleteFolder).toBe(false);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect([...f.chats.keys()]).toEqual(["unrelated"]);
});

test("the managed root itself and similar path prefixes do not grant legacy deletion rights", async () => {
  const f = await fixture(false, "unknown");
  f.config.projectsDirectory = f.folder;
  expect((await f.review()).deleteFolder).toBe(false);
  f.config.projectsDirectory = join(f.root, "project");
  expect((await f.review()).deleteFolder).toBe(false);
});

test("legacy classification resolves the configured root and invalidates confirmation when it changes", async () => {
  const f = await fixture(false, "unknown"), alias = join(f.root, "projects-alias");
  await symlink(f.managed, alias);
  process.env.LEGALWORK_PROJECTS_DIR = alias;
  f.config.projectsDirectory = join(f.root, "unused-default");
  const review = await f.review(); expect(review.deleteFolder).toBe(true);
  delete process.env.LEGALWORK_PROJECTS_DIR;
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(409);
  expect((await f.review()).deleteFolder).toBe(false);
  expect(f.state.deleted).toEqual([]);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
});

test("creation records provenance and explicitly reattaching a folder treats it as a source folder", async () => {
  const f = await fixture();
  const response = await f.request("/workspaces/local", "POST", { name: "New project", preset: "starter", folderMode: "default" });
  expect(response.status).toBe(201);
  const id = z.object({ activeId: z.string() }).parse(await response.json()).activeId;
  const workspace = f.config.workspaces.find(item => item.id === id)!;
  expect(await projectFolderOrigin(f.config, workspace)).toBe("created_by_app");
  expect(reviewSchema.parse(await (await f.request(`/workspaces/${id}/deletion`)).json()).deleteFolder).toBe(true);
  expect((await f.request("/workspaces/local", "POST", { name: "Existing source", preset: "starter", folderMode: "selected", folderPath: workspace.path, folderOrigin: "created_by_app" })).status).toBe(201);
  expect(await projectFolderOrigin(f.config, workspace)).toBe("selected_existing");
  expect(reviewSchema.parse(await (await f.request(`/workspaces/${id}/deletion`)).json()).deleteFolder).toBe(false);
});

test("changing the default location does not change an app-created folder's deletion policy", async () => {
  const f = await fixture();
  f.config.projectsDirectory = join(f.root, "new-default");
  const review = await f.review(); expect(review.deleteFolder).toBe(true);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
  expect(await stat(f.folder).catch(() => null)).toBeNull();
});

test("a different folder at the same path does not inherit deletion rights or an old confirmation", async () => {
  const f = await fixture(), before = await f.review();
  await rename(f.folder, join(f.root, "original")); await mkdir(f.folder);
  await writeFile(join(f.folder, "keep.txt"), "New folder supplied by user");
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: before.token })).status).toBe(409);
  const review = await f.review(); expect(review.deleteFolder).toBe(false);
  expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token })).status).toBe(200);
  expect(await readFile(join(f.folder, "keep.txt"), "utf8")).toBe("New folder supplied by user");
});

test("back up and delete preserves hidden files, empty folders, binary bytes and working links without overwriting", async () => {
  const f = await fixture(), destination = join(f.root, "backups");
  await mkdir(join(destination, "source backup"), { recursive: true });
  await writeFile(join(destination, "source backup", "keep.txt"), "Previous backup");
  await mkdir(join(f.folder, ".legalwork", "attachments"), { recursive: true });
  const bytes = Buffer.from([0, 1, 255, 128, 0]);
  await writeFile(join(f.folder, ".legalwork", "attachments", "original.bin"), bytes);
  await mkdir(join(f.folder, "empty"));
  await symlink(join(f.folder, "contract.docx"), join(f.folder, "internal"));
  await symlink("../../external/keep.txt", join(f.folder, "external"));
  await symlink(f.outside, join(f.folder, "linked-folder"));
  const review = await f.review();
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token, backupDirectory: destination });
  const body = await response.json(); expect(response.status).toBe(200);
  const saved = z.object({ backupPath: z.string() }).parse(body).backupPath;
  expect(saved).toBe(await realpath(join(destination, "source backup (2)")));
  expect(await readFile(join(saved, ".legalwork", "attachments", "original.bin"))).toEqual(bytes);
  expect(await readdir(join(saved, "empty"))).toEqual([]);
  expect(await readFile(join(saved, "internal"), "utf8")).toBe("Original contract");
  expect(await readFile(join(saved, "external"), "utf8")).toBe("External original");
  expect(await readlink(join(saved, "linked-folder"))).toBe(await realpath(f.outside));
  expect(await readFile(join(destination, "source backup", "keep.txt"), "utf8")).toBe("Previous backup");
  expect(await stat(f.folder).catch(() => null)).toBeNull();
  expect([...f.chats.keys()]).toEqual(["unrelated"]);
});

test("invalid backup destinations leave all project files, chats and links untouched", async () => {
  const f = await fixture(); await f.linked(f.other);
  await mkdir(join(f.folder, "nested")); await symlink(f.folder, join(f.root, "alias"));
  const review = await f.review();
  for (const backupDirectory of [f.folder, join(f.folder, "nested"), join(f.root, "alias"), join(f.root, "missing"), join(f.folder, "contract.docx"), "relative/path"]) {
    expect((await f.request("/workspaces/source/delete-project", "POST", { token: review.token, backupDirectory })).status).toBe(400);
    expect(f.state.deleted).toEqual([]);
    expect(await readProjectFileLinks(f.other)).toHaveLength(1);
    expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  }
});

test("if files change after backup, the project folder remains with its latest content", async () => {
  const f = await fixture(), destination = join(f.root, "backups"); await mkdir(destination);
  f.state.beforeDelete = async () => { await writeFile(join(f.folder, "contract.docx"), "Edited outside LegalWork during deletion"); };
  const review = await f.review();
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token, backupDirectory: destination });
  expect(response.status).toBe(409);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Edited outside LegalWork during deletion");
  expect(await readFile(join(destination, "source backup", "contract.docx"), "utf8")).toBe("Original contract");
  expect(f.config.workspaces.some(item => item.id === "source")).toBe(true);
});

test("an uncopyable link fails the backup before deleting chats, files or project links", async () => {
  const f = await fixture(), destination = join(f.root, "backups"); await mkdir(destination);
  await f.linked(f.other);
  await symlink("loop", join(f.folder, "loop"));
  const review = await f.review();
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token, backupDirectory: destination });
  expect(response.status).toBe(409);
  expect(z.object({ code: z.string() }).parse(await response.json()).code).toBe("project_backup_failed");
  expect(f.state.deleted).toEqual([]);
  expect(await readProjectFileLinks(f.other)).toHaveLength(1);
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect(await readdir(destination)).toEqual([]);
});

test("a backup modified after copying prevents deletion of the original folder", async () => {
  const f = await fixture(), destination = join(f.root, "backups"); await mkdir(destination);
  f.state.beforeDelete = async () => { await writeFile(join(destination, "source backup", "contract.docx"), "Overwritten backup"); };
  const review = await f.review();
  const response = await f.request("/workspaces/source/delete-project", "POST", { token: review.token, backupDirectory: destination });
  expect(response.status).toBe(409);
  expect(z.object({ code: z.string() }).parse(await response.json()).code).toBe("project_backup_changed");
  expect(await readFile(join(f.folder, "contract.docx"), "utf8")).toBe("Original contract");
  expect(f.config.workspaces.some(item => item.id === "source")).toBe(true);
});
