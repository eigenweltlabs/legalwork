import { realpath } from "node:fs/promises";
import type { AudioRecordingMeta } from "@legalwork/types/audio";
import type { ServerConfig } from "./types.js";
import type { ApprovalService } from "./approvals.js";
import { ApiError } from "./errors.js";
import { within } from "./agent-sandbox/files.js";
import { permissionAction } from "./agent-sandbox/permissions.js";
import { authenticateWikiAgentRequest } from "./wiki/agent-access.js";
import { requireWikiProjectAccess, wikiProjectAccessRevision, wikiProjectGrants } from "./wiki/project-access.js";
import { applyGlobalToolPermissions, readGlobalToolPermissions, readRuntimeOpencodeConfig, runtimeExternalDirectory } from "./runtime-opencode-config-store.js";
import { orgPolicyPermissions } from "./org-policy-engine.js";
import { projectPermissionEffect } from "./project-permission-approvals.js";

// Grants are scoped to the authenticated chat generation, project root and current
// permissions. They disappear on restart and cannot outlive an access downgrade.
const approvalsByConfig = new WeakMap<ServerConfig, Set<string>>();

export async function recordingAccess(config: ServerConfig, request: Request, approvals: ApprovalService) {
  const agent = await authenticateWikiAgentRequest(config, request);
  const check = async () => {
    if (!agent) return;
    const current = await authenticateWikiAgentRequest(config, request);
    if (!current || current.generation !== agent.generation || current.actor.scope !== "owner")
      throw new ApiError(403, "recording_access_changed", "This chat's permissions changed. Retry with its current access.");
  };
  const scheduled = agent?.scheduledProjects;
  const visible = (meta: AudioRecordingMeta) => !Array.isArray(scheduled)
    || !meta.projectIds?.length || meta.projectIds.some(id => scheduled.includes(id));
  const authorize = async (meta: AudioRecordingMeta) => {
    // Human owner API reads have no agent session. The route checks owner scope.
    if (!agent) return;
    await check();
    if (!visible(meta)) throw new ApiError(403, "recording_project_denied", "This scheduled task can read only its configured projects and global recordings.");
    if (agent.scheduledProjects !== undefined || !meta.projectIds?.length) return;
    const projects = (await Promise.all(config.workspaces.map(async workspace => {
      const root = await realpath(workspace.directory || workspace.path).catch(() => null);
      return root ? [{ ...workspace, root }] : [];
    }))).flat();
    const own = projects.filter(project => within(project.root, agent.directory)).sort((a, b) => b.root.length - a.root.length)[0];
    if (!own) throw new ApiError(403, "recording_project_unknown", "This chat's project is unavailable.");
    if (meta.projectIds.includes(own.id)) return;
    const targets = projects.filter(project => meta.projectIds?.includes(project.id));
    if (!targets.length) throw new ApiError(403, "recording_project_unavailable", "The recording belongs to a project that is no longer available. Restore project access before reading it.");
    const policy = async () => {
      const runtime = await readRuntimeOpencodeConfig(config, own.id);
      const effective = applyGlobalToolPermissions(runtime, await readGlobalToolPermissions(config));
      const { permission } = await orgPolicyPermissions(config, effective.permissions ?? []);
      return { external: runtimeExternalDirectory({ permissions: permission }), permission,
        projectPermissionApprovals: runtime.projectPermissionApprovals ?? [], revision: wikiProjectAccessRevision(config, agent.sessionId) };
    };
    const rules = await policy();
    if (permissionAction(rules.permission, "legalwork_recording_read", meta.id) === "deny")
      throw new ApiError(403, "recording_permission_denied", "Transcript reads are blocked by your tool permissions.");
    const folderEffect = (root: string) => {
      const resource = `${root}/__recordings__`;
      return projectPermissionEffect({ permissions: rules.permission, projectPermissionApprovals: rules.projectPermissionApprovals },
        "external_directory", [resource], permissionAction(rules.external, "external_directory", resource, "ask"));
    };
    const candidates = targets.filter(target => folderEffect(target.root) !== "deny");
    for (const target of candidates) {
      const existing = wikiProjectGrants(config, agent.sessionId).find(grant => grant.projectId === target.id);
      if (existing && await requireWikiProjectAccess(config, agent.sessionId, target.id, existing.wikiId, agent.generation, "owner").then(() => true, () => false)) return;
      if (folderEffect(target.root) === "allow") return;
    }
    const target = candidates[0];
    if (!target) throw new ApiError(403, "recording_permission_denied", "Access to the recording's project is blocked by your folder permissions.");
    const key = JSON.stringify([agent.sessionId, agent.generation, own.id, own.root, target.id, target.root, rules]);
    let granted = approvalsByConfig.get(config);
    if (!granted) { granted = new Set(); approvalsByConfig.set(config, granted); }
    if (granted.has(key)) return;
    const decision = await approvals.requestApproval({ action: "recordings.project.read", workspaceId: own.id,
      actor: agent.actor, sessionID: agent.sessionId, summary: `Allow this chat to read recordings in ${target.displayName || target.name}?`,
      paths: [target.root], description: `Read-only access to this project's recording transcripts and speaker names, starting with “${meta.title}”. This approval applies to this chat, expires on restart, and does not grant access to other project files.`,
    }, request.signal, true);
    if (!decision.allowed) throw new ApiError(403, "recording_access_denied", "Project recording access was not approved. Do not retry without a new user request.");
    await check();
    const currentTarget = config.workspaces.find(project => project.id === target.id);
    const root = currentTarget ? await realpath(currentTarget.directory || currentTarget.path).catch(() => null) : null;
    if (root !== target.root || JSON.stringify(await policy()) !== JSON.stringify(rules))
      throw new ApiError(403, "recording_access_changed", "Project permissions changed while approval was pending. Retry with the current access.");
    granted.add(key);
  };
  return { visible, authorize, check, scope: { projects: scheduled ?? "all", globalRecordings: true,
    transcriptAccess: scheduled === undefined ? "Global and current-project transcripts are available; other projects require existing access or user approval." : "Limited to the scheduled task's configured projects plus global recordings. No access expansion during a run." } };
}
