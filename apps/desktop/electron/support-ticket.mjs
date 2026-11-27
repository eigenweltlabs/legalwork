import { randomUUID } from "node:crypto";

/** @typedef {import("@legalwork/types/desktop-ipc").SupportTicketConfirmation} SupportTicketConfirmation */
/** @typedef {import("@legalwork/types/desktop-ipc").SupportTicketDecision} SupportTicketDecision */
/** @typedef {Pick<import("electron").WebContents, "send" | "isDestroyed"> & Pick<import("node:events").EventEmitter, "on" | "once" | "removeListener">} ConfirmationRenderer */

const confirmationEvent = "legalwork:support-ticket:confirmation";

export function createSupportTicketConfirmations() {
  /** @type {Map<ConfirmationRenderer, { view: SupportTicketConfirmation, finish: (decision: SupportTicketDecision) => void }>} */
  const pending = new Map();

  /**
   * @param {ConfirmationRenderer | undefined} contents
   * @param {Omit<SupportTicketConfirmation, "id">} report
   * @param {AbortSignal} signal
   * @returns {Promise<SupportTicketDecision>}
   */
  function request(contents, report, signal) {
    if (!contents || contents.isDestroyed() || signal.aborted || pending.has(contents)) return Promise.resolve({ choice: "cancel" });
    const view = { ...report, id: randomUUID() };
    return new Promise(resolve => {
      /** @param {SupportTicketDecision} decision */
      const finish = (decision) => {
        if (pending.get(contents)?.view !== view) return;
        pending.delete(contents);
        signal.removeEventListener("abort", cancel);
        contents.removeListener("destroyed", cancel);
        contents.removeListener("render-process-gone", cancel);
        contents.removeListener("did-start-navigation", navigating);
        resolve(decision);
        if (!contents.isDestroyed()) {
          try { contents.send(confirmationEvent, null); } catch { /* The renderer is closing. */ }
        }
      };
      const cancel = () => finish({ choice: "cancel" });
      /** @param {import("electron").Event} _event @param {string} _url @param {boolean} isInPlace @param {boolean} isMainFrame */
      const navigating = (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) cancel();
      };
      pending.set(contents, { view, finish });
      signal.addEventListener("abort", cancel, { once: true });
      contents.once("destroyed", cancel);
      contents.once("render-process-gone", cancel);
      contents.on("did-start-navigation", navigating);
      try { contents.send(confirmationEvent, view); } catch { cancel(); }
    });
  }

  return {
    request,
    /** @param {ConfirmationRenderer} contents */
    read: (contents) => pending.get(contents)?.view ?? null,
    /** @param {ConfirmationRenderer} contents @param {string} id @param {unknown} choice @param {unknown} [logDays] */
    reply(contents, id, choice, logDays) {
      const entry = pending.get(contents);
      if (!entry || entry.view.id !== id) return false;
      if (choice === "with_logs") {
        if (typeof logDays !== "number" || !Number.isInteger(logDays) || logDays < 1 || logDays > 365) return false;
        entry.finish({ choice, logDays });
      } else {
        if (choice !== "cancel" && choice !== "without_logs") return false;
        entry.finish({ choice });
      }
      return true;
    },
  };
}
