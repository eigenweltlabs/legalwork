import { relative, resolve, isAbsolute } from "node:path";
import { beginFileEditorHandoff } from "../file-editor-handoff.js";
import { cancelUiBridgeRequests } from "../inapp-document-bridge.js";

/** Native file tools have no execution wrapper, so pair the before/after hooks
 * and the engine's error event. Shell processes are coordinated at execution. */
export function nativeFileEdits(directory?: string, begin = beginFileEditorHandoff, cancel = cancelUiBridgeRequests) {
  type Operation = { sessionID: string; controller: AbortController; ready: Promise<void>; finish?: () => Promise<void>; pending?: Promise<void> };
  const active = new Map<string, Operation>();
  const key = (sessionID: string, callID: string) => `${sessionID}:${callID}`;
  const finish = async (sessionID: string, callID: string) => {
    const id = key(sessionID, callID), operation = active.get(id);
    if (!operation) return;
    operation.controller.abort();
    operation.pending ??= operation.ready.catch(() => {}).then(() => operation.finish?.()).finally(() => active.delete(id));
    await operation.pending;
  };
  return {
    async before(input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }) {
      if (!["write", "edit", "patch", "multiedit", "apply_patch"].includes(input.tool)) return;
      if (!process.env.LEGALWORK_UI_CONTROL_DISCOVERY) return;
      const raw = output.args.filePath ?? output.args.path;
      let paths: string[] | undefined;
      if (typeof raw === "string" && directory) {
        const path = relative(directory, resolve(directory, raw)).replace(/\\/g, "/");
        if (path === ".." || path.startsWith("../") || isAbsolute(path)) return;
        paths = [path];
      }
      await finish(input.sessionID, input.callID);
      const id = key(input.sessionID, input.callID);
      const operation: Operation = { sessionID: input.sessionID, controller: new AbortController(), ready: Promise.resolve() };
      active.set(id, operation);
      operation.ready = (async () => {
        operation.finish = await begin(input.sessionID, paths, undefined, operation.controller.signal);
        operation.controller.signal.throwIfAborted();
      })();
      try { await operation.ready; }
      catch (error) { await finish(input.sessionID, input.callID); throw error; }
    },
    after: finish,
    async finishSession(sessionID: string) {
      for (const operation of active.values()) if (operation.sessionID === sessionID) operation.controller.abort();
      if (process.env.LEGALWORK_UI_CONTROL_DISCOVERY) await cancel(sessionID);
      await Promise.all([...active].filter(([, operation]) => operation.sessionID === sessionID).map(([id]) => finish(sessionID, id.slice(sessionID.length + 1))));
    },
    async dispose() {
      await Promise.all([...active].map(([id, operation]) => finish(operation.sessionID, id.slice(operation.sessionID.length + 1))));
    },
  };
}
