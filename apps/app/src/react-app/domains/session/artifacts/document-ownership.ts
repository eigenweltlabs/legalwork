export type DocumentAccess = "checking" | "reader" | "requesting" | "owner" | "offering" | "releasing" | "unavailable";
export type HandoffChoice = "save" | "discard" | "cancel";
type Message = { type: "request" | "offer" | "decision" | "cancel" | "denied" | "saved" | "released"; sender: string; recipient?: string; choice?: HandoffChoice };


type Options = {
  key: string;
  locks: Pick<LockManager, "request">;
  channel: Pick<BroadcastChannel, "postMessage" | "addEventListener" | "removeEventListener" | "close">;
  changed: (access: DocumentAccess) => void;
  acquire: () => Promise<void>;
  flush: () => Promise<boolean>;
  dirty: () => boolean;
  revision: () => string | number;
  discard: () => Promise<void>;
  decide: () => Promise<HandoffChoice>;
  cancelDecision: () => void;
  drain: () => Promise<void>;
  refresh: () => void;
  failed: (error?: unknown) => void;
};

// A remounted view must wait for its own renderer's previous editor to finish
// closing before checking for a writer in another view. Also covers StrictMode.
const closing = new Map<string, Promise<void>>();

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
  let lockOperation: Promise<unknown> = Promise.resolve();
  let disposal: Promise<void> | null = null;
  let offeredTo: string | null = null;
  let offeredRevision: string | number | null = null;
  let offerTimeout: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const clearOffer = () => { offeredTo = null; if (offerTimeout) clearTimeout(offerTimeout); offerTimeout = null; };
  const set = (next: DocumentAccess) => { access = next; if (!disposed) options.changed(next); };
  const send = (type: Message["type"], recipient?: string, choice?: HandoffChoice) => options.channel.postMessage({ type, sender: id, recipient, choice } satisfies Message);
  const clearTimeoutRequest = () => { if (timeout) clearTimeout(timeout); timeout = null; };

  const take = async (initial: boolean) => {
    if (disposed || request || release) return;
    cancelled = false;
    const controller = new AbortController();
    request = controller;
    if (!initial) set("requesting");
    try {
      const predecessor = closing.get(options.key);
      if (predecessor) await predecessor;
      if (disposed || controller.signal.aborted) return;
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
      lockOperation = held;
      if (!initial) {
        send("request");
        // An unresponsive window must never be forcibly stripped of its draft.
        timeout = setTimeout(() => { controller.abort(); }, 30_000);
      }
      await held;
    } catch (error) {
      if (!disposed) { set(initial ? "unavailable" : "reader"); if (!cancelled) options.failed(error); options.cancelDecision(); }
    } finally {
      if (request === controller) request = null;
      clearTimeoutRequest();
    }
  };

  const handoff = (requester: string, choice: "save" | "discard") => {
    const revision = offeredRevision;
    clearOffer();
    set("releasing");
    transfer = (async () => {
      try {
        await options.drain();
        if (revision !== null && options.revision() !== revision) throw new Error("Document changed while handoff was pending. Please try again.");
        if (choice === "discard") await options.discard();
        else if (!await options.flush()) throw new Error("Document could not be saved before handoff.");
        if (options.dirty()) throw new Error("Document changed during handoff.");
        set("reader");
        release?.();
        send("released");
        options.refresh();
      } catch (error) {
        set("owner");
        send("denied", requester);
        if (!disposed) options.failed(error);
      }
    })();
  };
  const receive = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!message || typeof message !== "object" || !("type" in message) || !("sender" in message) || typeof message.sender !== "string" || message.sender === id) return;
    const addressed = "recipient" in message && message.recipient === id;
    if (message.type === "saved" || message.type === "released") {
      if (access === "reader") options.refresh();
    } else if (message.type === "denied" && addressed) {
      options.cancelDecision();
      request?.abort();
    } else if (message.type === "offer" && addressed && access === "requesting" && request) {
      // The owner is temporarily frozen, including autosave. The choice cannot
      // apply to a different draft typed while the requester is reading it.
      clearTimeoutRequest();
      const owner = message.sender;
      const current = request;
      void options.decide().then(choice => {
        if (disposed || request !== current || current.signal.aborted) return;
        if (choice === "cancel") { cancelled = true; send("cancel", owner); current.abort(); }
        else { send("decision", owner, choice); timeout = setTimeout(() => current.abort(), 30_000); }
      });
    } else if (message.type === "cancel" && offeredTo === message.sender) {
      clearOffer(); set("owner");
    } else if (message.type === "decision" && addressed && offeredTo === message.sender && access === "offering") {
      if ("choice" in message && (message.choice === "save" || message.choice === "discard")) handoff(message.sender, message.choice);
    } else if (message.type === "request" && release) {
      if (access !== "owner") { send("denied", message.sender); return; }
      const requester = message.sender;
      // Freeze before draining an in-flight autosave and inspecting dirty state.
      set("offering");
      offeredTo = requester;
      transfer = (async () => {
        try {
          await options.drain();
          if (disposed || offeredTo !== requester) return;
          offeredRevision = options.revision();
          if (!options.dirty()) { handoff(requester, "save"); return; }
          send("offer", requester);
          offerTimeout = setTimeout(() => { clearOffer(); set("owner"); send("denied", requester); }, 120_000);
        } catch (error) { clearOffer(); set("owner"); send("denied", requester); options.failed(error); }
      })();
    }
  };
  options.channel.addEventListener("message", receive);
  void take(true);
  return {
    request: () => { if (access === "reader" || access === "unavailable") void take(false); },
    canWrite: () => !disposed && (access === "owner" || access === "offering" || access === "releasing"),
    saved: () => { if (!disposed) send("saved"); },
    dispose: () => {
      if (disposal) return disposal;
      disposed = true;
      if (offeredTo) send("denied", offeredTo);
      if (access === "requesting") send("cancel");
      clearOffer();
      options.cancelDecision();
      request?.abort();
      clearTimeoutRequest();
      options.channel.removeEventListener("message", receive);
      // Keep ownership until already-started writes and checkpoints finish.
      const draining = options.drain();
      const releasing = (async () => {
        try { await transfer; await draining; }
        finally {
          release?.();
          // Resolving the callback is not yet the browser's lock release.
          await lockOperation.catch(() => {});
          options.channel.close();
        }
      })();
      const predecessor = closing.get(options.key);
      disposal = Promise.allSettled([predecessor, releasing]).then(() => {
        if (closing.get(options.key) === disposal) closing.delete(options.key);
      });
      closing.set(options.key, disposal);
      return disposal;
    },
  };
}
