/** Present manual HTTP approvals only in the host's native main window. */
export function createHostApprovalHandler({ getWindow, showMessageBox }) {
  let queue = Promise.resolve();
  return (request, signal) => {
    const present = async () => {
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
