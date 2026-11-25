import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ApprovalService } from "../approvals.js";
import { permissionAction, type NativePermissionRule } from "../agent-sandbox/permissions.js";
import { chatApprovalLineage } from "../chat-approval-scope.js";
import { createEngineClient, getWorkspaceEngineSession } from "../engine-client.js";
import { ApiError } from "../errors.js";
import { orgPolicyPermissions } from "../org-policy-engine.js";
import { projectPermissionEffect } from "../project-permission-approvals.js";
import { applyGlobalToolPermissions, readGlobalToolPermissions, readRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { RequestContext } from "../routes/registry.js";
import type { Actor, ServerConfig, WorkspaceInfo } from "../types.js";
import { authenticateWikiAgentRequest } from "../wiki/agent-access.js";
import type { CorpusFolderApproval } from "./service.js";

type Chat = { id: string; permissions?: readonly NativePermissionRule[] };
export type CorpusFolderPolicy = {
  permission: readonly NativePermissionRule[];
  projectPermissionApprovals: readonly { action: string; resources: readonly string[] }[];
};

/** Like native file tools: the chat, its parents or the project must allow the
 * folder. Any denial wins and is never turned into a prompt. */
export function corpusFolderEffect(policy: CorpusFolderPolicy, lineage: readonly Chat[], resources: readonly string[]) {
  const chat = lineage.flatMap(session => session.permissions ?? []);
  const approvals = [...policy.projectPermissionApprovals, ...chat.filter(rule => rule.effect === "allow").map(rule => ({ action: rule.action, resources: [rule.resource] }))];
  const external = policy.permission.filter(rule => rule.action === "external_directory");
  const effects = resources.map(resource => permissionAction(chat, "external_directory", resource, "ask") === "deny" ? "deny"
    : projectPermissionEffect({ permissions: policy.permission, projectPermissionApprovals: approvals }, "external_directory", [resource], permissionAction(external, "external_directory", resource, "ask")));
  return effects.includes("deny") ? "deny" : effects.every(effect => effect === "allow") ? "allow" : "ask";
}

const pattern = (folder: string) => `${folder.replaceAll("\\", "/").replace(/\/+$/, "")}/*`;

export function corpusFolderAccess(options: {
  workspace: WorkspaceInfo;
  signal: AbortSignal;
  agent: () => Promise<{ sessionId: string; generation: string; actor: Actor } | null>;
  lineage: (sessionID: string) => Promise<readonly Chat[]>;
  policy: () => Promise<CorpusFolderPolicy>;
  approvals: Pick<ApprovalService, "requestApproval">;
}): CorpusFolderApproval {
  return async path => {
    const agent = await options.agent();
    if (!agent) throw new ApiError(403, "file_access_denied", "Search covers this project's folders. To search another folder, ask in a chat; LegalWork then asks you to approve it.");
    const target = resolve(path);
    const info = await stat(target).catch(() => { throw new ApiError(404, "corpus_path", "This folder or file was not found."); });
    const folder = info.isDirectory() ? target : dirname(target), canonical = await realpath(folder);
    const [lineage, policy] = await Promise.all([options.lineage(agent.sessionId), options.policy()]);
    const effect = corpusFolderEffect(policy, lineage, [...new Set([pattern(folder), pattern(canonical)])]);
    if (effect === "deny") throw new ApiError(403, "file_access_denied", "Your folder permissions block searching this folder.");
    if (effect === "allow") return { folder, canonical };
    // Allow once covers this search; Allow for this chat is remembered for the
    // parent chat under this folder and policy, so a policy change asks again.
    const key = JSON.stringify(["corpus.folder.search", options.workspace.id, canonical, policy]);
    // The app titles and explains this action in the user's language.
    const decision = await options.approvals.requestApproval({ action: "corpus.folder.search", workspaceId: options.workspace.id, actor: agent.actor,
      sessionID: agent.sessionId, summary: `Allow this chat to search the documents in ${basename(canonical) || canonical}?`, paths: [canonical],
    }, options.signal, true, key, { sessionID: lineage.at(-1)?.id ?? agent.sessionId, key });
    if (decision.reason === "approval_storage_unavailable") throw new ApiError(503, "approval_storage_unavailable", "LegalWork's approval storage is unavailable. No access was granted.");
    if (!decision.allowed) throw new ApiError(403, "file_access_denied", "Searching this folder was not approved. Do not retry without a new request from the user.");
    return { folder, canonical };
  };
}

export function serverCorpusFolderAccess(config: ServerConfig, approvals: ApprovalService) {
  return (ctx: RequestContext, workspace: WorkspaceInfo) => corpusFolderAccess({ workspace, signal: ctx.request.signal, approvals,
    agent: () => authenticateWikiAgentRequest(config, ctx.request),
    lineage: sessionID => {
      const client = createEngineClient(config, workspace);
      return chatApprovalLineage(sessionID, id => getWorkspaceEngineSession(client, workspace, id));
    },
    policy: async () => {
      const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
      const effective = applyGlobalToolPermissions(runtime, await readGlobalToolPermissions(config));
      return { permission: (await orgPolicyPermissions(config, effective.permissions ?? [])).permission, projectPermissionApprovals: runtime.projectPermissionApprovals ?? [] };
    },
  });
}
