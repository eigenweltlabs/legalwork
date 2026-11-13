import { randomUUID } from "node:crypto";
import { getBooleanProperty, getStringProperty, uiBridgeRequest } from "./inapp-document-bridge.js";

type BridgeRequest = typeof uiBridgeRequest;

/** Only a worker explicitly bound to this desktop profile may touch its editors.
 * Reads never contact the UI. Cleanup runs after the actual process stops, even
 * on cancellation or a nonzero exit, before another editor operation proceeds. */
export async function beginFileEditorHandoff(sessionId: string, paths?: string[], request: BridgeRequest = uiBridgeRequest, signal?: AbortSignal) {
  const operationId = randomUUID();
  const call = async (actionId: string) => {
    const result = await request("/execute", { method: "POST", timeoutMs: actionId === "documents.begin_file_edit" ? 30_000 : 5_000,
      ...(actionId === "documents.begin_file_edit" && signal ? { signal } : {}),
      body: { actionId, args: { sessionId, operationId, ...(paths ? { paths } : {}) }, callerSessionId: sessionId } });
    const nested: unknown = result && typeof result === "object" ? Reflect.get(result, "result") : undefined;
    if (getBooleanProperty(result, "ok") !== true || getBooleanProperty(nested, "ok") === false) throw new Error(getStringProperty(nested, "error") ?? getStringProperty(result, "error") ?? "Could not coordinate the open document editors.");
  };
  try { await call("documents.begin_file_edit"); }
  catch (error) {
    // The begin response can be lost after the draft was saved and released.
    await call("documents.end_file_edit").catch(() => {});
    throw error;
  }
  return () => call("documents.end_file_edit");
}

export async function withFileEditorHandoff<T>(command: { write: boolean; sessionID?: string; signal?: AbortSignal }, run: () => Promise<T>, request?: BridgeRequest) {
  if (!command.write || !command.sessionID || (!request && !process.env.LEGALWORK_UI_CONTROL_DISCOVERY)) return run();
  const finish = await beginFileEditorHandoff(command.sessionID, undefined, request, command.signal);
  try { command.signal?.throwIfAborted(); return await run(); }
  finally { await finish(); }
}
