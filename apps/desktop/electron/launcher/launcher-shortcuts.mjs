/**
 * One binding registry for every launcher shortcut. Conflicts are reported,
 * never resolved silently: a duplicate inside the registry, a collision with
 * the dictation chord, or a registration the OS refused.
 */
export class LauncherShortcutRegistry {
  /** @param {{ globalShortcut: { register: (accelerator: string, callback: () => void) => boolean, unregister: (accelerator: string) => void, isRegistered?: (accelerator: string) => boolean }, reserved?: () => string[], platform?: string }} options */
  constructor(options) {
    this.globalShortcut = options.globalShortcut;
    this.reserved = options.reserved ?? (() => []);
    this.platform = options.platform ?? process.platform;
    /** @type {Map<string, { accelerator: string, handler: () => void }>} */
    this.registered = new Map();
    /** @type {{ id: string, accelerator: string, reason: "duplicate" | "dictation" | "registration-failed" }[]} */
    this.conflicts = [];
  }
  /** The same chord spelled differently is the same chord: CommandOrControl resolves per platform. */
  normalize(accelerator) {
    const primary = this.platform === "darwin" ? "Command" : "Control";
    return String(accelerator ?? "").split("+").map(part => part.trim()).filter(Boolean)
      .map(part => part === "Cmd" || part === "Super" && this.platform === "darwin" ? "Command" : part === "Ctrl" ? "Control" : part === "CommandOrControl" || part === "CmdOrCtrl" ? primary : part).join("+");
  }
  /** Replace the whole binding set. Returns the conflicts after applying. */
  apply(bindings) {
    for (const entry of this.registered.values()) { try { this.globalShortcut.unregister(entry.accelerator); } catch { /* already gone */ } }
    this.registered.clear();
    this.conflicts = [];
    const reserved = new Set(this.reserved().map(item => this.normalize(item)));
    const taken = new Map();
    for (const binding of bindings) {
      const accelerator = this.normalize(binding.accelerator);
      if (!accelerator) continue;
      if (reserved.has(accelerator)) { this.conflicts.push({ id: binding.id, accelerator, reason: "dictation" }); continue; }
      if (taken.has(accelerator)) { this.conflicts.push({ id: binding.id, accelerator, reason: "duplicate" }); continue; }
      let ok = false;
      try { ok = this.globalShortcut.register(accelerator, binding.handler); } catch { ok = false; }
      if (!ok) { this.conflicts.push({ id: binding.id, accelerator, reason: "registration-failed" }); continue; }
      taken.set(accelerator, binding.id);
      this.registered.set(binding.id, { accelerator, handler: binding.handler });
    }
    return this.conflicts;
  }
  isRegistered(id) { return this.registered.has(id); }
  /** After wake, re-apply only what the OS reports lost. */
  refresh(bindings) {
    const lost = [...this.registered.values()].some(entry => typeof this.globalShortcut.isRegistered === "function" && !this.globalShortcut.isRegistered(entry.accelerator));
    if (lost || this.registered.size < bindings.length - this.conflicts.length) return this.apply(bindings);
    return this.conflicts;
  }
  dispose() {
    for (const entry of this.registered.values()) { try { this.globalShortcut.unregister(entry.accelerator); } catch { /* already gone */ } }
    this.registered.clear();
  }
}
