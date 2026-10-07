import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ApprovalService } from "../approvals.js";
import type { Actor, ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import {
  GLOBAL_TOOL_PERMISSIONS_ID, onRuntimeOpencodeConfigWrite, readGlobalToolPermissions,
  readRuntimeOpencodeConfig, runtimeExternalDirectory, runtimeStorageDir,
} from "../runtime-opencode-config-store.js";
import { VmSandbox, validateMounts, type SandboxMount, type SandboxResult } from "./vm.js";
import { permissionAction, permissionPatternMatches, type PermissionAction } from "./permissions.js";

export type SandboxCommand = { command: string; workdir?: string; write: boolean; timeoutMs: number };
export type AgentPermissionRule = { permission: string; pattern: string; action: PermissionAction };

function restrictive(actions: PermissionAction[]): PermissionAction {
  return actions.includes("deny") ? "deny" : actions.includes("ask") ? "ask" : "allow";
}

function wholeCommandAction(permissions: Record<string, unknown>, tool: string): PermissionAction {
  const actions: PermissionAction[] = [permissionAction(permissions, tool, "*")];
  // A script can run arbitrary descendants and inspect every mounted file.
  // Conservatively apply scoped restrictions to the whole command. Matching
  // only the outer command would let `python script.py` bypass inner rules.
  for (const [name, rule] of Object.entries(permissions)) {
    if (!permissionPatternMatches(tool, name) || !rule || typeof rule !== "object") continue;
    for (const value of Object.values(rule)) actions.push(value === "allow" || value === "ask" ? value : "deny");
  }
  return restrictive(actions);
}

function agentAction(rules: AgentPermissionRule[], permission: string, pattern: string): PermissionAction {
  let action: PermissionAction = "allow";
  for (const rule of rules) {
    if (permissionPatternMatches(permission, rule.permission) && permissionPatternMatches(pattern, rule.pattern)) action = rule.action;
  }
  return action;
}

function authorizedFolders(entries: Record<string, unknown>): string[] {
  const folders: string[] = [];
  for (const [pattern, action] of Object.entries(entries)) {
    if (action !== "allow" || !pattern.endsWith("/*")) continue;
    let folder = pattern.slice(0, -2) || "/";
    if (folder.startsWith("~/")) folder = join(homedir(), folder.slice(2));
    if (!isAbsolute(folder) || /[*?]/.test(folder)) continue;
    // Re-evaluate the ordered rules, so a later denial revokes an old grant.
    if (permissionAction({ external_directory: entries }, "external_directory", `${folder}/__sandbox__`, "deny") !== "allow") continue;
    folders.push(folder);
  }
  return [...new Set(folders)];
}

export class AgentSandboxService {
  private active = new Set<AbortController>();
  constructor(readonly config: ServerConfig, readonly approvals: ApprovalService,
    readonly backend: Pick<VmSandbox, "run" | "prepare" | "status"> = new VmSandbox()) {}

  stop(): void {
    for (const controller of this.active) controller.abort(new Error("LegalWork is stopping."));
  }

  async run(workspace: WorkspaceInfo, command: SandboxCommand, actor: Actor, parentSignal: AbortSignal,
    agentRules: AgentPermissionRule[] = []): Promise<SandboxResult> {
    if (this.config.readOnly && command.write) throw new ApiError(403, "read_only", "This server permits read-only sandbox commands.");
    const controller = new AbortController();
    this.active.add(controller);
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const unsubscribe = onRuntimeOpencodeConfigWrite((config, id) => {
      if (config === this.config && (id === workspace.id || id === GLOBAL_TOOL_PERMISSIONS_ID)) {
        controller.abort(new Error("Permissions changed. Run the command again with the current permissions."));
      }
    });
    try {
      const permissions = await readGlobalToolPermissions(this.config);
      const runtime = await readRuntimeOpencodeConfig(this.config, workspace.id);
      signal.throwIfAborted();
      const ask = async (permission: string, pattern: string, summary: string, paths: string[], override?: PermissionAction, reviewable = true) => {
        signal.throwIfAborted();
        const action = restrictive([override ?? permissionAction(permissions, permission, pattern), agentAction(agentRules, permission, pattern)]);
        if (action === "deny") throw new ApiError(403, "sandbox_permission_denied", `${permission} is blocked by your permissions.`);
        if (action === "ask") {
          if (!reviewable) throw new ApiError(403, "sandbox_review_limit", "This request is too large to review in the approval dialog. Send a smaller request.");
          const result = await this.approvals.requestApproval({ workspaceId: workspace.id, actor,
            action: `sandbox.${permission}`, summary, paths }, signal, true);
          if (!result.allowed) throw new ApiError(403, "sandbox_permission_denied", "Sandbox permission was declined.");
        }
        signal.throwIfAborted();
      };
      const commandAction = (tool: string) => restrictive([wholeCommandAction(permissions, tool),
        ...agentRules.filter((rule) => permissionPatternMatches(tool, rule.permission) && rule.pattern !== "*").map((rule) => rule.action),
        agentAction(agentRules, tool, "*")]);
      await ask("bash", command.command, `Run this command in the protected environment?\n\n${command.command}`, [workspace.path], commandAction("bash"));
      const writeAction = commandAction("edit");
      const externalRules = runtimeExternalDirectory(runtime);
      const sources = [workspace.path, ...authorizedFolders(externalRules)];
      if (sources.length > 1 && Object.entries(externalRules).some(([pattern, action]) => pattern !== "*" && action === "deny")) {
        throw new ApiError(403, "sandbox_directory_scope", "A scoped folder denial cannot be enforced by sharing the whole folder. Choose narrower authorized folders.");
      }
      for (const source of sources.slice(1)) {
        await ask("external_directory", `${source}/__sandbox__`, "Allow this command to access this authorized folder?", [source],
          restrictive(["allow", ...agentRules.filter((rule) => permissionPatternMatches("external_directory", rule.permission) && rule.pattern !== "*").map((rule) => rule.action)]));
      }
      await ask("read", "*", "Allow this command to read all files in these folders, including files covered by individual read rules?", sources, commandAction("read"));
      if (command.write) await ask("edit", "*", `Allow this command to change files in the listed folders?\n\n${command.command}`, sources, writeAction);
      const mounts: SandboxMount[] = sources.map((source, index) => ({ source,
        target: index === 0 ? "/workspace" : `/authorized/${index - 1}`, writable: command.write }));
      const safeMounts = await validateMounts(mounts, [runtimeStorageDir(this.config)]);
      const cwd = command.workdir || "/workspace";
      if (!cwd.startsWith("/")) throw new ApiError(400, "sandbox_directory", "Use /workspace or an authorized sandbox folder.");
      return await this.backend.run({ command: command.command, cwd, mounts: safeMounts,
        timeoutMs: command.timeoutMs, signal,
        authorizeNetwork: async (request) => {
          const bytes = Buffer.from(request.bodyBase64, "base64");
          const text = bytes.toString("utf8");
          const body = Buffer.from(text).equals(bytes) ? text : `Base64: ${request.bodyBase64}`;
          // The approval is bound to the in-memory immutable request. A changed
          // body, URL or header necessarily produces a separate request.
          const preview = `${request.method} ${request.url}\n\nHeaders:\n${JSON.stringify(request.headers, null, 2)}\n\nBody (${request.bodyBytes} bytes):\n${body}\n\nRequest SHA-256: ${request.sha256}`;
          await ask("webfetch", request.url, preview, [], undefined, preview.length <= 16000);
          return true;
        },
      });
    } finally {
      unsubscribe();
      controller.abort();
      this.active.delete(controller);
    }
  }
}
