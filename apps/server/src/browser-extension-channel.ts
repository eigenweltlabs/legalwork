import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";

export type BrowserExtensionRoute = "batch" | "downloads" | "upload" | "capture" | "download";
type Command = { requestID: string; route: BrowserExtensionRoute; body?: unknown } | { cancel: string };
type Result = { status: number; payload: unknown };
type Pending = { command: Command; delivered: boolean; resolve: (result: Result) => void; reject: (error: unknown) => void };
export interface BrowserExtensionBinding { actor: string; workspaceID: string; sessionID: string; tabID: string }
/** Ephemeral reverse requests only. Delivered mutations are never replayed after transport loss. */
export function createBrowserExtensionChannel() {
  const entries = new Map<string, { binding: BrowserExtensionBinding; queue: Command[]; pending: Map<string, Pending>; waiter?: { resolve: (command: Command) => void; reject: (error: unknown) => void } }>();
  const gone = () => new ApiError(409, "browser_desktop_disconnected", "The desktop browser disconnected. Inspect its page before retrying; delivered actions may already have completed.");
  function get(capability: string) { const entry = entries.get(capability); if (!entry) throw gone(); return entry; }
  function push(entry: ReturnType<typeof get>, command: Command) {
    if (entry.waiter) { const waiter = entry.waiter; entry.waiter = undefined; if ("requestID" in command) { const pending = entry.pending.get(command.requestID); if (pending) pending.delivered = true; } waiter.resolve(command); }
    else entry.queue.push(command);
  }
  function close(capability: string) {
    const entry = entries.get(capability); if (!entry) return;
    entries.delete(capability); entry.waiter?.reject(gone());
    for (const pending of entry.pending.values()) pending.reject(gone());
    entry.pending.clear(); entry.queue = [];
  }
  return {
    register(binding: BrowserExtensionBinding) { const capability = randomBytes(32).toString("hex"); entries.set(capability, { binding, queue: [], pending: new Map() }); return capability; },
    binding(capability: string) { return get(capability).binding; }, close,
    async next(capability: string, signal: AbortSignal): Promise<Command> {
      signal.throwIfAborted(); const entry = get(capability);
      if (entry.waiter) throw new ApiError(409, "browser_poll_duplicate", "The browser already has an active receiver.");
      const queued = entry.queue.shift();
      if (queued) { if ("requestID" in queued) { const pending = entry.pending.get(queued.requestID); if (pending) pending.delivered = true; } return queued; }
      const abort = () => close(capability);
      signal.addEventListener("abort", abort, { once: true });
      try { return await new Promise<Command>((resolve, reject) => { entry.waiter = { resolve, reject }; }); }
      finally { signal.removeEventListener("abort", abort); }
    },
    async request(capability: string, route: BrowserExtensionRoute, body: unknown, signal: AbortSignal): Promise<Result> {
      signal.throwIfAborted(); const entry = get(capability), requestID = randomUUID();
      let pending: Pending | undefined;
      const abort = () => {
        if (!pending || !entry.pending.delete(requestID)) return;
        entry.queue = entry.queue.filter(command => !("requestID" in command) || command.requestID !== requestID);
        if (pending.delivered) push(entry, { cancel: requestID });
        pending.reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      try { return await new Promise<Result>((resolve, reject) => { pending = { command: { requestID, route, body }, delivered: false, resolve, reject }; entry.pending.set(requestID, pending); push(entry, pending.command); }); }
      finally { signal.removeEventListener("abort", abort); }
    },
    result(capability: string, requestID: string, result: Result) {
      const entry = get(capability), pending = entry.pending.get(requestID);
      if (!pending || !pending.delivered) throw new ApiError(409, "browser_result_expired", "This browser result is no longer pending.");
      entry.pending.delete(requestID); pending.resolve(result);
    },
  };
}
