import { createHash } from "node:crypto";
import { isSessionNotFoundError, type OpenCodeClient, type SessionInfo } from "@opencode/client";
import { engineStorageDir } from "./engine-storage.js";
import { ApiError, findApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { readCurrentHistory, updateCurrentHistoryReceipt, type CurrentHistoryState, type HistorySourcePolicy } from "./current-history-state.js";
export { importLegacySessionPermissionRules } from "./current-history-state.js";
import { permissionPatternMatches } from "./agent-sandbox/permissions.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type SourcePolicy = HistorySourcePolicy;
const pending = new Map<string, Promise<SessionInfo>>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function hold(reason: string): never {
  throw new ApiError(409, "history_permissions_resolution_required", "This older chat's saved permissions could not be restored safely. Its original backup is preserved; resolve this before running the chat.", { reason });
}

function sourcePolicy(state: CurrentHistoryState, sessionID: string): SourcePolicy | undefined {
  const policy = state.sessions[sessionID]?.policy;
  if (policy?.status === "unresolved") return hold(policy.reason);
  return policy?.status === "available" ? policy.source : undefined;
}
function contextHash(source: SourcePolicy) { return digest([source.directory, source.createdAt, source.parentID, source.worktree]); }
function receipt(state: CurrentHistoryState, sessionID: string, source: SourcePolicy) {
  const value = state.permissionReceipts[sessionID];
  if (value && (value.sourceSha256 !== state.sourceSha256 || value.sessionID !== sessionID || value.sourceRuleHash !== digest(source.rules) || value.contextHash !== contextHash(source))) return hold("receipt_source_mismatch");
  return value;
}

/** Keep policies on their original chat. A receipt prevents a later explicit
 * native edit from being overwritten when the app or engine restarts. */
export async function restoreLegacySessionPermissions(config: ServerConfig, workspace: WorkspaceInfo, client: OpenCodeClient, session: SessionInfo): Promise<SessionInfo> {
  let backup: CurrentHistoryState | null;
  try { backup = await readCurrentHistory(config); } catch { return hold("current_history_state_unavailable"); }
  if (!backup) return session;
  const key = `${engineStorageDir(config)}:${backup.sourceSha256}:${session.id}`, existing = pending.get(key);
  if (existing) return existing;
  const restore = (async () => {
    const source = sourcePolicy(backup, session.id);
    if (!source) return session;
    const actual = await canonicalFilePath(session.location.directory), expected = await canonicalFilePath(workspace.directory?.trim() || workspace.path);
    if (expected !== actual) return hold("native_context_mismatch");
    if (receipt(backup, session.id, source)) return session;
    if (source.directory !== actual || session.time.created !== source.createdAt || (session.parentID ?? null) !== source.parentID) return hold("original_context_mismatch");
    // V1 addressed file rules relative to its Git worktree ("/" for non-Git
    // projects); V2 addresses them relative to the location. Wildcard-only
    // resources are invariant. Glob/grep resources are search patterns in both
    // versions; only path-sensitive rules need the worktree-context check.
    if (source.worktree !== actual && source.rules.some(rule => rule.resource !== "*" && ["read", "edit", "list"].some(name => permissionPatternMatches(name, rule.action)))) return hold("original_permission_resource_context_mismatch");
    const current = await client.session.get({ sessionID: session.id });
    if (await canonicalFilePath(current.location.directory) !== actual || current.time.created !== source.createdAt || (current.parentID ?? null) !== source.parentID || current.agent !== session.agent) return hold("native_context_changed");
    if (current.permissions?.length && digest(current.permissions) !== digest(source.rules)) return hold("native_permissions_conflict");
    if (digest(current.permissions ?? []) !== digest(source.rules)) await client.session.update({ sessionID: session.id, permissions: source.rules });
    const restored = await client.session.get({ sessionID: session.id });
    if (digest(restored.permissions ?? []) !== digest(source.rules)) return hold("native_permissions_not_preserved");
    await updateCurrentHistoryReceipt(config, "permission", session.id, { version: 1, sourceSha256: backup.sourceSha256, sessionID: session.id, sourceRuleHash: digest(source.rules), contextHash: contextHash(source), restoredAt: Date.now() });
    return restored;
  })().catch(error => { if (error instanceof ApiError) throw error; return hold("restoration_unavailable"); }).finally(() => { pending.delete(key); });
  pending.set(key, restore);
  return restore;
}

/** New/native chats and already-restored chats need no extra engine request. */
export async function ensureLegacySessionPermissions(config: ServerConfig, workspace: WorkspaceInfo, client: OpenCodeClient, sessionID: string): Promise<void> {
  let backup: CurrentHistoryState | null;
  try { backup = await readCurrentHistory(config); } catch { return hold("current_history_state_unavailable"); }
  if (!backup) return;
  const source = sourcePolicy(backup, sessionID);
  if (!source || receipt(backup, sessionID, source)) return;
  await restoreLegacySessionPermissions(config, workspace, client, await client.session.get({ sessionID }));
}

/** A service may resume work before the app can call an API. Hold recovered
 * legacy chats until their exact policy was restored through the native API. */
export async function assertLegacySessionPermissionsRecoveryReady(config: ServerConfig, sessionIDs: readonly string[]) {
  if (!sessionIDs.length) return;
  let backup: CurrentHistoryState | null;
  try { backup = await readCurrentHistory(config); } catch { return hold("current_history_state_unavailable"); }
  if (!backup) return;
  for (const sessionID of new Set(sessionIDs)) {
    const source = sourcePolicy(backup, sessionID);
    if (source && !receipt(backup, sessionID, source)) return hold("original_permissions_not_restored");
  }
}

async function registeredCandidates(config: ServerConfig) {
  let backup: CurrentHistoryState | null;
  try { backup = await readCurrentHistory(config); } catch { return hold("current_history_state_unavailable"); }
  if (!backup) return [];
  const workspaces = await Promise.all(config.workspaces.map(async workspace => ({ workspace, directory: await canonicalFilePath(workspace.directory?.trim() || workspace.path) })));
  const rows = Object.entries(backup.sessions).filter(([, record]) => record.policy.status !== "none").map(([id, record]) => ({ id, directory: record.directory }));
  const result: Array<{ workspace: WorkspaceInfo; sessionID: string }> = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.directory !== "string") return hold("original_context_unavailable");
    const directory = await canonicalFilePath(row.directory), selected = workspaces.find(entry => entry.directory === directory);
    if (selected && sourcePolicy(backup, row.id)) result.push({ workspace: selected.workspace, sessionID: row.id });
  }
  return result;
}

/** Force the existing plain-serve recovery phase before registered legacy
 * policies are restored. This check is read-only and activates no location. */
export async function assertRegisteredLegacySessionPermissionsReady(config: ServerConfig, client?: OpenCodeClient) {
  const candidates = await registeredCandidates(config), present: string[] = [];
  for (const candidate of candidates) {
    if (client) {
      try { await client.session.get({ sessionID: candidate.sessionID }); }
      catch (error) { if (isSessionNotFoundError(error) || findApiError(error)?.status === 404) continue; throw error; }
    }
    present.push(candidate.sessionID);
  }
  await assertLegacySessionPermissionsRecoveryReady(config, present);
}

/** Only passive native session get/update operations are used here. Unknown
 * projects remain untouched and retain the before-admission migration gate. */
export async function restoreRegisteredLegacySessionPermissions(config: ServerConfig, client: OpenCodeClient) {
  for (const candidate of await registeredCandidates(config)) {
    let session: SessionInfo;
    try { session = await client.session.get({ sessionID: candidate.sessionID }); }
    catch (error) { if (isSessionNotFoundError(error) || findApiError(error)?.status === 404) continue; throw error; }
    await restoreLegacySessionPermissions(config, candidate.workspace, client, session);
  }
}
