import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LauncherService } from "./launcher-service.mjs";
import { LauncherShortcutRegistry } from "./launcher-shortcuts.mjs";
import { parseAssistantLink } from "./launcher-links.mjs";

function fakeWindow() {
  const sent = [];
  let visible = false, focused = false, loading = true, pinned = false, dialogs = 0, ensured = 0;
  const contents = { isLoading: () => loading };
  return { sent, get visibleNow() { return visible; }, get dialogs() { return dialogs; }, get ensured() { return ensured; }, setLoading: value => { loading = value; }, window: {}, rememberPosition: true,
    ensure: async () => { ensured++; return {}; }, beginDialog: () => { dialogs++; }, endDialog: () => { dialogs = Math.max(0, dialogs - 1); },
    isVisible: () => visible, isFocused: () => focused, state: () => ({ visible, pinned, focused, displayId: null }), webContents: () => contents,
    show: async (shouldShow = () => true) => { if (shouldShow()) { visible = true; focused = true; } return { visible, pinned, focused, displayId: null }; }, hide: () => { visible = false; focused = false; return { visible, pinned, focused, displayId: null }; },
    send: event => sent.push(event), setPinned: value => { pinned = value; return { visible, pinned, focused, displayId: null }; }, resize: () => ({ visible, pinned, focused, displayId: null }), expand: () => { visible = false; }, destroy: () => {} };
}
function fakeOrigin() {
  let origin = null, captures = 0, prefetches = 0;
  return { get captures() { return captures; }, get prefetches() { return prefetches; }, capture: async () => { captures++; origin = { id: `origin_${captures}`, app: "Word", window: "Lease.docx", bundleId: "w", pid: 7, capturedAt: 1, supportsSelection: true, supportsInsert: true, platform: "darwin" }; return origin; },
    current: () => origin, invalidate: () => { origin = null; }, prefetchSelection: async () => { prefetches++; return { ok: true, text: "x", origin }; }, capabilities: () => ({ origin: true, selection: true, insert: true, windowCapture: true, regionCapture: true, helper: true }) };
}
const fakeShortcut = () => { const bound = new Map(); return { bound, register: (accelerator, callback) => { bound.set(accelerator, callback); return true; }, unregister: accelerator => bound.delete(accelerator), isRegistered: accelerator => bound.has(accelerator) }; };

async function makeService(dir) {
  const window = fakeWindow();
  const origin = fakeOrigin();
  const globalShortcut = fakeShortcut();
  const companionStates = [];
  const voice = [];
  const service = new LauncherService(/** @type {any} */ ({
    app: { getLoginItemSettings: () => ({ openAtLogin: false, status: "enabled" }), setLoginItemSettings: () => {} }, globalShortcut, userDataDir: dir, platform: "darwin",
    window, origin, capture: { destroy: () => {} }, pairing: { load: async () => ({ enabled: false, path: null }), status: () => ({ enabled: false, path: null }) },
    dictation: () => ({ enabled: true, accelerator: "Control", runtimeState: "idle" }), meeting: () => ({ state: "idle" }), companion: state => companionStates.push(state), onPresenceChanged: () => {},
    dictate: () => voice.push("dictate"), record: () => voice.push("record"), composerRecording: () => false,
    registry: new LauncherShortcutRegistry({ globalShortcut, platform: "darwin", reserved: () => ["Control"] }),
  }));
  await service.initialize();
  return { service, window, origin, globalShortcut, companionStates, voice };
}

