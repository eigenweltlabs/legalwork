import { describe, expect, test } from "bun:test";
import { createDocumentRuntime } from "../src/react-app/domains/session/artifacts/document-runtime-store";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";

function fixture() {
  const runtime = createDocumentRuntime(() => ({ className: "" }));
  const clients = { a: { baseUrl: "http://a" }, b: { baseUrl: "http://b" } };
  const projects = { left: "a", right: "a", elsewhere: "b" };
  runtime.setResolver(session => {
    const project = projects[session];
    if (!project) throw new Error("Unknown task");
    return { projectId: project, workspaceId: project, workspaceRoot: `/${project}`, client: clients[project] };
  });
  function document(project, path, execute = async () => ({ ok: true, path })) {
    const entry = runtime.ensure({ client: clients[project], workspaceId: project, workspaceRoot: `/${project}`, sessionId: `workspace:${project}`,
      tab: { id: `file:${path}`, type: "artifact", value: path, label: path, preview: "word" }, onClose() {} });
    entry.registration = { surface: { id: path, path, name: path, kind: "document", format: "docx", workspaceId: project, editable: true }, ready: () => true, dirty: () => false,
      action: { id: "document.agent_tool", execute } };
    return entry;
  }
  return { runtime, document, clients };
}

test("foreground session.open selects its exact chat without replacing a selected live editor or another project's layout", async () => {
  const previous = usePanelTabStore.getState().sessions;
  usePanelTabStore.setState({ sessions: {} });
  try {
    const { runtime, document } = fixture(), panels = usePanelTabStore.getState();
    const entry = document("a", "one.docx", async () => ({ ok: true, path: "one.docx", text: "Unchanged unsaved draft", selection: "clause 4" }));
    entry.registration.dirty = () => true;
    const registration = entry.registration;
    await runtime.select({ sessionId: "left", path: "one.docx" });
    panels.adoptChat("workspace:a", "left", "Owned chat");
    panels.openTab("workspace:a", entry.props.tab, "main", "right");
    panels.adoptChat("workspace:b", "elsewhere", "Other project");
    panels.selectTab("workspace:a", entry.props.tab.id);
    const before = usePanelTabStore.getState().sessions["workspace:a"], other = usePanelTabStore.getState().sessions["workspace:b"];
    const read = await runtime.execute("document.agent_tool", { sessionId: "left" });
    const navigations = [];
    expect(await runtime.openSession({ sessionId: "left" }, undefined, path => navigations.push(path))).toEqual({ ok: true, navigatedTo: "left" });
    const after = usePanelTabStore.getState().sessions["workspace:a"];
    expect(after.panes.find(pane => pane.id === after.focusedPaneId).activeTabId).toBe("chat:left");
    expect(after.tabs).toEqual(before.tabs);
    expect(after.tree).toEqual(before.tree);
    expect(after.panes.find(pane => pane.tabIds.includes(entry.props.tab.id))).toEqual(before.panes.find(pane => pane.tabIds.includes(entry.props.tab.id)));
    expect(usePanelTabStore.getState().sessions["workspace:b"]).toBe(other);
    expect(runtime.entries.get(entry.key)).toBe(entry);
    expect(entry.registration).toBe(registration);
    expect(await runtime.execute("document.agent_tool", { sessionId: "left" })).toEqual(read);
    expect(navigations).toEqual(["/workspace/a/session/left"]);
  } finally { usePanelTabStore.setState({ sessions: previous }); }
});

test("background session.open never steals focus and unknown tasks cannot alter panels", async () => {
  const { runtime } = fixture(), before = usePanelTabStore.getState().sessions, navigations = [];
  expect(await runtime.openSession({ sessionId: "right" }, "left", path => navigations.push(path))).toMatchObject({ ok: true, sessionId: "right", workspaceId: "a", background: true });
  expect(runtime.taskSessions.get("left")).toBe("right");
  expect(usePanelTabStore.getState().sessions).toBe(before);
  expect(navigations).toEqual([]);
  await expect(runtime.openSession({ sessionId: "unknown" }, undefined, path => navigations.push(path))).rejects.toThrow("Unknown task");
  expect(usePanelTabStore.getState().sessions).toBe(before);
  expect(navigations).toEqual([]);
});

