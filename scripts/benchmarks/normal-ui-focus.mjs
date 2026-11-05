// Controller-only use of the normal packaged application's public UI bridge.
// No renderer injection, app module, permission grant, or model request.
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.origin !== value || url.username || url.password) throw new Error("Exact loopback UI/server origins required");
  return value;
}
function guestPath(value) {
  return typeof value === "string" && value.startsWith("/home/legalwork/") && !value.split("/").some(part => part === ".." || part === ".") && !value.includes("//");
}
export function normalUiFocusBinding(connection) {
  const binding = connection.focus;
  if (binding?.kind !== "normal-ui-control" || !binding.instanceID || !guestPath(binding.profile)
    || !guestPath(binding.workspace) || binding.workspace !== connection.workspace?.path
    || !connection.workspace?.id || !/^[a-f0-9]{64}$/.test(binding.discoverySha256 ?? "")
    || origin(binding.uiBaseURL) !== connection.ui?.baseUrl || origin(binding.serverBaseURL) !== connection.base
    || binding.uiBaseURL === binding.serverBaseURL || origin(binding.guestUiBaseURL) === origin(binding.guestServerBaseURL))
    throw new Error("Normal UI focus discovery/profile/workspace binding differs");
  return binding;
}

export async function focusNormalUiSession({ connection, sessionID, request, uiReadyTimeoutMs = 30000, now = () => performance.now(), pause = delay }) {
  const binding = normalUiFocusBinding(connection);
  if (typeof sessionID !== "string" || !sessionID) throw new Error("Exact owned session identity required");
  if (!Number.isFinite(uiReadyTimeoutMs) || uiReadyTimeoutMs <= 0) throw new Error("Explicit positive UI readiness watchdog required");
  const path = `/api/session/${encodeURIComponent(sessionID)}`;
  const verifySession = session => {
    if (session?.id !== sessionID || session.location?.directory !== binding.workspace || session.parentID != null)
      throw new Error("Normal focus native identity/location is not the owned root task");
    return session;
  };
  const nativeBefore = verifySession((await request("engine", path))?.data);
  async function ready(predicate, label) {
    const started = now();
    while (true) {
      const snapshot = await request("ui", "/snapshot");
      if (snapshot?.ok !== true || typeof snapshot.route !== "string" || !Array.isArray(snapshot.actions))
        throw new Error("Malformed normal UI snapshot; no focus or Send was inferred");
      if (predicate(snapshot)) return snapshot;
      if (now() - started >= uiReadyTimeoutMs) throw new Error(`Normal UI readiness watchdog: ${label}; no inference was attempted`);
      await pause(100);
    }
  }
  // The normal foreground action explicitly selects the owned chat while its
  // persistent document editor remains mounted; never navigate via Home or
  // manipulate renderer internals to recover a composer.
  const opened = await request("ui", "/execute", { actionId: "session.open", args: { sessionId: sessionID } });
  if (opened?.ok !== true || opened.actionId !== "session.open" || opened.result?.navigatedTo !== sessionID || opened.result.background === true)
    throw new Error("Normal session.open did not navigate to the exact owned task");
  const expected = `/workspace/${encodeURIComponent(connection.workspace.id)}/session/${encodeURIComponent(sessionID)}`;
  const ui = await ready(snapshot => snapshot.route === expected
    && snapshot.actions.some(action => action.id === "composer.set_text" && !action.disabled)
    && snapshot.actions.some(action => action.id === "composer.send"), "Owned route/composer did not mount");
  const nativeAfter = verifySession((await request("engine", path))?.data);
  if (!isDeepStrictEqual(nativeBefore.model, nativeAfter.model)) throw new Error("Native selected model/settings changed during UI focus; fresh admission is required");
  return { focused: true, mechanism: "normal-public-owned-session-open", inferenceCalls: 0,
    binding, sessionID, nativeBefore, nativeAfter, ui,
    modelSelection: "Unchanged native settings retained. Fresh complete catalog/effective-variant and provider-wire admission remain independently mandatory." };
}

export function assertEmptyCreatedTaskHistory(messages, sessionID) {
  if (!sessionID || !Array.isArray(messages) || messages.length !== 0)
    throw new Error("New owned task history must be completely empty; no previous answer may enter admission");
  return { sessionID, messages: 0, empty: true };
}