test("the shortcut opens the panel after capturing the origin; repeated invocations and duplicate links do nothing twice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-service-"));
  try {
    const { service, window, origin, globalShortcut } = await makeService(dir);
    assert.equal(globalShortcut.bound.has("Command+Shift+Space"), true);
    await service.invoke({ id: "inv_1", action: "ask", query: "Was ist offen?", source: "raycast" });
    assert.equal(origin.captures, 1);
    assert.equal(window.visibleNow, true);
    // The renderer was still loading: the invocation waits in the cold-start queue.
    assert.deepEqual(service.drain().map(item => item.id), ["inv_1"]);
    await service.invoke({ id: "inv_1", action: "ask", source: "raycast" });
    assert.equal(origin.captures, 1);
    assert.deepEqual(service.drain(), []);
    window.setLoading(false);
    // Loaded but not yet drained by this renderer: still queued, never lost between load and listener.
    service.readyContents = null;
    await service.invoke({ id: "inv_early", action: "work", source: "hud" });
    assert.equal(window.sent.some(event => event.type === "invocation" && event.invocation.id === "inv_early"), false);
    assert.deepEqual(service.drain().map(item => item.id), ["inv_early"]);
    const remaining = await service.handleDeepLinks(["legalwork://assistant/files?q=Mietvertrag&invocation=link_2", "legalwork://connect-remote?x=1", "legalwork://assistant/files?q=Mietvertrag&invocation=link_2"]);
    assert.deepEqual(remaining, ["legalwork://connect-remote?x=1"]);
    assert.deepEqual(window.sent.filter(event => event.type === "invocation").map(event => event.invocation.query), ["Mietvertrag"]);
    // Visible and focused: the shortcut toggles the panel away without re-capturing the origin.
    await service.toggle("shortcut");
    assert.equal(window.visibleNow, false);
    assert.equal(origin.captures, 1);
    const status = await service.status();
    assert.equal(status.shortcutRegistered, true);
    assert.equal(status.voice.externalDictation, false);
    assert.equal(status.capabilities.selection, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("direct action shortcuts jump into the panel and the selection shortcut prefetches as part of the invocation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-service-actions-"));
  try {
    const { service, window, origin, globalShortcut, companionStates } = await makeService(dir);
    await service.updateSettings({ actionShortcuts: { "app.search-files": "Alt+F", "app.add-selection": "Alt+S", "app.dictate": "Alt+D", "quick-action:qa_1": "Alt+Q" }, companion: true });
    assert.deepEqual([...globalShortcut.bound.keys()].sort(), ["Alt+F", "Alt+Q", "Alt+S", "Command+Shift+Space"]);
    window.setLoading(false);
    service.drain();
    globalShortcut.bound.get("Alt+S")();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(origin.prefetches, 1);
    assert.equal(window.sent.filter(event => event.type === "invocation").at(-1)?.invocation.action, "ask");
    assert.equal(window.sent.filter(event => event.type === "invocation").at(-1)?.invocation.captureSelection, true);
    globalShortcut.bound.get("Alt+Q")();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(window.sent.filter(event => event.type === "invocation").at(-1)?.invocation.actionId, "quick-action:qa_1");
    assert.equal(window.sent.filter(event => event.type === "invocation").at(-1)?.invocation.captureSelection, undefined);
    service.setAttention({ count: 2, recording: true });
    assert.deepEqual(companionStates.at(-1), { enabled: true, badge: true, attention: 2, recording: true });
    assert.equal(window.sent.at(-1)?.type, "attention");
    const status = await service.status();
    assert.deepEqual(status.conflicts, []);
    assert.equal(service.backgroundPresence(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a second toggle cancels opening during native context capture and a later shortcut can reopen", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-toggle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { service, window, origin } = await makeService(dir);
  const capture = origin.capture;
  let finishCapture = () => {};
  const capturing = new Promise(resolve => { finishCapture = () => resolve(undefined); });
  origin.capture = async () => { await capturing; return capture(); };
  const first = service.toggle("shortcut");
  await Promise.resolve();
  await service.toggle("shortcut");
  finishCapture();
  await first;
  assert.equal(window.visibleNow, false);
  assert.equal(origin.prefetches, 0);
  assert.deepEqual(service.drain(), []);
  await service.toggle("shortcut");
  assert.equal(window.visibleNow, true);
  assert.equal(service.drain().length, 1);
});

test("hiding while the renderer loads prevents a late show and invocation delivery", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-late-show-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { service, window } = await makeService(dir);
  const show = window.show;
  let finishLoading = () => {};
  const loading = new Promise(resolve => { finishLoading = () => resolve(undefined); });
  let showStarted = () => {};
  const showing = new Promise(resolve => { showStarted = () => resolve(undefined); });
  window.show = async shouldShow => { showStarted(); await loading; return show(shouldShow); };
  const first = service.toggle("shortcut");
  await showing;
  await service.windowControl("hide");
  finishLoading();
  await first;
  assert.equal(window.visibleNow, false);
  assert.deepEqual(service.drain(), []);
});

test("a newer action waits for an older native read and receives its own origin", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-context-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { service, window, origin } = await makeService(dir);
  const capture = origin.capture;
  let finishCapture = () => {}, startedCapture = () => {};
  const capturing = new Promise(resolve => { finishCapture = () => resolve(undefined); });
  const started = new Promise(resolve => { startedCapture = () => resolve(undefined); });
  origin.capture = async () => { startedCapture(); await capturing; return capture(); };
  const first = service.invoke({ id: "old", action: "open", source: "shortcut" });
  await started;
  const newer = service.invoke({ id: "new", action: "files", source: "shortcut" });
  finishCapture();
  await Promise.all([first, newer]);
  assert.equal(origin.captures, 2);
  assert.equal(origin.prefetches, 0);
  assert.deepEqual(service.drain().map(invocation => invocation.id), ["new"]);
  assert.equal(window.sent.find(event => event.type === "origin").origin.id, "origin_2");
});

