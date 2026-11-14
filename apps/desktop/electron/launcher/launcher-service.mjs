import { LauncherSettingsStore } from "./launcher-settings.mjs";
import { LauncherShortcutRegistry } from "./launcher-shortcuts.mjs";
import { parseAssistantLink } from "./launcher-links.mjs";

/** App actions a direct shortcut can jump into, and the invocation each one opens with. */
const ACTION_INVOCATIONS = {
  "app.search-files": "files", "app.search-projects": "projects", "app.search-chats": "chats", "app.search-tasks": "tasks", "app.search-recordings": "recordings",
  "app.ask": "ask", "app.speak": "speak", "app.capture-region": "capture-region", "app.capture-window": "capture-window", "app.add-selection": "ask", "app.show-work": "work", "app.new-conversation": "new-conversation",
};
const INVOCATION_MEMORY = 200;

/**
 * Orchestrates the launcher on the desktop: settings, one shortcut registry,
 * the panel window, the origin captured before it, deep links, the companion
 * badge and the Raycast pairing. Everything reaches the same invocation path.
 */
export class LauncherService {
  /**
   * @param {{ app: import("electron").App, globalShortcut: import("electron").GlobalShortcut, userDataDir: string, platform?: string,
   *   workspaceContext?: () => import("@legalwork/types/launcher").LauncherWorkspaceContext | null, window: import("./launcher-window.mjs").LauncherWindow, origin: import("./origin-service.mjs").OriginService, capture: import("./screen-capture.mjs").ScreenCapture,
   *   pairing: import("./raycast-pairing.mjs").RaycastPairing, dictation: () => { enabled: boolean, accelerator: string, runtimeState: string }, meeting: () => { state: string },
   *   companion: (state: { enabled: boolean, badge: boolean, attention: number, recording: boolean }) => void, onPresenceChanged: () => void, dictate: () => void, record: () => void, composerRecording: () => boolean, settings?: LauncherSettingsStore, registry?: LauncherShortcutRegistry }} options
   */
  constructor(options) {
    this.options = options;
    /** @type {"darwin" | "windows" | "linux"} */
    this.platform = options.platform === "darwin" || options.platform === "windows" || options.platform === "linux" ? options.platform : process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    this.settings = options.settings ?? new LauncherSettingsStore(options.userDataDir);
    this.registry = options.registry ?? new LauncherShortcutRegistry({ globalShortcut: options.globalShortcut, platform: process.platform, reserved: () => { const dictation = options.dictation(); return dictation.enabled && dictation.accelerator ? [dictation.accelerator] : []; } });
    /** @type {import("@legalwork/types/launcher").LauncherInvocation[]} */
    this.pending = [];
    /** @type {string[]} */
    this.seen = [];
    this.attention = 0;
    this.recording = false;
    this.drafts = { drafts: {}, leases: {} };
    /** @type {Map<string, (decision: "allow" | "deny" | null) => void>} */
    this.approvals = new Map();
    /** The renderer that drained the cold-start queue: only it receives pushed invocations. */
    this.readyContents = null;
    /** @type {object | null} Opening can be cancelled before native context and the renderer finish loading. */
    this.opening = null;
    this.preparing = Promise.resolve();
  }
  async initialize() {
    await this.settings.load();
    await this.options.pairing.load();
    this.applyShortcuts();
    this.syncCompanion();
    this.options.window.rememberPosition = this.settings.get().rememberPosition;
    this.options.window.setPinned(false);
    // Background presence keeps the renderer warm, so the first shortcut after boot does not cold-load it.
    if (this.settings.get().backgroundPresence) void this.options.window.ensure().catch(error => console.warn("[launcher] Could not prepare the launcher", error));
  }
  bindings() {
    const settings = this.settings.get();
    const bindings = [{ id: "launcher.open", accelerator: settings.shortcut, handler: () => { void this.toggle("shortcut").catch(error => console.warn("[launcher] Could not open the launcher", error)); } }];
    for (const [id, accelerator] of Object.entries(settings.actionShortcuts)) {
      const action = ACTION_INVOCATIONS[id] ?? (id.startsWith("quick-action:") ? "quick-action" : null);
      if (!action) continue;
      bindings.push({ id, accelerator, handler: () => { void this.invoke({ id: `shortcut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, action: /** @type {import("@legalwork/types/launcher").LauncherInvocationAction} */ (action), actionId: id.startsWith("quick-action:") ? id : undefined, source: "shortcut", captureSelection: id === "app.add-selection" ? true : undefined }).catch(error => console.warn("[launcher] Could not open the launcher action", error)); } });
    }
    return bindings;
  }
  applyShortcuts() { return this.registry.apply(this.bindings()); }
  refreshAfterResume() { this.options.origin.invalidate(); return this.registry.refresh(this.bindings()); }
  /** @returns {Promise<import("@legalwork/types/launcher").LauncherDesktopStatus>} */
  async status() {
    const settings = this.settings.get();
    let autostartRequiresApproval = false, autostart = settings.autostart;
    try { const login = this.options.app.getLoginItemSettings(); autostart = login.openAtLogin === true; autostartRequiresApproval = login.status === "requires-approval"; } catch { /* unsupported */ }
    const capabilities = this.options.origin.capabilities();
    return { ...settings, autostart, shortcutRegistered: this.registry.isRegistered("launcher.open"), conflicts: this.registry.conflicts, autostartRequiresApproval, raycastPairing: this.options.pairing.status(), platform: this.platform,
      capabilities: { selection: capabilities.selection, insert: capabilities.insert, windowCapture: capabilities.windowCapture, regionCapture: capabilities.regionCapture, origin: capabilities.origin }, voice: this.voiceState() };
  }
  async updateSettings(patch) {
    const before = this.settings.get();
    const next = await this.settings.update(patch);
    if (patch && typeof patch.autostart === "boolean") {
      try { this.options.app.setLoginItemSettings({ openAtLogin: patch.autostart, ...(process.platform === "win32" ? { args: patch.autostart ? ["--hidden"] : [] } : {}) }); } catch { /* reported through status */ }
    }
    if (next.shortcut !== before.shortcut || JSON.stringify(next.actionShortcuts) !== JSON.stringify(before.actionShortcuts)) this.applyShortcuts();
    this.options.window.rememberPosition = next.rememberPosition;
    if (next.pinned !== before.pinned) this.options.window.setPinned(next.pinned);
    this.syncCompanion();
    this.options.onPresenceChanged();
    return this.status();
  }
  syncCompanion() {
    const settings = this.settings.get();
    this.options.companion({ enabled: settings.companion, badge: settings.companionBadge, attention: this.attention, recording: this.recording });
  }
  setAttention(input) {
    this.attention = Math.max(0, Number(input?.count) || 0);
    this.recording = Boolean(input?.recording);
    this.syncCompanion();
    this.options.window.send({ type: "attention", count: this.attention });
  }
  backgroundPresence() { return this.settings.get().backgroundPresence; }
  approvalWindow() { return this.options.window.isVisible() ? this.options.window.window : null; }
  voiceState() {
    const dictation = this.options.dictation(), meeting = this.options.meeting();
    return { externalDictation: ["starting", "listening", "transcribing", "inserting"].includes(dictation.runtimeState), meeting: meeting.state !== "idle", composer: this.options.composerRecording() };
  }
  /** Capture ownership changes reach the panel at once; the polled status is only the fallback. */
  notifyVoice() { this.options.window.send({ type: "voice", voice: this.voiceState() }); }
  /**
   * A host approval for the visible panel. Resolves with the user's answer, or
   * null when the panel is hidden or closes first, so the caller re-presents it.
   * @param {{ workspaceId: string, action: string, summary: string, paths: string[], actor: { type: string, clientId?: string | null, scope?: string | null } }} request
   * @param {AbortSignal} signal
   * @returns {Promise<"allow" | "deny" | null>}
   */
  presentApproval(request, signal) {
    if (!this.options.window.isVisible() || signal.aborted) return Promise.resolve(null);
    const id = `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const source = request.actor.type === "host" ? "Host" : `Connected client${request.actor.clientId ? `: ${request.actor.clientId}` : ""}`;
    return new Promise(resolve => {
      const finish = (/** @type {"allow" | "deny" | null} */ decision) => {
        if (!this.approvals.delete(id)) return;
        signal.removeEventListener("abort", onAbort);
        this.options.window.send({ type: "approval-closed", id });
        resolve(decision);
      };
      const onAbort = () => finish("deny");
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(id, finish);
      this.options.window.send({ type: "approval", request: { id, source, scope: request.actor.scope ?? null, workspaceId: request.workspaceId, action: request.action, summary: request.summary, paths: request.paths } });
    });
  }
  /** @param {string} id @param {string} decision */
  replyApproval(id, decision) {
    const finish = this.approvals.get(id);
    if (!finish) return false;
    finish(decision === "allow" ? "allow" : "deny");
    return true;
  }
  /** Hiding the panel hands every pending approval back unanswered; dismissal is never acceptance. */
  onVisibility(visible) { if (!visible) for (const finish of [...this.approvals.values()]) finish(null); }
  remember(id) {
    if (this.seen.includes(id)) return false;
    this.seen.push(id);
    if (this.seen.length > INVOCATION_MEMORY) this.seen.shift();
    return true;
  }
  /**
   * Every entry point ends here. Repeated delivery of the same invocation does nothing twice.
   * @param {import("@legalwork/types/launcher").LauncherInvocation & { selection?: boolean }} invocation
   */
  async invoke(invocation) {
    if (!invocation?.id || !this.remember(invocation.id)) return this.options.window.state();
    // The two other voice destinations never open the panel: dictation goes to the front app, recording to the recorder.
    if (invocation.action === "dictate" || invocation.action === "record") { this.voiceAction(invocation.action); return this.options.window.state(); }
    const { selection, ...payload } = invocation;
    if (selection) payload.captureSelection = true;
    payload.workspaceContext ??= this.options.workspaceContext?.() ?? undefined;
    const opening = this.opening = {};
    // Serialize native context reads so an older capture cannot overwrite a newer invocation's origin.
    this.preparing = this.preparing.catch(() => {}).then(async () => {
      if (this.opening !== opening) return;
      if (!this.options.window.isFocused()) await this.options.origin.capture();
      if (this.opening !== opening) return;
      if (payload.captureSelection || !payload.workspaceContext && invocation.action === "open") await this.options.origin.prefetchSelection();
    });
    try {
      await this.preparing;
      if (this.opening !== opening) return this.options.window.state();
      await this.options.window.show(() => this.opening === opening);
      if (this.opening !== opening) return this.options.window.state();
      this.options.window.send({ type: "origin", origin: this.options.origin.current() });
      this.deliver(payload);
      return this.options.window.state();
    } finally { if (this.opening === opening) this.opening = null; }
  }
  deliver(invocation) {
    const contents = this.options.window.webContents();
    if (!contents || contents.isLoading() || this.readyContents !== contents) { this.pending.push(invocation); return; }
    this.options.window.send({ type: "invocation", invocation });
  }
  /** The cold-start queue: the panel drains what arrived before its listener existed, and is pushed to from then on. */
  drain() { this.readyContents = this.options.window.webContents(); return this.pending.splice(0, this.pending.length); }
  /** @param {string} action */
  voiceAction(action) {
    if (action === "dictate") { this.hide(); this.options.dictate(); return true; }
    if (action === "record") { this.options.record(); return true; }
    return false;
  }
  /** @param {import("@legalwork/types/launcher").LauncherInvocation["source"]} source */
  async toggle(source) {
    if (this.options.window.isVisible() || this.opening) return this.hide();
    return this.invoke({ id: `toggle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, action: "open", source });
  }
  hide() { this.opening = null; return this.options.window.hide(); }
  /**
   * Assistant links go to the panel, not indiscriminately to the main window. Returns the links that are not ours.
   * @param {string[]} urls
   */
  async handleDeepLinks(urls) {
    const remaining = [];
    for (const url of urls) {
      const invocation = parseAssistantLink(url);
      if (invocation) await this.invoke(invocation); else remaining.push(url);
    }
    return remaining;
  }
  async windowControl(command, payload) {
    const window = this.options.window;
    switch (command) {
      case "show": return window.isVisible() ? window.show() : this.invoke({ id: crypto.randomUUID(), action: "open", source: "home" });
      case "invoke": return this.invoke(payload?.invocation ?? { id: `home_${Date.now()}`, action: "open", source: "home", workspaceContext: payload?.context ?? undefined });
      case "reset-position": return window.resetPosition();
      case "hide": return this.hide();
      case "pin": // Older renderers may still send this; the launcher always dismisses on blur.
      case "unpin": await this.settings.update({ pinned: false }); return window.setPinned(false);
      case "resize": return window.resize(payload?.height);
      case "dialog-begin": window.beginDialog(); return window.state();
      case "dialog-end": window.endDialog(); return window.state();
      case "expand": window.expand(typeof payload?.route === "string" && payload.route.startsWith("/") ? payload.route : "/home"); return window.state();
      default: return window.state();
    }
  }
  dispose() { this.opening = null; this.registry.dispose(); this.options.window.destroy(); this.options.capture.destroy(); }
}