describe("task document runtime", () => {
  test("legacy attachment copies retain their format without a visible document pane", async () => {
    const { runtime, document, clients } = fixture();
    const source = ".legalwork/attachments/fixture/Contract.docx___Matter_A";
    const copied = [];
    clients.a.copyWorkspaceFile = async (...args) => { copied.push(args); };
    clients.a.statWorkspaceFile = async (_workspace, path) => ({ path, exists: true, kind: "file", size: 100, updatedAt: 1 });
    const output = document("a", "Revised.docx");
    expect(await runtime.open({ sessionId: "left", path: source, copyTo: "Revised.docx" })).toMatchObject({ ok: true, copied: true, liveEditing: true, path: "Revised.docx" });
    expect(copied).toEqual([["a", source, "Revised.docx"]]);
    expect(output.destinations.size).toBe(0);
    await expect(runtime.open({ sessionId: "left", path: source, copyTo: "Revised.xlsx" })).rejects.toThrow("same file extension");
  });

  test("two tasks select and edit separate documents without visible destinations", async () => {
    const { runtime, document } = fixture();
    const one = document("a", "one.docx"), two = document("a", "two.docx");
    await runtime.select({ sessionId: "left", path: "one.docx" });
    await runtime.select({ sessionId: "right", path: "two.docx" });
    expect(await runtime.execute("document.agent_tool", { sessionId: "left" })).toEqual({ ok: true, path: "one.docx" });
    expect(await runtime.execute("document.agent_tool", { sessionId: "right" })).toEqual({ ok: true, path: "two.docx" });
    expect(one.destinations.size + two.destinations.size).toBe(0);
    expect((await runtime.list({ sessionId: "left" })).activeSurface.path).toBe("one.docx");
    expect((await runtime.list({ sessionId: "right" })).activeSurface.path).toBe("two.docx");
  });

  test("same filenames in other projects cannot redirect a task", async () => {
    const { runtime, document } = fixture();
    document("a", "contract.docx", async () => "a");
    document("b", "contract.docx", async () => "b");
    await runtime.select({ sessionId: "left", path: "contract.docx" });
    await runtime.select({ sessionId: "elsewhere", path: "contract.docx" });
    expect(await runtime.execute("document.agent_tool", { sessionId: "left" })).toBe("a");
    expect(await runtime.execute("document.agent_tool", { sessionId: "elsewhere" })).toBe("b");
    document("b", "private.docx");
    await expect(runtime.execute("document.agent_tool", { sessionId: "left", path: "private.docx" })).rejects.toThrow("No document");
    await expect(runtime.execute("document.agent_tool", { sessionId: "unknown" })).rejects.toThrow("Unknown task");
    expect((await runtime.list({ sessionId: "left" })).openFiles.map(file => file.path)).toEqual(["contract.docx"]);
  });

  test("user tab selection and detachment cannot redirect the task after its first read", async () => {
    const { runtime, document } = fixture();
    const one = document("a", "one.docx"), two = document("a", "two.docx");
    one.destinations.set({}, true);
    expect(await runtime.execute("document.agent_tool", { sessionId: "left" })).toEqual({ ok: true, path: "one.docx" });
    one.destinations.clear(); two.destinations.set({}, true);
    expect(await runtime.execute("document.agent_tool", { sessionId: "left" })).toEqual({ ok: true, path: "one.docx" });
    expect(runtime.ensure(one.props)).toBe(one);
  });

  test("parallel calls on one draft wait for its save, without blocking other files", async () => {
    const { runtime, document } = fixture();
    const events = [];
    let finish;
    const saving = new Promise(resolve => { finish = resolve; });
    document("a", "one.docx", async args => { events.push(args.toolName); if (args.toolName === "edit") await saving; return args.toolName; });
    document("a", "two.docx", async () => { events.push("other"); return "other"; });
    await runtime.select({ sessionId: "left", path: "one.docx" });
    await runtime.select({ sessionId: "right", path: "two.docx" });
    const edit = runtime.execute("document.agent_tool", { sessionId: "left", toolName: "edit" });
    const read = runtime.execute("document.agent_tool", { sessionId: "left", toolName: "read" });
    expect(await runtime.execute("document.agent_tool", { sessionId: "right" })).toBe("other");
    expect(events).toEqual(["edit", "other"]);
    // Capture before queuing, even if another operation changes task selection.
    await runtime.select({ sessionId: "left", path: "two.docx" });
    finish(); await Promise.all([edit, read]);
    expect(events).toEqual(["edit", "other", "read"]);
  });

  test("a rejected edit does not poison the document queue", async () => {
    const { runtime, document } = fixture();
    document("a", "one.docx", async args => { if (args.toolName === "bad") throw new Error("bad range"); return "readable"; });
    await runtime.select({ sessionId: "left", path: "one.docx" });
    await expect(runtime.execute("document.agent_tool", { sessionId: "left", toolName: "bad" })).rejects.toThrow("bad range");
    expect(await runtime.execute("document.agent_tool", { sessionId: "left", toolName: "read" })).toBe("readable");
    await expect(runtime.execute("office.agent_tool", { sessionId: "left", format: "xlsx" })).rejects.toThrow("different format");
  });
});

