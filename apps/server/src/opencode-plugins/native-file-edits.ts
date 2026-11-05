import { relative, resolve, isAbsolute } from "node:path";
import { beginFileEditorHandoff } from "../file-editor-handoff.js";

/** Native file tools have no execution wrapper, so pair the before/after hooks
 * and the engine's error event. Shell processes are coordinated at execution. */
export function nativeFileEdits(directory?: string, begin = beginFileEditorHandoff) {
  const active = new Map<string, { sessionID: string; finish: () => Promise<void>; pending?: Promise<void> }>();
  const key = (sessionID: string, callID: string) => `${sessionID}:${callID}`;
  const finish = async (sessionID: string, callID: string) => {
    const id = key(sessionID, callID), operation = active.get(id);
    if (!operation) return;
    operation.pending ??= operation.finish().finally(() => active.delete(id));
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
      const handoff = begin(input.sessionID, paths);
      const id = key(input.sessionID, input.callID);
      active.set(id, { sessionID: input.sessionID, finish: async () => { await (await handoff)(); } });
      try { await handoff; }
      catch (error) { active.delete(id); throw error; }
    },
    after: finish,
    async finishSession(sessionID: string) {
      await Promise.all([...active].filter(([, operation]) => operation.sessionID === sessionID).map(([id]) => finish(sessionID, id.slice(sessionID.length + 1))));
    },
    async dispose() {
      await Promise.all([...active].map(([id, operation]) => finish(operation.sessionID, id.slice(operation.sessionID.length + 1))));
    },
  };
}
