/**
 * Present manual HTTP approvals as system UI: a card in the quick panel while
 * it is open, otherwise a native dialog in the main window. A panel that
 * closes without answering hands the request to the dialog; nothing approves silently.
 */
export function createHostApprovalHandler({ getWindow, showMessageBox, presentInPanel = undefined }) {
  let queue = Promise.resolve();
  return (request, signal) => {
    const present = async () => {
      if (signal.aborted) return "deny";
      if (presentInPanel) {
        const decision = await presentInPanel(request, signal).catch(() => null);
        if (decision === "allow" || decision === "deny") return decision;
      }
      const window = getWindow?.();
      if (signal.aborted || !window || window.isDestroyed()) return "deny";

      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      window.once("closed", abort);
      try {
        const source = request.actor.type === "host"
          ? "Host"
          : `Connected client (app, agent or remote connection)${request.actor.clientId ? `: ${request.actor.clientId}` : ""}`;
        const result = await showMessageBox(window, {
          type: "question",
          title: "LegalWork approval",
          message: "Allow this workspace change?",
          detail: [
            `Source: ${source}`,
            ...(request.actor.scope ? [`Access: ${request.actor.scope}`] : []),
            `Workspace: ${request.workspaceId}`,
            `Action: ${request.action}`,
            request.summary,
            ...(request.paths.length ? ["Paths:", ...request.paths] : []),
          ].join("\n"),
          buttons: ["Deny", "Allow"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal: controller.signal,
        });
        return !controller.signal.aborted && !window.isDestroyed() && result.response === 1 ? "allow" : "deny";
      } catch {
        return "deny";
      } finally {
        signal.removeEventListener("abort", abort);
        window.removeListener("closed", abort);
      }
    };
    const result = queue.then(present);
    queue = result.then(() => {}, () => {});
    return result;
  };
}