test("selecting a PDF returns without waiting for an editor it never gets", async () => {
  const { runtime, clients } = fixture();
  runtime.ensure({ client: clients.a, workspaceId: "a", workspaceRoot: "/a", sessionId: "workspace:a",
    tab: { id: "file:ruling.pdf", type: "artifact", value: "ruling.pdf", label: "ruling.pdf", preview: "pdf" }, onClose() {} });
  expect(await runtime.select({ sessionId: "left", path: "ruling.pdf" })).toMatchObject({ ok: true });
});

test("show opens a task document beside its chat; without it the user's view is unchanged", async () => {
  const { runtime, document, clients } = fixture();
  clients.a.statWorkspaceFile = async (_workspace, path) => ({ path, exists: true, kind: "file", size: 1, updatedAt: 1 });
  document("a", "one.docx"); document("a", "two.docx");
  usePanelTabStore.getState().adoptChat("workspace:a", "left", "Task");
  const visible = () => usePanelTabStore.getState().sessions["workspace:a"].panes.flatMap(pane => pane.tabIds);
  try {
    expect((await runtime.open({ sessionId: "left", path: "one.docx" })).message).toContain("has not changed");
    expect(visible()).toEqual(["chat:left"]);
    expect((await runtime.open({ sessionId: "left", path: "two.docx", show: true })).message).toContain("beside the chat");
    expect(visible()).toEqual(["chat:left", "file:two.docx"]);
  } finally {
    const { "workspace:a": removed, ...sessions } = usePanelTabStore.getState().sessions;
    usePanelTabStore.setState({ sessions });
  }
});

test("closed clean editors are released after the task finishes; unsaved drafts survive", async () => {
  const { runtime, document } = fixture();
  const clean = document("a", "clean.docx"), dirty = document("a", "dirty.docx");
  dirty.registration.dirty = () => true;
  await runtime.select({ sessionId: "left", path: "clean.docx" });
  await runtime.select({ sessionId: "right", path: "dirty.docx" });
  runtime.prune();
  expect(runtime.entries.has(clean.key)).toBe(true);
  runtime.releaseTask("left"); runtime.releaseTask("right");
  expect(runtime.entries.has(clean.key)).toBe(false);
  expect(runtime.entries.has(dirty.key)).toBe(true);
});

test("uncached tasks resolve their project without mounting a route", async () => {
  let lookups = 0;
  const project = { projectId: "p", workspaceId: "p", workspaceRoot: "/p", client: { baseUrl: "http://p" } };
  const runtime = createDocumentRuntime(() => ({ className: "" }), async () => { lookups++; return project; });
  expect(await runtime.getProject("background")).toBe(project);
  expect(await runtime.list({ sessionId: "background" })).toEqual({ openFiles: [], surfaces: [], activeSurface: null, protectedSurfaces: [] });
  expect(lookups).toBe(1);
});

