import { createHash } from "node:crypto";
import { createEngineClient, getWorkspaceEngineSession } from "./engine-client.js";
import { ApiError, findApiError } from "./errors.js";
import { canonicalFilePath, withFileWriteLock } from "./file-write-lock.js";
import { join } from "node:path";
import { engineStorageDir } from "./engine-storage.js";
import { requireOrgPolicyToolsUnmanaged } from "./org-policy.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import type { NativePermissionRule } from "./agent-sandbox/permissions.js";
import { chatApprovalLineage } from "./chat-approval-scope.js";
import type { OpenCodeClient, PermissionRequest } from "@opencode/client";

export type NativeProjectApproval = {
  id: string;
  action: string;
  resources: string[];
  createdAt: number;
  updatedAt?: number;
};

function publicID(approval: NativeProjectApproval, resource: string) {
  return approval.resources.length === 1 ? approval.id
    : `psv_${createHash("sha256").update(JSON.stringify([approval.id, resource])).digest("hex")}`;
}

/** Saved native engine approvals are keyed by Git project. LegalWork owns the
 * product's remembered grants by its own project ID, including non-Git cases. */
export async function listNativeProjectApprovals(config: ServerConfig, workspace: WorkspaceInfo) {
  const saved = await readRuntimeOpencodeConfig(config, workspace.id);
  return (saved.projectPermissionApprovals ?? []).flatMap(approval => approval.resources.map(resource => ({
    id: publicID(approval, resource), projectID: workspace.id, action: approval.action, resource,
    time: { created: approval.createdAt, updated: approval.updatedAt ?? approval.createdAt },
  })));
}

export async function removeNativeProjectApproval(config: ServerConfig, workspace: WorkspaceInfo, id: string): Promise<void> {
  await writeRuntimeOpencodeConfig(config, workspace.id, current => {
    const records = current.projectPermissionApprovals ?? [];
    const selected = records.find(record => record.resources.some(resource => publicID(record, resource) === id));
    if (!selected) throw new ApiError(404, "permission_not_found", "Saved permission not found in this project.");
    return { ...current, projectPermissionApprovals: records.flatMap(record => {
      if (record !== selected) return [record];
      const resources = record.resources.filter(resource => publicID(record, resource) !== id);
      return resources.length ? [{ ...record, resources }] : [];
    }) };
  });
  await writeLegalworkRuntimeConfigFile(config, workspace.id);
}

export async function updateNativeProjectApproval(config: ServerConfig, workspace: WorkspaceInfo, id: string, updates: { action?: string; resource?: string }) {
  if (updates.action !== undefined && (typeof updates.action !== "string" || !updates.action)
    || updates.resource !== undefined && (typeof updates.resource !== "string" || !updates.resource)) {
    throw new ApiError(400, "invalid_permission", "A saved permission action and resource must be nonempty strings.");
  }
  const previous = (await listNativeProjectApprovals(config, workspace)).find(record => record.id === id);
  if (!previous) throw new ApiError(404, "permission_not_found", "Saved permission not found in this project.");
  await requireOrgPolicyToolsUnmanaged(config, [previous.action, updates.action ?? previous.action]);
  await writeRuntimeOpencodeConfig(config, workspace.id, current => {
    const records = current.projectPermissionApprovals ?? [];
    const selected = records.find(record => record.resources.some(resource => publicID(record, resource) === id));
    if (!selected) throw new ApiError(404, "permission_not_found", "Saved permission not found in this project.");
    const resource = selected.resources.find(resource => publicID(selected, resource) === id);
    if (resource === undefined) throw new ApiError(404, "permission_not_found", "Saved permission not found in this project.");
    const others = selected.resources.filter(resource => publicID(selected, resource) !== id);
    const replacement = { id, action: updates.action ?? selected.action, resources: [updates.resource ?? resource],
      createdAt: selected.createdAt, updatedAt: Date.now() };
    return { ...current, projectPermissionApprovals: records.flatMap(record => record === selected
      ? [...(others.length ? [{ ...record, resources: others }] : []), replacement] : [record]) };
  });
  await writeLegalworkRuntimeConfigFile(config, workspace.id);
  const result = (await listNativeProjectApprovals(config, workspace)).find(record => record.id === id);
  if (!result) throw new ApiError(503, "permission_approval_not_published", "The updated permission was not published.");
  return result;
}

/** Verify the product's project-scoped evaluation hook before accepting a saved
 * grant. An ordinary OpenCode-only server cannot promise this ownership scope. */
async function assertProjectApprovalIntegration(config: ServerConfig, workspace: WorkspaceInfo, sessionID: string) {
  const client = createEngineClient(config, workspace);
  const session = await getWorkspaceEngineSession(client, workspace, sessionID);
  const result = await client.rpc.call({ rpcID: "legalwork.managed-settings", method: "permissionScope", input: {}, location: session.location })
    .catch(() => { throw new ApiError(409, "project_permission_integration_unavailable", "This engine does not support remembered LegalWork project permissions. Use Allow once."); });
  const value = result.output;
  if (!value || typeof value !== "object" || !('version' in value) || value.version !== 2 || !('remembered' in value) || value.remembered !== "legalwork-project"
    || !('directory' in value) || typeof value.directory !== "string"
    || await canonicalFilePath(value.directory) !== await canonicalFilePath(workspace.directory?.trim() || workspace.path)) {
    throw new ApiError(409, "project_permission_integration_unavailable", "This engine cannot verify remembered permissions for this LegalWork project. Use Allow once.");
  }
  return { client, session };
}

