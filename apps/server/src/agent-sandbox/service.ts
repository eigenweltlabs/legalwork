import { verifiedWikiSessionOrigin } from "../wiki/agent-access.js";
import { wikiProjectAccessSignal, validWikiProjectGrants, wikiProjectSandboxMounts } from "../wiki/project-access.js";
import { within } from "./files.js";
import { withFileEditorHandoff } from "../file-editor-handoff.js";
import { sandboxPaths } from "./paths.js";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { realpath } from "node:fs/promises";
import { listSkills } from "../skills.js";
import { globalOpencodeConfigDir } from "../workspace-files.js";
import { ApprovalService } from "../approvals.js";
import { onOrgPolicyChange } from "../org-policy.js";
import { orgPolicyPermissions } from "../org-policy-engine.js";
import type { Actor, ApprovalRequest, ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import {
  GLOBAL_TOOL_PERMISSIONS_ID, onRuntimeOpencodeConfigWrite, readGlobalToolPermissions,
  readRuntimeOpencodeConfig, runtimeExternalDirectory, runtimeStorageDir,
} from "../runtime-opencode-config-store.js";
import { VmSandbox, validateMounts, type SandboxMount, type SandboxResult } from "./vm.js";
import { permissionAction, permissionPatternMatches, type PermissionAction } from "./permissions.js";
import { effectiveSandbox, onSandboxSettingsChange, writeSandboxNetworkMode, type NetworkMode } from "./settings.js";
import { runHostCommand } from "./host.js";
import { brokerRequest, prepareOutboundRequest, type OutboundRequest } from "./network.js";
import { webRequest, webResult, type WebInput } from "./web.js";
import { WikiStore } from "../wiki/store.js";
import { WikiSync } from "../wiki/sync.js";
import { assertWikiWorkspaceAccess, ownsWikis, wikiAgentCanAccess, wikiForDirectory } from "../wiki/access.js";
import { buildWikiFilePolicy, wikiContentPath, wikiSafeSandboxMounts } from "../wiki/file-access-policy.js";
import { canonicalFolderPath } from "../wiki/workspace-safety.js";
import { rawHttpRequest, type RawHttpInput, type RawHttpNetwork } from "./raw-http.js";

export type SandboxCommand = { command: string; description?: string; sessionID?: string; workdir?: string; skills?: string[]; write: boolean; timeoutMs: number | null; capture?: "complete" };
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
  private stopping = false;
  private clearRemembered: Array<() => void>;
  constructor(readonly config: ServerConfig, readonly approvals: ApprovalService,
    readonly backend: Pick<VmSandbox, "run" | "prepare" | "status"> = new VmSandbox(),
    private readonly rawHttpSend?: RawHttpNetwork["send"]) {
    this.clearRemembered = [
      onRuntimeOpencodeConfigWrite((config, id) => { if (config === this.config) approvals.forgetRemembered(id === GLOBAL_TOOL_PERMISSIONS_ID ? undefined : id); }),
      onSandboxSettingsChange(async config => { if (config === this.config) approvals.forgetRemembered(); }),
      onOrgPolicyChange(config, scopes => { if (scopes.has("engine")) approvals.forgetRemembered(); }),
    ];
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRemembered.splice(0).forEach(unsubscribe => unsubscribe());
    this.approvals.forgetRemembered();
    const pending = [...this.active.values()];
    for (const controller of this.active.keys()) controller.abort(new Error("LegalWork is stopping."));
    await Promise.all(pending);
  }

  async setNetworkMode(mode: NetworkMode): Promise<void> {
    await writeSandboxNetworkMode(this.config, mode);
    // Confirm old commands have lost their sockets before acknowledging a
    // policy change. The VM transport kills the runtime if cleanup stalls.
    await Promise.all([...this.active].filter(([controller]) => controller.signal.aborted).map(([, stopped]) => stopped));
  }

  async run(workspace: WorkspaceInfo, command: SandboxCommand, actor: Actor, parentSignal: AbortSignal,
    agentRules: AgentPermissionRule[] = [], lineage: string[] = command.sessionID ? [command.sessionID] : []): Promise<SandboxResult & { sandbox: "host" | "virtual-machine" }> {
    if (this.config.readOnly && command.write) throw new ApiError(403, "read_only", "This server permits read-only sandbox commands.");
    return this.withPolicy(workspace, command, actor, parentSignal, agentRules, lineage, async ({ settings, permissions, signal, ask, authorizeNetwork }) => {
      const networkMode = settings.networkMode;
      const runtime = await readRuntimeOpencodeConfig(this.config, workspace.id);
      const wikiStore = new WikiStore(this.config);
      const wikis = await wikiStore.list();
      const privateRoots = [wikiStore.baseDir, runtimeStorageDir(this.config)];
      const wikiPolicy = await buildWikiFilePolicy(wikis, workspace.path, privateRoots);
      const wikiAccess = new WikiSync(this.config, wikiStore);
      const ownWiki = wikiForDirectory(wikis, wikiPolicy.directory);
      if (ownWiki && !settings.enabled) throw new ApiError(403, "wiki_sandbox_required", "Enable protected execution to run commands in a wiki chat. Approved projects remain available through the read-only project tools.");
      const projectOrigin = ownWiki && command.sessionID ? await verifiedWikiSessionOrigin(this.config, workspace, command.sessionID, actor.scope ?? "owner", signal) : undefined;
      const projectGrants = ownWiki && command.sessionID && projectOrigin ? await validWikiProjectGrants(this.config, command.sessionID, ownWiki.id, projectOrigin.generation, projectOrigin.scope) : [];
      const projectSignal = ownWiki && command.sessionID ? wikiProjectAccessSignal(this.config, command.sessionID) : undefined;
      const executionSignal = projectSignal ? AbortSignal.any([signal, projectSignal]) : signal;
      const projectMounts = async (mounts: SandboxMount[]) => {
        if (!ownWiki) return mounts;
        if (!command.sessionID || !projectOrigin) throw new ApiError(403, "wiki_project_session_required", "Run protected commands from an authenticated wiki chat.");
        executionSignal.throwIfAborted();
        const currentOrigin = await verifiedWikiSessionOrigin(this.config, workspace, command.sessionID, actor.scope ?? "owner", executionSignal);
        if (currentOrigin.generation !== projectOrigin.generation) throw new ApiError(403, "wiki_project_access_changed", "This chat's project access changed.");
        const checked = await wikiProjectSandboxMounts(this.config, ownWiki.id, new Set(wikis.map(wiki => wiki.workspaceId)), command.sessionID, currentOrigin.generation, currentOrigin.scope, mounts);
        executionSignal.throwIfAborted();
        return checked;
      };
      if (ownWiki && settings.enabled) {
        assertWikiWorkspaceAccess(actor, ownWiki);
        await wikiAccess.ensureReadable(ownWiki, ownsWikis(actor));
        if (command.write) {
          if (!ownsWikis(actor) && actor.scope !== "collaborator") throw new ApiError(403, "wiki_read_only", "This chat has read-only access to its wiki.");
          await wikiAccess.ensureWritable(ownWiki, ownsWikis(actor));
        }
      }
      const commandAction = (tool: string) => restrictive([wholeCommandAction(permissions, tool), wholeAgentAction(agentRules, tool)]);
      await ask("bash", command.command, `Run this command ${settings.enabled ? "in the protected environment" : "on this computer"}?\n\n${command.command}`, [workspace.path], commandAction("bash"));
      if (!settings.enabled) {
        if (this.config.readOnly) throw new ApiError(403, "read_only", "Unprotected commands cannot guarantee read-only access. Enable sandboxing first.");
        await ask("read", "*", "Allow this command to read files on this computer? Sandboxing is off.", [workspace.path], commandAction("read"));
        await ask("edit", "*", "Allow this command to change files on this computer? Sandboxing is off, so file access is not confined to shared folders.", [workspace.path], commandAction("edit"));
        await ask("webfetch", "*", "Allow this command to contact websites or the local network? Sandboxing is off, so individual requests cannot be restricted.", [], commandAction("webfetch"));
        await ask("external_directory", "*", "Allow this command to access folders outside the project? Sandboxing is off, so folder boundaries cannot be enforced.", [workspace.path],
          restrictive([wholeCommandAction({ external_directory: runtimeExternalDirectory(runtime) }, "external_directory"), wholeAgentAction(agentRules, "external_directory")]));
        if (command.skills?.length) {
          const skills = await listSkills(workspace.path, true);
          for (const name of command.skills) {
            const skill = skills.find(item => item.name === name);
            if (!skill) throw new ApiError(400, "sandbox_skill_missing", `Installed skill not found: ${name}`);
            await ask("skill", name, `Allow this command to use the installed skill ${name}?`, [skill.path]);
          }
        }
        const cwd = command.workdir || workspace.path;
        if (!isAbsolute(cwd)) throw new ApiError(400, "command_directory", "Use an absolute folder path on this computer.");
        return { ...await withFileEditorHandoff(command, () => { signal.throwIfAborted(); return runHostCommand({ command: command.command, cwd, timeoutMs: command.timeoutMs, capture: command.capture, signal }); }), sandbox: "host" };
      }
      const writeAction = commandAction("edit");
      const externalRules = runtimeExternalDirectory(runtime);
      const sources = [...new Set(await Promise.all([workspace.path, ...authorizedFolders(externalRules), ...projectGrants.map(grant => grant.root)].map(source => ownWiki ? realpath(source).catch(() => { throw new ApiError(403, "wiki_project_mount_unavailable", "A shared folder is unavailable. Review this chat's project access."); }) : Promise.resolve(source))))];
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
          const source = await realpath(dirname(skill.path));
          mounts.push({ source, target: `/skills/${index}`, writable: command.write && within(await realpath(workspace.path), source) });
        }
      }
      await ask("read", "*", "Allow this command to read all files in these folders, including files covered by individual read rules?", mounts.map((mount) => mount.source), commandAction("read"));
      if (command.write) await ask("edit", "*", `Allow this command to change files in the listed folders?\n\n${command.command}`, sources, writeAction);
      const wikiMounts = await projectMounts(await wikiSafeSandboxMounts(wikiPolicy, mounts));
      for (const mount of wikiMounts) for (const wiki of wikis) {
        if (wiki.id === ownWiki?.id || !within(mount.source, wiki.root) && !within(wiki.root, mount.source)) continue;
        assertWikiWorkspaceAccess(actor, wiki);
        if (!await wikiAgentCanAccess(this.config, wikis, wiki, wikiPolicy.directory))
          throw new ApiError(403, "wiki_access_denied", "This wiki is not available to this project. Remove it from the command's authorized folders.");
        await wikiAccess.ensureReadable(wiki, ownsWikis(actor));
      }
      // Default wiki content lives below the private runtime's parent. Only
      // registered content roots may be shared there, never their parent.
      const safeMounts: SandboxMount[] = [];
      // The shared skill library also lives below the engine configuration.
      // Only explicitly selected skill packages get this exception. Resolve
      // the parent first so a redirected skills folder cannot expose secrets.
      const sharedSkillsRoot = join(await canonicalFolderPath(globalOpencodeConfigDir()), "skills");
      for (const mount of wikiMounts) {
        const sharedSkill = mount.target.startsWith("/skills/") && mount.source !== sharedSkillsRoot && within(sharedSkillsRoot, mount.source);
        const protectedPaths = wikiContentPath(wikiPolicy, mount.source) ? [] : sharedSkill ? privateRoots : wikiPolicy.runtimeRoots;
        const checked = await validateMounts([{ ...mount, target: "/workspace" }], protectedPaths);
        safeMounts.push({ ...checked[0], target: mount.target });
      }
      const cwd = sandboxPaths(command.workdir || "/workspace", safeMounts);
      if (!cwd.startsWith("/")) throw new ApiError(400, "sandbox_directory", "Use /workspace or an authorized sandbox folder.");
      const result = await withFileEditorHandoff(command, () => { executionSignal.throwIfAborted(); return this.backend.run({ command: sandboxPaths(command.command, safeMounts), cwd, mounts: safeMounts,
        timeoutMs: command.timeoutMs, capture: command.capture, signal: executionSignal,
        // Scoped tool/agent rules require the request broker even in allow mode.
        networkMode: networkMode === "allow" && commandAction("webfetch") !== "allow" ? "approve" : networkMode,
        authorizeNetwork,
        beforeCommit: async () => {
          const currentProjectMounts = await projectMounts(safeMounts);
          if (currentProjectMounts.some((mount, index) => mount.writable !== safeMounts[index].writable))
            throw new ApiError(403, "wiki_project_access_changed", "A shared folder became a read-only project while this command ran. Its file changes were not saved.");
          if (ownWiki && command.write) await wikiAccess.ensureWritable(await wikiStore.get(ownWiki.id), ownsWikis(actor));
          const current = await buildWikiFilePolicy(await wikiStore.list(), workspace.path, wikiPolicy.runtimeRoots);
          const checked = await wikiSafeSandboxMounts(current, safeMounts);
          if (checked.some((mount, index) => mount.writable !== safeMounts[index].writable))
            throw new ApiError(403, "wiki_sandbox_policy_changed", "A shared folder became a protected wiki while this command ran. Its file changes were not saved. Use approved wiki tools.");
        },
      }); });
      return { ...result, sandbox: "virtual-machine" };
    });
  }

  async web(workspace: WorkspaceInfo, input: WebInput, actor: Actor, parentSignal: AbortSignal,
    agentRules: AgentPermissionRule[] = [], lineage: string[] = [input.sessionID], send = brokerRequest) {
    const description = input.kind === "fetch" ? `Read ${input.url}` : `Search the web for: ${input.query}`;
    return this.withPolicy(workspace, { sessionID: input.sessionID, description }, actor, parentSignal, agentRules, lineage,
      async ({ settings, signal, ask, authorizeNetwork }) => {
        // Block before preparing a provider request or doing DNS/network IO.
        if (settings.enabled && settings.networkMode === "block") throw new ApiError(403, "sandbox_network_blocked", "Web access is blocked by this chat's network setting.");
        if (input.kind === "search") await ask("websearch", input.query, description, []);
        let request = webRequest(input);
        const allowPrivate = !settings.enabled || settings.networkMode === "allow";
        for (let redirects = 0; redirects <= 5; redirects++) {
          const prepared = prepareOutboundRequest(request, { allowPrivate });
          const connection = new AbortController();
          const requestSignal = AbortSignal.any([signal, connection.signal]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const authorize = async (request: OutboundRequest) => {
            await authorizeNetwork(request);
            // Waiting for a person is not part of the website's response timeout.
            timer = setTimeout(() => connection.abort(new Error("Website request timed out.")), (input.kind === "fetch" ? input.timeout ?? 30 : 30) * 1000);
            return true;
          };
          const response = await send(prepared, authorize, requestSignal, undefined, { allowPrivate }).finally(() => { clearTimeout(timer); });
          if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
            if (redirects === 5) throw new Error("Too many website redirects.");
            // Search requests can carry credentials. Never forward them on a redirect.
            if (input.kind === "search") throw new Error("The search provider redirected the request. No data was forwarded.");
            request = { ...request, url: new URL(response.headers.location, prepared.url).href };
            continue;
          }
          return webResult(input, prepared.url, response, signal);
        }
        throw new Error("Website request did not finish.");
      });
  }

  /** Code Mode's raw Fetch shares policy/revocation, without page-broker content limits. */
  async rawHttp(workspace: WorkspaceInfo, input: RawHttpInput & { sessionID: string }, actor: Actor, parentSignal: AbortSignal,
    agentRules: AgentPermissionRule[] = [], lineage: string[] = [input.sessionID], network?: RawHttpNetwork) {
    return this.withPolicy(workspace, { sessionID: input.sessionID, description: `${input.method} ${input.url}` }, actor, parentSignal, agentRules, lineage,
      async ({ settings, signal, authorizeNetwork }) => rawHttpRequest(input, request => authorizeNetwork(request, true), signal,
        { allowPrivate: !settings.enabled || settings.networkMode === "allow", network, send: this.rawHttpSend }));
  }

  private async withPolicy<T>(workspace: WorkspaceInfo, operation: { sessionID?: string; description?: string }, actor: Actor,
    parentSignal: AbortSignal, agentRules: AgentPermissionRule[], lineage: string[], work: (scope: {
      settings: Awaited<ReturnType<typeof effectiveSandbox>>;
      permissions: Record<string, unknown>;
      signal: AbortSignal;
      ask: (permission: string, pattern: string, summary: string, paths: string[], override?: PermissionAction, reviewable?: boolean, network?: ApprovalRequest["network"]) => Promise<void>;
      authorizeNetwork: (request: OutboundRequest, completeReview?: boolean) => Promise<boolean>;
    }) => Promise<T>): Promise<T> {
    if (this.stopping) throw new ApiError(503, "server_stopping", "LegalWork is stopping.");
    const controller = new AbortController();
    let stopped: () => void = () => {};
    this.active.set(controller, new Promise<void>((resolve) => { stopped = resolve; }));
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const unsubscribe = onRuntimeOpencodeConfigWrite((config, id) => {
      if (config === this.config && (id === workspace.id || id === GLOBAL_TOOL_PERMISSIONS_ID)) {
        this.approvals.forgetRemembered(workspace.id);
        controller.abort(new Error("Permissions changed. Try again with the current permissions."));
      }
    });
    let dependencies: string[] | undefined;
    const unsubscribeSandbox = onSandboxSettingsChange(async (config, id) => {
      if (config !== this.config || (dependencies && !dependencies.includes(id))) return;
      this.approvals.forgetRemembered(workspace.id);
      controller.abort(new Error("Sandbox settings changed. Try again with the current settings."));
      await this.active.get(controller);
    });
    const unsubscribePolicy = onOrgPolicyChange(this.config, (scopes) => {
      if (scopes.has("engine")) { this.approvals.forgetRemembered(workspace.id); controller.abort(new Error("Organization policy changed. Try again with the current permissions.")); }
    });
    try {
      const { permission: permissions } = await orgPolicyPermissions(this.config, await readGlobalToolPermissions(this.config));
      const settings = await effectiveSandbox(this.config, workspace.id, lineage);
      dependencies = settings.dependencies;
      signal.throwIfAborted();
      const ask = async (permission: string, pattern: string, summary: string, paths: string[], override?: PermissionAction, reviewable = true, network?: ApprovalRequest["network"]) => {
        signal.throwIfAborted();
        const action = restrictive([override ?? permissionAction(permissions, permission, pattern), agentAction(agentRules, permission, pattern)]);
        if (action === "deny") throw new ApiError(403, "sandbox_permission_denied", `${permission} is blocked by your permissions.`);
        if (action === "ask") {
          if (!reviewable) throw new ApiError(403, "sandbox_review_limit", "This request is too large to review in the approval dialog. Send a smaller request.");
          const result = await this.approvals.requestApproval({ workspaceId: workspace.id, actor,
            action: `sandbox.${permission}`, summary, paths, sessionID: operation.sessionID, description: operation.description,
            ...(network ? { network } : {}) }, signal, true, operation.sessionID ? JSON.stringify([workspace.id, operation.sessionID, permission, pattern, paths, network, permissions, agentRules, settings.enabled, settings.networkMode]) : undefined);
          if (!result.allowed) throw new ApiError(403, "sandbox_permission_denied", "Sandbox permission was declined.");
        }
        signal.throwIfAborted();
      };
      const authorizeNetwork = async (request: OutboundRequest, completeReview = false) => {
        signal.throwIfAborted();
        if (settings.enabled && settings.networkMode === "block") throw new ApiError(403, "sandbox_network_blocked", "All sandbox network traffic is blocked in Settings.");
        const bytes = Buffer.from(request.bodyBase64, "base64");
        const text = bytes.toString("utf8");
        const bodyFormat = Buffer.from(text).equals(bytes) && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text) ? "text" : "base64";
        const body = bodyFormat === "text" ? text : `Base64: ${request.bodyBase64}`;
        // The approval is bound to the in-memory immutable request. A changed
        // body, URL or header necessarily produces a separate request.
        const preview = completeReview ? `${request.method} ${request.url}\n\nRequest SHA-256: ${request.sha256}`
          : `${request.method} ${request.url}\n\nHeaders:\n${JSON.stringify(request.headers, null, 2)}\n\nBody (${request.bodyBytes} bytes):\n${body}\n\nRequest SHA-256: ${request.sha256}`;
        const action = permissionAction(permissions, "webfetch", request.url);
        await ask("webfetch", request.url, preview, [], settings.enabled && settings.networkMode === "approve" ? restrictive(["ask", action]) : action, completeReview || preview.length <= 16000, { url: request.url, method: request.method, headers: request.headers,
          body: bodyFormat === "text" ? text : request.bodyBase64, bodyFormat, bodyBytes: request.bodyBytes,
          ...(completeReview ? { complete: true, sha256: request.sha256 } : {}) });
        return true;
      };
      return await work({ settings, permissions, signal, ask, authorizeNetwork });
    } finally {
      unsubscribeSandbox();
      unsubscribe();
      unsubscribePolicy();
      controller.abort();
      this.active.delete(controller);
      stopped();
    }
  }
}