test("each chat retains all its working documents until completion and dismissing a mini tab never cancels an edit", async () => {
  const { runtime, document } = fixture();
  const one = document("a", "one.docx"), two = document("a", "two.docx");
  await runtime.select({ sessionId: "left", path: "one.docx" });
  await runtime.select({ sessionId: "left", path: "two.docx" });
  await runtime.select({ sessionId: "right", path: "one.docx" });
  runtime.prune();
  expect(runtime.entries.size).toBe(2);
  expect([...one.tasks]).toEqual(["left", "right"]);
  expect([...two.tasks]).toEqual(["left"]);
  runtime.dismiss(one, "left");
  expect(one.dismissed.has("left")).toBe(true);
  expect(one.dismissed.has("right")).toBe(false);
  expect(await runtime.execute("document.agent_tool", { sessionId: "left", path: "one.docx" })).toEqual({ ok: true, path: "one.docx" });
  expect(one.dismissed.has("left")).toBe(false);
  runtime.releaseTask("left");
  expect(runtime.entries.has(two.key)).toBe(false);
  expect([...one.tasks]).toEqual(["right"]);
  expect(await runtime.execute("document.agent_tool", { sessionId: "right" })).toEqual({ ok: true, path: "one.docx" });
  runtime.releaseTask("right");
  expect(runtime.entries.size).toBe(0);
});

test("promotion and closing the full document view retain the agent's exact editor", async () => {
  const { runtime, document } = fixture();
  const entry = document("a", "one.docx");
  await runtime.select({ sessionId: "left", path: "one.docx" });
  const destination = {};
  entry.destinations.set(destination, true);
  runtime.prune();
  expect(runtime.entries.get(entry.key)).toBe(entry);
  entry.destinations.delete(destination);
  runtime.prune();
  expect(runtime.entries.get(entry.key)).toBe(entry);
  expect(await runtime.execute("document.agent_tool", { sessionId: "left" })).toEqual({ ok: true, path: "one.docx" });
  entry.destinations.set(destination, true);
  runtime.releaseTask("left");
  expect(runtime.entries.get(entry.key)).toBe(entry);
  expect(entry.tasks.size).toBe(0);
});

test("chat inventory excludes another chat's parked drafts but file writes still protect them", async () => {
  const { runtime, document } = fixture();
  document("a", "one.docx"); document("a", "two.docx"); document("b", "private.docx");
  await runtime.select({ sessionId: "left", path: "one.docx" });
  await runtime.select({ sessionId: "right", path: "two.docx" });
  const list = await runtime.list({ sessionId: "left" });
  expect(list.openFiles.map(file => file.path)).toEqual(["one.docx"]);
  expect(list.surfaces.map(surface => surface.path)).toEqual(["one.docx"]);
  expect(list.protectedSurfaces.map(surface => surface.path)).toEqual(["one.docx", "two.docx"]);
});

test("file handoff saves, releases the editor and reopens fresh bytes in the same destination", async () => {
  const { runtime, document, clients } = fixture();
  const entry = document("a", "one.docx", async () => ({ ok: true, saved: true }));
  const host = entry.host, destination = {};
  entry.destinations.set(destination, true);
  await runtime.select({ sessionId: "left", path: "one.docx" });
  const oldGeneration = entry.generation;
  const registration = entry.registration;
  expect(await runtime.execute("document.agent_tool", { sessionId: "left", toolName: "prepare_file_edit" })).toEqual({ ok: true, saved: true });
  expect(entry.fileEditing).toBe(true);
  expect(entry.registration).toBeNull();
  expect((await runtime.list({ sessionId: "left" })).protectedSurfaces).toEqual([]);
  await expect(runtime.execute("document.agent_tool", { sessionId: "left" })).rejects.toThrow("Reopen it");
  clients.a.statWorkspaceFile = async () => ({ exists: true, kind: "file", updatedAt: 2 });
  const stop = runtime.subscribe(() => {
    if (!entry.fileEditing && entry.generation !== oldGeneration) entry.registration = { ...registration, action: { id: "document.agent_tool", execute: async () => "new saved content" } };
  });
  try {
    await runtime.open({ sessionId: "left", path: "one.docx" });
    expect(await runtime.execute("document.agent_tool", { sessionId: "left" })).toBe("new saved content");
    expect(entry.host).toBe(host);
    expect(entry.destinations.get(destination)).toBe(true);
  } finally { stop(); }
});