/** Never turn a temporary prompt into a wider guessed wildcard. Native v2's
 * own "always" implementation stores request.save, not request.resources. */
export function nativeChatApprovalResources(request: { action: string; save?: readonly string[] }) {
  if (!request.action || !request.save?.length || request.save.some(resource => !resource)) {
    throw new ApiError(400, "permission_approval_not_persistable", "This request has no persistent approval scope. Use Allow once.");
  }
  return [...new Set(request.save)];
}

function approvalIdentity(request: PermissionRequest) {
  return JSON.stringify([request.action, [...request.resources].sort(), [...request.save ?? []].sort(), request.metadata]);
}

/** Re-evaluate queued duplicates under live engine/agent policy before settling
 * them. A remembered grant never turns a new denial into Allow once. */
async function settleNativeChatApprovals(client: OpenCodeClient, workspace: WorkspaceInfo, chatID: string, approved: PermissionRequest) {
  const pending = await client.permission.request.list({ location: { directory: workspace.directory?.trim() || workspace.path } });
  for (const request of pending.data) {
    if (request.id === approved.id || approvalIdentity(request) !== approvalIdentity(approved)) continue;
    try {
      const lineage = await chatApprovalLineage(request.sessionID, id => getWorkspaceEngineSession(client, workspace, id));
      if (lineage[lineage.length - 1].id !== chatID) continue;
      const session = lineage[0];
      const source = request.source?.type === "tool"
        ? await client.session.message.get({ sessionID: session.id, messageID: request.source.messageID }) : undefined;
      const agent = source?.type === "assistant" ? source.agent : session.agent;
      // A source-free permission probe cannot act as the original tool call.
      const check = await client.permission.create({ sessionID: session.id, action: request.action, resources: request.resources,
        save: request.save, metadata: request.metadata, ...(agent ? { agent } : {}) });
      if (check.effect === "allow") await client.permission.reply({ sessionID: session.id, requestID: request.id, decision: "once" });
      else if (check.effect === "ask") await client.permission.reply({ sessionID: session.id, requestID: check.id, decision: "reject",
        message: "This access still needs a separate approval." });
    } catch (error) {
      // Another decision or chat deletion can race the pending snapshot.
      if ([403, 404].includes(findApiError(error)?.status ?? 0)) continue;
      throw error;
    }
  }
}

/** Persist on the verified parent chat, shared with its subtasks. Replying `once` afterward
 * settles the pending request without creating an engine project-wide grant. */
export async function rememberNativeChatApproval(config: ServerConfig, workspace: WorkspaceInfo, sessionID: string, requestID: string): Promise<void> {
  const { client } = await assertProjectApprovalIntegration(config, workspace, sessionID);
  const lineage = await chatApprovalLineage(sessionID, id => getWorkspaceEngineSession(client, workspace, id));
  const chatID = lineage[lineage.length - 1].id;
  const lock = join(engineStorageDir(config), `chat-approval-${createHash("sha256").update(chatID).digest("hex")}.lock`);
  await withFileWriteLock(lock, async () => {
    const request = await client.permission.get({ sessionID, requestID });
    const resources = nativeChatApprovalResources(request);
    await requireOrgPolicyToolsUnmanaged(config, [request.action]);
    const currentLineage = await chatApprovalLineage(sessionID, id => getWorkspaceEngineSession(client, workspace, id));
    if (currentLineage[currentLineage.length - 1].id !== chatID)
      throw new ApiError(409, "permission_approval_changed", "This chat's ancestry changed. Review the request again.");
    const session = currentLineage[currentLineage.length - 1];
    const current = await client.permission.get({ sessionID, requestID });
    if (current.action !== request.action || JSON.stringify(current.save) !== JSON.stringify(request.save))
      throw new ApiError(409, "permission_approval_changed", "This permission request changed. Review it again before remembering access.");
    const additions = resources.filter(resource => !session.permissions?.some(rule => rule.action === request.action && rule.resource === resource && rule.effect === "allow"))
      .map((resource): NativePermissionRule => ({ action: request.action, resource, effect: "allow" }));
    // Existing restrictions remain after the grant, so a saved denial is
    // never overwritten by remembering a wider request.
    await client.session.update({ sessionID: chatID, permissions: [...additions, ...session.permissions ?? []] });
    const saved = await client.session.get({ sessionID: chatID });
    if (!resources.every(resource => saved.permissions?.some(rule => rule.action === request.action && rule.resource === resource && rule.effect === "allow")))
      throw new ApiError(503, "chat_permission_not_saved", "This chat's permission could not be saved. Use Allow once or retry.");
    await settleNativeChatApprovals(client, workspace, chatID, request);
  });
}
