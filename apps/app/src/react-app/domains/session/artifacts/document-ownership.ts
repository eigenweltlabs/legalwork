export type DocumentAccess = "checking" | "reader" | "requesting" | "owner" | "releasing" | "unavailable";
type Message = { type: "request" | "denied" | "saved" | "released"; sender: string; recipient?: string };

type Options = {
  key: string;
  locks: Pick<LockManager, "request">;
  channel: Pick<BroadcastChannel, "postMessage" | "addEventListener" | "removeEventListener" | "close">;
  changed: (access: DocumentAccess) => void;
  acquire: () => Promise<void>;
  flush: () => Promise<boolean>;
  drain: () => Promise<void>;
  refresh: () => void;
  failed: (error?: unknown) => void;
};

/** One writer per original file in the app's browser profile. Web Locks release
 * on renderer termination; broadcasts are notifications, never the lock itself. */
export function createDocumentOwnership(options: Options) {
  const id = crypto.randomUUID();
  let access: DocumentAccess = "checking";
  let disposed = false;
  let release: (() => void) | null = null;
  let request: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let transfer: Promise<void> | null = null;
  const set = (next: DocumentAccess) => { access = next; if (!disposed) options.changed(next); };
  const send = (type: Message["type"], recipient?: string) => options.channel.postMessage({ type, sender: id, recipient } satisfies Message);
  const clearTimeoutRequest = () => { if (timeout) clearTimeout(timeout); timeout = null; };

  const take = async (initial: boolean) => {
    if (disposed || request || release) return;
    const controller = new AbortController();
    request = controller;
    if (!initial) set("requesting");
    try {
      const held = options.locks.request(`legalwork:document:${options.key}`, initial ? { ifAvailable: true } : { signal: controller.signal }, async (lock) => {
        clearTimeoutRequest();
        request = null;
        if (!lock || disposed) { if (!disposed) set("reader"); return; }
        const untilReleased = new Promise<void>((done) => { release = done; });
        try {
          await options.acquire();
          if (disposed) return;
          set("owner");
          await untilReleased;
        } finally { release = null; }
      });
      if (!initial) {
        send("request");
        // An unresponsive window must never be forcibly stripped of its draft.
        timeout = setTimeout(() => { controller.abort(); }, 30_000);
      }
      await held;
    } catch (error) {
      if (!disposed) { set(initial ? "unavailable" : "reader"); options.failed(error); }
    } finally {
      if (request === controller) request = null;
      clearTimeoutRequest();
    }
  };

  const receive = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!message || typeof message !== "object" || !("type" in message) || !("sender" in message) || typeof message.sender !== "string" || message.sender === id) return;
    if (message.type === "saved" || message.type === "released") {
      if (access === "reader") options.refresh();
    } else if (message.type === "denied" && "recipient" in message && message.recipient === id) {
      request?.abort();
    } else if (message.type === "request" && release) {
      if (access !== "owner") { send("denied", message.sender); return; }
      const requester = message.sender;
      set("releasing");
      transfer = (async () => {
        try {
          if (!await options.flush()) throw new Error("Document could not be saved before handoff.");
          set("reader");
          release?.();
          send("released");
        } catch (error) {
          set("owner");
          send("denied", requester);
          if (!disposed) options.failed(error);
        }
      })();
    }
  };
  options.channel.addEventListener("message", receive);
  void take(true);
  return {
    request: () => { if (access === "reader" || access === "unavailable") void take(false); },
    canWrite: () => !disposed && (access === "owner" || access === "releasing"),
    saved: () => { if (!disposed) send("saved"); },
    dispose: async () => {
      disposed = true;
      request?.abort();
      clearTimeoutRequest();
      options.channel.removeEventListener("message", receive);
      // Keep ownership until already-started writes and checkpoints finish.
      const draining = options.drain();
      try { await transfer; await draining; }
      finally { release?.(); options.channel.close(); }
    },
  };
}