test("failed saves and concurrent tasks cannot release a live draft", async () => {
  const { runtime, document } = fixture();
  let calls = 0;
  const entry = document("a", "one.docx", async () => { calls++; return { ok: false, saved: false }; });
  const registration = entry.registration;
  registration.dirty = () => true;
  await runtime.select({ sessionId: "left", path: "one.docx" });
  expect(await runtime.execute("document.agent_tool", { sessionId: "left", toolName: "prepare_file_edit" })).toEqual({ ok: false, saved: false });
  expect(entry.registration).toBe(registration);
  expect(entry.fileEditing).toBe(false);
  await runtime.select({ sessionId: "right", path: "one.docx" });
  await expect(runtime.execute("document.agent_tool", { sessionId: "left", toolName: "prepare_file_edit" })).rejects.toThrow("Another task");
  expect(calls).toBe(1);
  expect(entry.registration).toBe(registration);
});

test("a draft changed during saving cannot report a successful file handoff", async () => {
  const { runtime, document } = fixture();
  const entry = document("a", "one.docx", async () => ({ ok: true, saved: true }));
  entry.registration.dirty = () => true;
  await runtime.select({ sessionId: "left", path: "one.docx" });
  const result = await runtime.execute("document.agent_tool", { sessionId: "left", toolName: "prepare_file_edit" });
  expect(result).toMatchObject({ ok: false, saved: false });
  expect(entry.fileEditing).toBe(false);
  expect(entry.registration).not.toBeNull();
});

test("reopening a changed file refreshes a clean editor but preserves an unsaved draft", async () => {
  const { runtime, document, clients } = fixture();
  const entry = document("a", "one.docx");
  const registration = entry.registration, oldGeneration = entry.generation;
  registration.updatedAt = () => 1;
  registration.dirty = () => true;
  clients.a.statWorkspaceFile = async () => ({ exists: true, kind: "file", updatedAt: 2 });
  await runtime.open({ sessionId: "left", path: "one.docx" });
  expect(entry.generation).toBe(oldGeneration);
  expect(entry.registration).toBe(registration);
  registration.dirty = () => false;
  const stop = runtime.subscribe(() => {
    if (entry.generation !== oldGeneration) entry.registration = { ...registration, updatedAt: () => 2 };
  });
  try {
    await runtime.open({ sessionId: "left", path: "one.docx" });
    expect(entry.generation).not.toBe(oldGeneration);
    expect(entry.registration.updatedAt()).toBe(2);
  } finally { stop(); }
});

test("automatic file edits preserve selection, queue other tasks, and reload without promotion", async () => {
  const { runtime, document, clients } = fixture();
  const entry = document("a", "one.docx", async args => args.toolName === "prepare_file_edit" ? { ok: true, saved: true } : "old");
  const unrelated = document("a", "other.docx"), privateFile = document("b", "private.docx");
  await runtime.select({ sessionId: "left", path: "one.docx" });
  await runtime.select({ sessionId: "right", path: "one.docx" });
  const original = entry.registration, originalGeneration = entry.generation;
  const stop = runtime.subscribe(() => {
    if (!entry.fileEditing && entry.generation !== originalGeneration) entry.registration = { ...original, action: { id: "document.agent_tool", execute: async () => "fresh" } };
  });
  try {
    await runtime.beginFileEdit({ sessionId: "left", operationId: "edit", paths: ["one.docx"] });
    expect(entry.fileEditing).toBe(true);
    expect(unrelated.fileEditing).toBe(false); expect(privateFile.fileEditing).toBe(false);
    let readFinished = false;
    const read = runtime.execute("document.agent_tool", { sessionId: "right", toolName: "read_document" }).then(result => { readFinished = true; return result; });
    await Promise.resolve(); expect(readFinished).toBe(false);
    expect(entry.destinations.size).toBe(0);
    await runtime.endFileEdit({ sessionId: "left", operationId: "edit" });
    expect(await read).toBe("fresh");
    expect(entry.fileEditing).toBe(false);
    expect(entry.destinations.size).toBe(0);
  } finally { stop(); }
});

