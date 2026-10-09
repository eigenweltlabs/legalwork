import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { listSkills } from "../skills.js";
import { ApprovalService } from "../approvals.js";
import type { Actor, ApprovalRequest, ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import {
  GLOBAL_TOOL_PERMISSIONS_ID, onRuntimeOpencodeConfigWrite, readGlobalToolPermissions,
  readRuntimeOpencodeConfig, runtimeExternalDirectory, runtimeStorageDir,
} from "../runtime-opencode-config-store.js";
import { VmSandbox, validateMounts, type SandboxMount, type SandboxResult } from "./vm.js";
import { permissionAction, permissionPatternMatches, type PermissionAction } from "./permissions.js";
import { readSandboxNetworkMode, writeSandboxNetworkMode, type NetworkMode } from "./settings.js";

export type SandboxCommand = { command: string; workdir?: string; skills?: string[]; write: boolean; timeoutMs: number };
export type AgentPermissionRule = { permission: string; pattern: string; action: PermissionAction };

function restrictive(actions: PermissionAction[]): PermissionAction {
  return actions.includes("deny") ? "deny" : actions.includes("ask") ? "ask" : "allow";
}

function wholeCommandAction(permissions: Record<string, unknown>, tool: string): PermissionAction {
  const rules: AgentPermissionRule[] = [];
  // A script can run arbitrary descendants and inspect every mounted file.
  // Conservatively apply scoped restrictions to the whole command. Matching
  // only the outer command would let `python script.py` bypass inner rules.
  for (const [name, rule] of Object.entries(permissions)) {
    if (!permissionPatternMatches(tool, name)) continue;
    for (const [pattern, value] of Object.entries(rule && typeof rule === "object" ? rule : { "*": rule })) {
      rules.push({ permission: name, pattern, action: value === "allow" || value === "ask" ? value : "deny" });
    }
  }
  return wholeAgentAction(rules, tool);
}

function wholeAgentAction(rules: AgentPermissionRule[], tool: string): PermissionAction {
  let actions: PermissionAction[] = ["allow"];
  for (const rule of rules) {
    if (!permissionPatternMatches(tool, rule.permission)) continue;
    // A later whole-tool rule replaces earlier scoped engine defaults.
    if (rule.pattern === "*") actions = [rule.action];
    else actions.push(rule.action);
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
  private active = new Map<AbortController, Promise<void>>();
  constructor(readonly config: ServerConfig, readonly approvals: ApprovalService,
    readonly backend: Pick<VmSandbox, "run" | "prepare" | "status"> = new VmSandbox()) {}

  stop(): void {
    for (const controller of this.active.keys()) controller.abort(new Error("LegalWork is stopping."));
  }

  async setNetworkMode(mode: NetworkMode): Promise<void> {
    await writeSandboxNetworkMode(this.config, mode);
    // Confirm old commands have lost their sockets before acknowledging a
    // policy change. The VM transport kills the runtime if cleanup stalls.
    await Promise.all([...this.active].filter(([controller]) => controller.signal.aborted).map(([, stopped]) => stopped));
  }

  async run(workspace: WorkspaceInfo, command: SandboxCommand, actor: Actor, parentSignal: AbortSignal,
    agentRules: AgentPermissionRule[] = []): Promise<SandboxResult> {
    if (this.config.readOnly && command.write) throw new ApiError(403, "read_only", "This server permits read-only sandbox commands.");
    const controller = new AbortController();
    let stopped: () => void = () => {};
    this.active.set(controller, new Promise<void>((resolve) => { stopped = resolve; }));
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const unsubscribe = onRuntimeOpencodeConfigWrite((config, id) => {
      if (config === this.config && (id === workspace.id || id === GLOBAL_TOOL_PERMISSIONS_ID)) {
        controller.abort(new Error("Permissions changed. Run the command again with the current permissions."));
      }
    });
    try {
      const permissions = await readGlobalToolPermissions(this.config);
      const networkMode = await readSandboxNetworkMode(this.config);
      const runtime = await readRuntimeOpencodeConfig(this.config, workspace.id);
      signal.throwIfAborted();
      const ask = async (permission: string, pattern: string, summary: string, paths: string[], override?: PermissionAction, reviewable = true, network?: ApprovalRequest["network"]) => {
        signal.throwIfAborted();
        const action = restrictive([override ?? permissionAction(permissions, permission, pattern), agentAction(agentRules, permission, pattern)]);
        if (action === "deny") throw new ApiError(403, "sandbox_permission_denied", `${permission} is blocked by your permissions.`);
        if (action === "ask") {
          if (!reviewable) throw new ApiError(403, "sandbox_review_limit", "This request is too large to review in the approval dialog. Send a smaller request.");
          const result = await this.approvals.requestApproval({ workspaceId: workspace.id, actor,
            action: `sandbox.${permission}`, summary, paths, ...(network ? { network } : {}) }, signal, true);
          if (!result.allowed) throw new ApiError(403, "sandbox_permission_denied", "Sandbox permission was declined.");
        }
        signal.throwIfAborted();
      };
      const commandAction = (tool: string) => restrictive([wholeCommandAction(permissions, tool), wholeAgentAction(agentRules, tool)]);
      await ask("bash", command.command, `Run this command in the protected environment?\n\n${command.command}`, [workspace.path], commandAction("bash"));
      const writeAction = commandAction("edit");
      const externalRules = runtimeExternalDirectory(runtime);
      const sources = [workspace.path, ...authorizedFolders(externalRules)];
      if (sources.length > 1 && Object.entries(externalRules).some(([pattern, action]) => pattern !== "*" && action === "deny")) {
        throw new ApiError(403, "sandbox_directory_scope", "A scoped folder denial cannot be enforced by sharing the whole folder. Choose narrower authorized folders.");
      }
      // An allowed parent can contain a child that still requires approval.
      // The guest can read every exposed file, so ask before sharing it.
      const folderAction = Object.entries(externalRules).some(([pattern, action]) => pattern !== "*" && action === "ask") ? "ask" : "allow";
      for (const source of sources.slice(1)) {
        await ask("external_directory", `${source}/__sandbox__`, "Allow this command to access all files in this authorized folder, including files covered by individual folder rules?", [source],
          restrictive([folderAction, ...agentRules.filter((rule) => permissionPatternMatches("external_directory", rule.permission) && rule.pattern !== "*").map((rule) => rule.action)]));
      }
      const mounts: SandboxMount[] = sources.map((source, index) => ({ source,
        target: index === 0 ? "/workspace" : `/authorized/${index - 1}`, writable: command.write }));
      if (command.skills?.length) {
        const installed = await listSkills(workspace.path, true);
        for (const [index, name] of command.skills.entries()) {
          const skill = installed.find((item) => item.name === name);
          if (!skill) throw new ApiError(400, "sandbox_skill_missing", `Installed skill not found: ${name}`);
          await ask("skill", name, `Allow this command to use the installed skill ${name}?`, [skill.path]);
          mounts.push({ source: dirname(skill.path), target: `/skills/${index}`, writable: false });
        }
      }
      await ask("read", "*", "Allow this command to read all files in these folders, including files covered by individual read rules?", mounts.map((mount) => mount.source), commandAction("read"));
      if (command.write) await ask("edit", "*", `Allow this command to change files in the listed folders?\n\n${command.command}`, sources, writeAction);
      const safeMounts = await validateMounts(mounts, [runtimeStorageDir(this.config)]);
      const cwd = command.workdir || "/workspace";
      if (!cwd.startsWith("/")) throw new ApiError(400, "sandbox_directory", "Use /workspace or an authorized sandbox folder.");
      return await this.backend.run({ command: command.command, cwd, mounts: safeMounts,
        timeoutMs: command.timeoutMs, signal,
        // Scoped tool/agent rules require the request broker even in allow mode.
        networkMode: networkMode === "allow" && commandAction("webfetch") !== "allow" ? "approve" : networkMode,
        authorizeNetwork: async (request) => {
          signal.throwIfAborted();
          if (networkMode === "block") throw new ApiError(403, "sandbox_network_blocked", "All sandbox network traffic is blocked in Settings.");
          const bytes = Buffer.from(request.bodyBase64, "base64");
          const text = bytes.toString("utf8");
          const bodyFormat = Buffer.from(text).equals(bytes) && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text) ? "text" : "base64";
          const body = bodyFormat === "text" ? text : `Base64: ${request.bodyBase64}`;
          // The approval is bound to the in-memory immutable request. A changed
          // body, URL or header necessarily produces a separate request.
          const preview = `${request.method} ${request.url}\n\nHeaders:\n${JSON.stringify(request.headers, null, 2)}\n\nBody (${request.bodyBytes} bytes):\n${body}\n\nRequest SHA-256: ${request.sha256}`;
          const action = permissionAction(permissions, "webfetch", request.url);
          await ask("webfetch", request.url, preview, [], networkMode === "approve" ? restrictive(["ask", action]) : action, preview.length <= 16000, { url: request.url, method: request.method, headers: request.headers,
            body: bodyFormat === "text" ? text : request.bodyBase64, bodyFormat, bodyBytes: request.bodyBytes });
          return true;
        },
      });
    } finally {
      unsubscribe();
      controller.abort();
      this.active.delete(controller);
      stopped();
    }
  }
}
