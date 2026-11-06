import { mkdir, readFile, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** @typedef {import('@legalwork/types/launcher').LauncherOutputTask} Task */
/** @typedef {import('@legalwork/types/launcher').LauncherOutputIntent} Intent */
/** @typedef {import('@legalwork/types/launcher').AssistantOutput} Output */

/** Desktop-owned journal: renderer lifetime and the selected chat do not control delivery. */
export class LauncherOutputQueue {
  /** @param {{path: string, read: (task: Task) => Promise<Output | null>, copy: (text: string) => void | Promise<void>, insert: (id: string, text: string) => Promise<import('@legalwork/types/launcher').LauncherInsertResult>, intervalMs?: number}} options */
  constructor(options) {
    this.options = options;
    /** @type {Task[]} */ this.tasks = [];
    this.operations = Promise.resolve();
    this.loading = null;
    this.timer = null;
    this.stopped = false;
    this.running = null;
  }
  async initialize() {
    this.loading ??= this.load();
    await this.loading;
    this.schedule();
  }
  async load() {
    let raw;
    try { raw = JSON.parse(await readFile(this.options.path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!Array.isArray(raw) || raw.some(task => !validTask(task))) throw new Error("The saved Assistant outputs could not be read. The original file was kept.");
    this.tasks = raw;
    // A crash between the external paste and its acknowledgement is ambiguous.
    // Never repeat that paste. Preserve the text and recover it to the clipboard.
    for (const task of this.tasks) if (task.state === "delivering") { task.state = "waiting"; task.result = "recovered"; }
    await this.save();
  }
  async save() {
    await mkdir(dirname(this.options.path), { recursive: true });
    const temp = `${this.options.path}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(this.tasks)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.options.path);
  }
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  serial(work) {
    const operation = this.operations.catch(() => {}).then(work);
    this.operations = operation.then(() => undefined);
    // Callers still receive errors; a failed write must never become an unhandled rejection.
    void this.operations.catch(() => {});
    return operation;
  }
  /** @param {Intent} intent */
  async remember(intent) {
    await this.initialize();
    return this.serial(async () => {
      if (!validIntent(intent)) throw new Error("Invalid output request.");
      const existing = this.tasks.find(task => task.requestId === intent.requestId);
      if (existing) {
        if (existing.messageId !== intent.messageId || existing.conversationId !== intent.conversationId || existing.output !== intent.output || existing.originId !== intent.originId) throw new Error("This output belongs to a different request.");
        return;
      }
      if (this.tasks.filter(task => task.state === "waiting").length >= 100) throw new Error("Finish or cancel pending outputs before adding more.");
      const next = { ...intent, state: /** @type {const} */ ("waiting"), createdAt: Date.now(), updatedAt: Date.now() };
      this.tasks.push(next);
      try { await this.save(); } catch (error) { this.tasks = this.tasks.filter(task => task !== next); throw error; }
      this.schedule();
    });
  }
  async list() { await this.initialize(); return structuredClone(this.tasks).reverse(); }
  async cancel(requestId) {
    await this.initialize();
    await this.serial(async () => {
      const task = this.tasks.find(item => item.requestId === requestId);
      if (!task || task.state !== "waiting") return;
      const updatedAt = task.updatedAt;
      task.state = "cancelled"; task.updatedAt = Date.now();
      try { await this.save(); } catch (error) { task.state = "waiting"; task.updatedAt = updatedAt; throw error; }
    });
  }
  schedule() {
    if (this.stopped || this.running || this.timer || !this.tasks.some(task => task.state === "waiting")) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick().catch(error => console.warn("[assistant-output]", error.message)).finally(() => this.schedule()); }, this.options.intervalMs ?? 2500);
    this.timer.unref?.();
  }
  async tick() {
    await this.initialize();
    if (this.running) return this.running;
    this.running = this.run();
    try { await this.running; } finally { this.running = null; }
  }
  async run() {
    for (const original of [...this.tasks]) {
      if (this.stopped || original.state !== "waiting") continue;
      let output = null, readError = null;
      if (!original.text) {
        try { output = await this.options.read(original); }
        catch (error) { readError = error; }
      }
      await this.serial(async () => {
        const task = this.tasks.find(item => item.requestId === original.requestId);
        if (this.stopped || !task || task.state !== "waiting") return;
        try {
          if (readError) throw readError;
          if (!task.text) {
            if (!output) {
              if (Date.now() - task.createdAt > 86_400_000) { task.state = "failed"; task.error = "This request did not arrive. Retry it from its conversation."; await this.save(); }
              return;
            }
            if (output.requestId !== task.requestId || output.messageId !== task.messageId || output.conversationId !== task.conversationId) throw new Error("The reply does not belong to this request.");
            if (output.state === "pending") { if (task.error) { delete task.error; await this.save(); } return; }
            if (output.state === "failed") { task.state = "failed"; task.error = output.error; await this.save(); return; }
            if (output.state !== "ready" || typeof output.text !== "string" || !output.text.trim()) throw new Error("The reply has no text.");
            task.text = output.text;
          }
          task.state = "delivering"; task.updatedAt = Date.now();
          await this.save(); // Durable before any external side effect.
          if (task.output === "insert" && task.originId && task.result !== "recovered") {
            const result = await this.options.insert(task.originId, task.text);
            if (result.ok === true) task.result = result.method === "paste" ? "inserted" : "copied";
            else if (result.copied) task.result = "recovered";
            else throw new Error(result.message);
          } else { await this.options.copy(task.text); task.result = task.result === "recovered" || task.output === "insert" ? "recovered" : "copied"; }
          task.state = "done"; task.updatedAt = Date.now(); delete task.error;
          await this.save();
        } catch (error) {
          task.error = error instanceof Error ? error.message : String(error);
          // Delivery may have happened. Retain the result for manual copy; no automatic retry.
          if (task.state === "delivering" || task.state === "done") task.state = "failed";
          await this.save();
        }
      });
    }
  }
  async dispose() { this.stopped = true; clearTimeout(this.timer); this.timer = null; await this.running?.catch(() => {}); await this.operations.catch(() => {}); }
}
function validIntent(task) {
  return task && [task.requestId, task.messageId, task.conversationId].every(value => typeof value === "string" && value.length > 0 && value.length < 300)
    && ["copy", "insert"].includes(task.output) && (task.originId === null || typeof task.originId === "string");
}
function validTask(task) {
  return validIntent(task) && ["waiting", "delivering", "done", "failed", "cancelled"].includes(task.state)
    && Number.isFinite(task.createdAt) && Number.isFinite(task.updatedAt) && (task.text === undefined || typeof task.text === "string");
}