test("partial handoff failure restores saved editors and preserves the failing draft", async () => {
  const { runtime, document } = fixture();
  const first = document("a", "first.docx", async () => ({ ok: true, saved: true }));
  const second = document("a", "second.docx", async () => ({ ok: false, saved: false }));
  const original = first.registration, generation = first.generation;
  const stop = runtime.subscribe(() => { if (!first.fileEditing && first.generation !== generation) first.registration = original; });
  try {
    await expect(runtime.beginFileEdit({ sessionId: "left", operationId: "edit" })).rejects.toThrow("Could not save second.docx");
    expect(first.fileEditing).toBe(false); expect(second.fileEditing).toBe(false);
    expect(second.registration).not.toBeNull();
  } finally { stop(); }
});

test("unknown write destinations save all editable formats and defer newly opened editors", async () => {
  const { runtime, document, clients } = fixture();
  const saved = [];
  const entries = ["word", "sheet", "slides", "markdown"].map((preview, i) => {
    const entry = document("a", `file-${i}`, async () => { saved.push(preview); return { ok: true, saved: true }; });
    entry.props.tab.preview = preview;
    return { entry, registration: entry.registration, generation: entry.generation };
  });
  const stop = runtime.subscribe(() => { for (const { entry, registration, generation } of entries) if (!entry.fileEditing && entry.generation !== generation) entry.registration = registration; });
  try {
    await runtime.beginFileEdit({ sessionId: "left", operationId: "script" });
    expect(saved).toEqual(["word", "sheet", "slides", "markdown"]);
    const late = runtime.ensure({ client: clients.a, workspaceId: "a", sessionId: "workspace:a", tab: { id: "file:new.docx", type: "artifact", value: "new.docx", label: "new.docx", preview: "word" } });
    expect(late.fileEditing).toBe(true);
    const other = document("b", "unrelated.docx");
    expect(other.fileEditing).toBe(false);
    await runtime.endFileEdit({ sessionId: "left", operationId: "script" });
    expect(late.fileEditing).toBe(false);
    expect(entries.every(({entry}) => !entry.fileEditing)).toBe(true);
  } finally { stop(); }
});

test("Stop cancels queued tools without applying them after an active save",async()=>{
  const {runtime,document}=fixture();const gate=Promise.withResolvers(),started=Promise.withResolvers();const tools=[];
  document("a","one.docx",async args=>{tools.push(args.toolName);if(args.toolName==="active"){started.resolve();await gate.promise;}return {ok:true};});
  await runtime.select({sessionId:"left",path:"one.docx"});
  const active=runtime.execute("document.agent_tool",{sessionId:"left",toolName:"active"});await started.promise;
  const controller=new AbortController();
  const queued=runtime.execute("document.agent_tool",{sessionId:"left",toolName:"late"},{signal:controller.signal});
  controller.abort();await expect(queued).rejects.toThrow();gate.resolve();await active;
  await runtime.execute("document.agent_tool",{sessionId:"left",toolName:"read"});expect(tools).toEqual(["active","read"]);
});
test("cancelled shell preparation never releases the live draft after its save finishes",async()=>{
  const {runtime,document}=fixture(),gate=Promise.withResolvers(),started=Promise.withResolvers();
  const entry=document("a","one.docx",async()=>{started.resolve();await gate.promise;return {ok:true,saved:true};});
  const registration=entry.registration,controller=new AbortController();
  const preparing=runtime.beginFileEdit({sessionId:"left",operationId:"cancelled"},{signal:controller.signal});
  await started.promise;controller.abort();gate.resolve();await expect(preparing).rejects.toThrow();
  expect(entry.fileEditing).toBe(false);expect(entry.registration).toBe(registration);
  expect(await runtime.endFileEdit({sessionId:"left",operationId:"cancelled"})).toEqual({ok:true});
});
test("a shell handoff with no open editor needs no document import",async()=>{
  const {runtime}=fixture();
  expect(await runtime.beginFileEdit({sessionId:"left",operationId:"headless"})).toEqual({ok:true,operationId:"headless"});
  expect(await runtime.endFileEdit({sessionId:"left",operationId:"headless"})).toEqual({ok:true,reloaded:true});
});