test("assistant links carry identifiers only and reject unknown actions", () => {
  assert.equal(parseAssistantLink("legalwork://assistant/ask?q=hi&invocation=i1&context=ctx_1")?.contextId, "ctx_1");
  assert.equal(parseAssistantLink("legalwork://assistant/erase-everything"), null);
  assert.equal(parseAssistantLink("legalwork://connect-remote?legalworkToken=x"), null);
  assert.equal(parseAssistantLink("legalwork-dev://assistant")?.action, "open");
});

test("in-app invocation uses the same window and freezes the source workspace before focus changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-context-"));
  try {
    const { service, window, origin } = await makeService(dir);
    const context = { workspaceId: "project-a", workspaceName: "Project A", paneId: "right", capturedAt: 1, document: { workspaceId: "project-b", path: "contract.docx", name: "Contract" } };
    service.options.workspaceContext = () => context;
    await service.windowControl("invoke", { context });
    const invocation = service.drain()[0];
    assert.deepEqual(invocation.workspaceContext, context);
    assert.equal(window.visibleNow, true);
    assert.equal(origin.prefetches, 0);
    window.hide();
    service.options.workspaceContext = () => null;
    await service.invoke({ id: "external", action: "open", source: "shortcut" });
    assert.equal(origin.prefetches, 1);
    assert.equal(service.drain()[0]?.workspaceContext, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("approvals reach a visible panel as a card, come back unanswered when it hides, and voice changes are pushed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-service-approvals-"));
  try {
    const { service, window } = await makeService(dir);
    const request = { workspaceId: "matter", action: "skills.delete", summary: "Delete skill demo", paths: ["/matter/.opencode/skills/demo"], actor: { type: "remote", clientId: "client-1", scope: "collaborator" } };
    assert.equal(await service.presentApproval(request, new AbortController().signal), null);
    await service.windowControl("show");
    const answered = service.presentApproval(request, new AbortController().signal);
    const card = window.sent.find(event => event.type === "approval");
    assert.deepEqual(card.request, { id: card.request.id, source: "Connected client: client-1", scope: "collaborator", workspaceId: "matter", action: "skills.delete", summary: "Delete skill demo", paths: ["/matter/.opencode/skills/demo"] });
    assert.equal(service.replyApproval("unknown", "allow"), false);
    assert.equal(service.replyApproval(card.request.id, "allow"), true);
    assert.equal(await answered, "allow");
    assert.equal(window.sent.at(-1)?.type, "approval-closed");
    const handedBack = service.presentApproval(request, new AbortController().signal);
    service.onVisibility(false);
    assert.equal(await handedBack, null);
    const controller = new AbortController();
    const cancelled = service.presentApproval(request, controller.signal);
    controller.abort();
    assert.equal(await cancelled, "deny");
    service.notifyVoice();
    assert.deepEqual(window.sent.at(-1), { type: "voice", voice: { externalDictation: false, meeting: false, composer: false } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("file choosers and dictation hold the panel open, voice destinations never open it, and background presence warms the renderer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-service-dialogs-"));
  try {
    const { service, window, voice } = await makeService(dir);
    await service.windowControl("dialog-begin");
    assert.equal(window.dialogs, 1);
    await service.windowControl("dialog-end");
    assert.equal(window.dialogs, 0);
    await service.invoke({ id: "inv_dictate", action: "dictate", source: "raycast" });
    assert.equal(window.visibleNow, false);
    assert.equal(service.voiceAction("record"), true);
    assert.equal(service.voiceAction("sing"), false);
    assert.deepEqual(voice, ["dictate", "record"]);
    assert.equal(window.ensured, 0);
    await service.updateSettings({ backgroundPresence: true });
    await service.initialize();
    assert.equal(window.ensured, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
