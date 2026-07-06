import * as React from "react";

import { applyEdits, modify } from "jsonc-parser";

import { t } from "../../../../i18n";
import type {
  Client,
  HubSkillCard,
  HubSkillRepo,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  SkillCard,
  SkillResourceCard,
} from "../../../../app/types";
import { addOpencodeCacheHint, isDesktopRuntime, normalizeDirectoryPath } from "../../../../app/utils";
import skillCreatorTemplate from "../../../../app/data/skill-creator.md?raw";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "../../../../app/utils/plugins";
import {
  exportSkillZip as exportSkillZipCommand,
  importSkill,
  importSkillZip as importSkillZipCommand,
  installSkillTemplate,
  installSkillFiles,
  joinDesktopPath,
  listLocalSkills,
  openDesktopPath,
  pickDirectory,
  readLocalSkill,
  readOpencodeConfig,
  pickFile,
  revealDesktopItemInDir,
  saveFile,
  uninstallSkill as uninstallSkillCommand,
  workspaceLegalworkRead,
  workspaceLegalworkWrite,
  writeLocalSkill,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../../../../app/lib/desktop";
import type {
  LegalworkClaudePluginPreview,
  LegalworkHubRepo,
  LegalworkServerCapabilities,
  LegalworkServerClient,
  LegalworkServerStatus,
} from "../../../../app/lib/legalwork-server";
import type { LegalworkServerStore } from "../../connections/legalwork-server-store";

const OPENCODE_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const OPENCODE_MCP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const OPENCODE_MCP_IMPORT_PATH_PREFIX = "opencode.jsonc#mcp.";
const DEFAULT_HUB_REF = "main";
const HUB_REPOS_STORAGE_KEY = "legalwork.skills.hubRepos.v1";

type SetStateAction<T> = T | ((current: T) => T);

type PluginListEntry = {
  name: string;
  source: "config" | "dir.project" | "dir.global";
  removable: boolean;
};

export type ExtensionsStoreSnapshot = {
  workspaceContextKey: string;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillResources: SkillResourceCard[];
  skillResourcesStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  hubRepo: HubSkillRepo | null;
  hubRepos: HubSkillRepo[];
  pluginScope: PluginScope;
  pluginConfig: OpencodeConfigFile | null;
  pluginConfigPath: string | null;
  pluginList: PluginListEntry[];
  pluginInput: string;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  sidebarPluginList: string[];
  sidebarPluginStatus: string | null;
  skillsStale: boolean;
  pluginsStale: boolean;
  hubSkillsStale: boolean;
};

type MutableState = {
  skillsContextKey: string;
  pluginsContextKey: string;
  hubSkillsContextKey: string;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillResources: SkillResourceCard[];
  skillResourcesStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  hubRepo: HubSkillRepo | null;
  hubRepos: HubSkillRepo[];
  pluginScope: PluginScope;
  pluginConfig: OpencodeConfigFile | null;
  pluginConfigPath: string | null;
  pluginList: PluginListEntry[];
  pluginInput: string;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  sidebarPluginList: string[];
  sidebarPluginStatus: string | null;
};

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;

export type GithubSkillItem = { dir: string; name: string; description: string };

// Decode base64 (from the GitHub-skills server payload) into a UTF-8 string.
function base64ToUtf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toConfigPluginListEntries(names: string[]): PluginListEntry[] {
  const next: PluginListEntry[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    next.push({ name, source: "config", removable: true });
  }
  return next;
}

function toProjectPluginListEntries(
  items: Array<{ spec: string; source: string }>,
): PluginListEntry[] {
  const byName = new Map<string, PluginListEntry>();
  for (const item of items) {
    const name = item.spec.trim();
    if (!name) continue;
    const source: PluginListEntry["source"] =
      item.source === "dir.project" || item.source === "dir.global"
        ? item.source
        : "config";
    const entry: PluginListEntry = {
      name,
      source,
      removable: source === "config",
    };
    const existing = byName.get(name);
    if (!existing || (entry.removable && !existing.removable)) {
      byName.set(name, entry);
    }
  }
  return [...byName.values()];
}

export function createExtensionsStore(options: {
  client: () => Client | null;
  projectDir: () => string;
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  legalworkServer: LegalworkServerStore;
  legalworkServerConnection?: () => {
    legalworkServerClient: LegalworkServerClient | null;
    legalworkServerStatus: LegalworkServerStatus;
    legalworkServerCapabilities: LegalworkServerCapabilities | null;
  };
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const listeners = new Set<() => void>();

  let disposed = false;
  let started = false;
  let stopLegalworkSubscription: (() => void) | null = null;
  let lastWorkspaceContextKey = "";
  let snapshot: ExtensionsStoreSnapshot;

  let refreshSkillsInFlight = false;
  let refreshPluginsInFlight = false;
  let refreshHubSkillsInFlight = false;
  let refreshSkillsAborted = false;
  let refreshPluginsAborted = false;
  let refreshHubSkillsAborted = false;
  let skillsLoaded = false;
  let hubSkillsLoaded = false;
  let skillsRoot = "";
  let hubSkillsLoadKey = "";

  let state: MutableState = {
    skillsContextKey: "",
    pluginsContextKey: "",
    hubSkillsContextKey: "",
    skills: [],
    skillsStatus: null,
    skillResources: [],
    skillResourcesStatus: null,
    hubSkills: [],
    hubSkillsStatus: null,
    hubRepo: null,
    hubRepos: [],
    // Plugins are global by default so they apply to every workspace (opencode reads its
    // global config for all projects). The per-workspace scope toggle was removed.
    pluginScope: "global",
    pluginConfig: null,
    pluginConfigPath: null,
    pluginList: [],
    pluginInput: "",
    pluginStatus: null,
    activePluginGuide: null,
    sidebarPluginList: [],
    sidebarPluginStatus: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getWorkspaceContextKey = () => {
    const workspaceId = options.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(options.selectedWorkspaceRoot().trim());
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    const workspaceType = options.workspaceType();
    return `${workspaceType}:${workspaceId}:${root}:${runtimeWorkspaceId}`;
  };

  const getLegalworkServerSnapshot = () => {
    const snapshot = options.legalworkServer.getSnapshot();
    const connection = options.legalworkServerConnection?.();
    if (!connection?.legalworkServerClient) return snapshot;
    return {
      ...snapshot,
      legalworkServerClient: connection.legalworkServerClient,
      legalworkServerStatus: connection.legalworkServerStatus,
      legalworkServerCapabilities: connection.legalworkServerCapabilities,
    };
  };

  const resolveWorkspaceServerTarget = async () => {
    const legalworkSnapshot = getLegalworkServerSnapshot();
    const legalworkClient = legalworkSnapshot.legalworkServerClient;
    let legalworkWorkspaceId = options.runtimeWorkspaceId()?.trim() || null;
    if (!legalworkWorkspaceId && legalworkSnapshot.legalworkServerStatus === "connected" && legalworkClient) {
      legalworkWorkspaceId = (await options.ensureRuntimeWorkspaceId?.())?.trim() || null;
    }
    const hasLegalworkTarget =
      legalworkSnapshot.legalworkServerStatus === "connected" &&
      Boolean(legalworkClient && legalworkWorkspaceId);
    return {
      legalworkSnapshot,
      legalworkClient,
      legalworkWorkspaceId,
      hasLegalworkTarget,
    };
  };

  const refreshSnapshot = () => {
    const workspaceContextKey = getWorkspaceContextKey();
    snapshot = {
      workspaceContextKey,
      skills: state.skills,
      skillsStatus: state.skillsStatus,
      skillResources: state.skillResources,
      skillResourcesStatus: state.skillResourcesStatus,
      hubSkills: state.hubSkills,
      hubSkillsStatus: state.hubSkillsStatus,
      hubRepo: state.hubRepo,
      hubRepos: state.hubRepos,
      pluginScope: state.pluginScope,
      pluginConfig: state.pluginConfig,
      pluginConfigPath: state.pluginConfigPath,
      pluginList: state.pluginList,
      pluginInput: state.pluginInput,
      pluginStatus: state.pluginStatus,
      activePluginGuide: state.activePluginGuide,
      sidebarPluginList: state.sidebarPluginList,
      sidebarPluginStatus: state.sidebarPluginStatus,
      skillsStale: state.skillsContextKey !== workspaceContextKey,
      pluginsStale: state.pluginsContextKey !== workspaceContextKey,
      hubSkillsStale: state.hubSkillsContextKey !== workspaceContextKey,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
    typeof next === "function" ? (next as (value: T) => T)(current) : next;

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");

  const normalizeHubRepo = (input?: Partial<HubSkillRepo> | null): HubSkillRepo | null => {
    const owner = input?.owner?.trim() || "";
    const repo = input?.repo?.trim() || "";
    const ref = input?.ref?.trim() || DEFAULT_HUB_REF;
    if (!owner || !repo) return null;
    return { owner, repo, ref };
  };

  const hubRepoKey = (repo: HubSkillRepo) => `${repo.owner}/${repo.repo}@${repo.ref}`;

  const normalizeHubRepoList = (items: unknown[]): HubSkillRepo[] => {
    const seen = new Set<string>();
    const next: HubSkillRepo[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const normalized = normalizeHubRepo({
        owner: typeof record.owner === "string" ? record.owner : undefined,
        repo: typeof record.repo === "string" ? record.repo : undefined,
        ref: typeof record.ref === "string" ? record.ref : undefined,
      });
      if (!normalized) continue;
      const key = hubRepoKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(normalized);
    }
    return next;
  };

  const upsertWorkspaceSkill = async (
    name: string,
    content: string,
    description: string,
    optionsOverride?: { overwrite?: boolean },
  ) => {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const root = options.selectedWorkspaceRoot().trim();
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skills?.write !== false;

    // Desktop: skills are GLOBAL — install to the shared skills dir (empty projectDir)
    // so every workspace sees them, no workspace selection required.
    if (isDesktopRuntime()) {
      const result = (await installSkillTemplate("", name, content, {
        overwrite: optionsOverride?.overwrite ?? false,
      })) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || t("skills.install_failed"));
      }
      return;
    }

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      await legalworkClient.upsertSkill(legalworkWorkspaceId, {
        name,
        content,
        description,
      });
      return;
    }

    if (isRemoteWorkspace) {
      throw new Error("LegalWork server unavailable. Connect to import skills.");
    }

    throw new Error(t("skills.desktop_required"));
  };

  const deleteWorkspaceSkill = async (name: string) => {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const root = options.selectedWorkspaceRoot().trim();
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skills?.write !== false;

    // Desktop: skills are GLOBAL — remove from the shared skills dir.
    if (isDesktopRuntime()) {
      const result = (await uninstallSkillCommand("", name)) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || t("skills.uninstall_failed"));
      }
      return;
    }

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      await legalworkClient.deleteSkill(legalworkWorkspaceId, name);
      return;
    }

    if (isRemoteWorkspace) {
      throw new Error("LegalWork server unavailable. Connect to remove skills.");
    }

    throw new Error(t("skills.desktop_required"));
  };

  const persistHubRepos = () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        HUB_REPOS_STORAGE_KEY,
        JSON.stringify({ selected: state.hubRepo, repos: state.hubRepos }),
      );
    } catch {
      // ignore
    }
  };

  const invalidateWorkspaceCaches = () => {
    skillsLoaded = false;
    hubSkillsLoaded = false;
    skillsRoot = "";
    hubSkillsLoadKey = "";
  };

  const touch = () => {
    refreshSnapshot();
    emitChange();
  };

  async function refreshHubSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const repo = snapshot.hubRepo;
    const loadKey = `${root}::${repo ? hubRepoKey(repo) : "none"}`;
    const legalworkSnapshot = getLegalworkServerSnapshot();
    const legalworkClient = legalworkSnapshot.legalworkServerClient;
    const canUseLegalworkServer =
      legalworkSnapshot.legalworkServerStatus === "connected" &&
      legalworkClient &&
      legalworkSnapshot.legalworkServerCapabilities?.hub?.skills?.read;

    if (loadKey !== hubSkillsLoadKey) {
      hubSkillsLoaded = false;
    }

    if (!optionsOverride?.force && hubSkillsLoaded) return;
    if (refreshHubSkillsInFlight) return;

    refreshHubSkillsInFlight = true;
    refreshHubSkillsAborted = false;

    try {
      setStateField("hubSkillsStatus", null);

      if (!repo) {
        mutateState((current) => ({
          ...current,
          hubSkills: [],
          hubSkillsStatus: "No hub repo selected. Add a GitHub repo to browse skills.",
        }));
        hubSkillsLoaded = true;
        hubSkillsLoadKey = loadKey;
        return;
      }

      if (canUseLegalworkServer) {
        const response = await legalworkClient.listHubSkills({
          repo: {
            owner: repo.owner,
            repo: repo.repo,
            ref: repo.ref,
          },
        });
        if (refreshHubSkillsAborted) return;
        const next: HubSkillCard[] = Array.isArray(response?.items)
          ? response.items.map((entry) => ({
              name: String(entry.name ?? ""),
              description: typeof entry.description === "string" ? entry.description : undefined,
              trigger: typeof entry.trigger === "string" ? entry.trigger : undefined,
              source: entry.source,
            }))
          : [];
        mutateState((current) => ({
          ...current,
          hubSkills: next,
          hubSkillsStatus: next.length ? null : "No hub skills found.",
          hubSkillsContextKey: getWorkspaceContextKey(),
        }));
        hubSkillsLoaded = true;
        hubSkillsLoadKey = loadKey;
        return;
      }

      const listingRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/skills?ref=${encodeURIComponent(repo.ref)}`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!listingRes.ok) {
        throw new Error(`Failed to fetch hub catalog (${listingRes.status})`);
      }
      const listing = (await listingRes.json()) as unknown;
      const dirs: string[] = Array.isArray(listing)
        ? listing.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || (entry as { type?: string }).type !== "dir") return [];
            const name = String((entry as { name?: string }).name ?? "");
            return name ? [name] : [];
          })
        : [];

      const next: HubSkillCard[] = dirs.map((dirName) => ({
        name: dirName,
        source: { owner: repo.owner, repo: repo.repo, ref: repo.ref, path: `skills/${dirName}` },
      }));

      if (refreshHubSkillsAborted) return;
      const sorted = next.toSorted((a, b) => a.name.localeCompare(b.name));
      mutateState((current) => ({
        ...current,
        hubSkills: sorted,
        hubSkillsStatus: sorted.length ? null : "No hub skills found.",
        hubSkillsContextKey: getWorkspaceContextKey(),
      }));
      hubSkillsLoaded = true;
      hubSkillsLoadKey = loadKey;
    } catch (error) {
      if (refreshHubSkillsAborted) return;
      mutateState((current) => ({
        ...current,
        hubSkills: [],
        hubSkillsStatus: error instanceof Error ? error.message : "Failed to load hub skills.",
      }));
    } finally {
      refreshHubSkillsInFlight = false;
    }
  }

  async function previewClaudePlugin(url: string): Promise<LegalworkClaudePluginPreview> {
    const target = await resolveWorkspaceServerTarget();
    if (!target.legalworkClient || !target.legalworkWorkspaceId) {
      throw new Error("LegalWork server unavailable. Connect to install plugins from GitHub.");
    }
    const result = await target.legalworkClient.previewClaudePlugin(target.legalworkWorkspaceId, { url });
    return result.preview;
  }

  async function installClaudePlugin(url: string): Promise<{ ok: boolean; message: string }> {
    options.setBusy(true);
    options.setError(null);
    try {
      const target = await resolveWorkspaceServerTarget();
      if (!target.legalworkClient || !target.legalworkWorkspaceId) {
        throw new Error("LegalWork server unavailable. Connect to install plugins from GitHub.");
      }
      const result = await target.legalworkClient.installClaudePlugin(target.legalworkWorkspaceId, { url });
      await refreshSkills({ force: true });
      return {
        ok: true,
        message: `Installed ${result.item.name} with ${result.item.files.length} component${result.item.files.length === 1 ? "" : "s"}.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function installHubSkill(name: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "Skill name is required." };
    const repo = snapshot.hubRepo;
    if (!repo) return { ok: false, message: "Select a hub repo before installing skills." };

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.hub?.skills?.install !== false;

    if (!canUseLegalworkServer) {
      if (isRemoteWorkspace) return { ok: false, message: "LegalWork server unavailable. Connect to install skills." };
      return { ok: false, message: "Hub install requires LegalWork server." };
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);

    try {
      const repoOverride: LegalworkHubRepo = { owner: repo.owner, repo: repo.repo, ref: repo.ref };
      if (!legalworkClient || !legalworkWorkspaceId) return { ok: false, message: "Hub install requires LegalWork server." };
      const result = await legalworkClient.installHubSkill(legalworkWorkspaceId, trimmed, { repo: repoOverride });
      await Promise.all([refreshSkills({ force: true }), refreshHubSkills({ force: true })]);
      if (!result?.ok) return { ok: false, message: "Install failed." };
      return { ok: true, message: `Installed ${trimmed}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function scanGithubSkills(url: string, ref?: string): Promise<{ ref: string; skills: GithubSkillItem[] }> {
    const { legalworkClient, legalworkWorkspaceId } = await resolveWorkspaceServerTarget();
    if (!legalworkClient || !legalworkWorkspaceId) {
      throw new Error("LegalWork server unavailable. Connect to import from GitHub.");
    }
    return legalworkClient.scanGithubSkills(legalworkWorkspaceId, {
      url: url.trim(),
      ...(ref?.trim() ? { ref: ref.trim() } : {}),
    });
  }

  async function importGithubSkills(input: {
    url: string;
    ref?: string;
    paths: string[];
    asWorkflow?: boolean;
  }): Promise<{ ok: boolean; message: string }> {
    const { legalworkClient, legalworkWorkspaceId } = await resolveWorkspaceServerTarget();
    if (!legalworkClient || !legalworkWorkspaceId) {
      return { ok: false, message: "LegalWork server unavailable. Connect to import from GitHub." };
    }
    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      // Server downloads + rewrites the SKILL.md content but does NOT write it —
      // we write each here, so it lands where the list actually reads: the global
      // skills dir on desktop (same as createSkill), or the project for remote.
      const resolved = await legalworkClient.installGithubSkills(legalworkWorkspaceId, {
        url: input.url.trim(),
        ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
        paths: input.paths,
        ...(input.asWorkflow ? { asWorkflow: true } : {}),
      });
      const desktop = isDesktopRuntime();
      let installed = 0;
      let skipped = 0;
      const writeFailed: string[] = [];
      for (const skill of resolved.skills) {
        try {
          if (desktop) {
            // Writes the whole folder — SKILL.md + supporting files (references, etc.).
            const r = (await installSkillFiles("", skill.name, skill.files, { overwrite: false })) as { ok: boolean };
            if (r?.ok) installed += 1;
            else skipped += 1; // already exists (overwrite=false)
          } else {
            // Remote workspaces take a single SKILL.md via the server (supporting
            // files aren't supported on that path).
            const md = skill.files.find((file) => file.path === "SKILL.md");
            if (md) {
              await legalworkClient.upsertSkill(legalworkWorkspaceId, { name: skill.name, content: base64ToUtf8(md.contentBase64) });
              installed += 1;
            } else {
              writeFailed.push(skill.name);
            }
          }
        } catch {
          writeFailed.push(skill.name);
        }
      }
      if (installed > 0) {
        options.markReloadRequired?.("skills", { type: "skill", name: resolved.skills[0]!.name, action: "added" });
        await refreshSkills({ force: true });
      }
      const failedCount = resolved.failed.length + writeFailed.length;
      const parts: string[] = [];
      if (installed) parts.push(`Imported ${installed}`);
      if (skipped) parts.push(`${skipped} already installed`);
      if (failedCount) parts.push(`${failedCount} failed`);
      return {
        ok: installed > 0,
        message: parts.length ? `${parts.join(", ")}.` : "Nothing to import.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(snapshot.pluginList.map((entry) => entry.name), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    const nextPluginNames: string[] = [];
    let nextPluginStatus: string | null = null;
    loadPluginsFromConfigHelpers(
      config,
      (value) => {
        nextPluginNames.splice(0, nextPluginNames.length, ...applyStateAction(nextPluginNames, value));
      },
      (message) => {
        nextPluginStatus = message;
      },
    );
    mutateState((current) => ({
      ...current,
      pluginList: toConfigPluginListEntries(nextPluginNames),
      pluginStatus: nextPluginStatus,
    }));
  };

  async function refreshSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skills?.read !== false;

    // Desktop: skills are GLOBAL — list from the shared skills dir (empty projectDir) so
    // the same set shows in every workspace, with no workspace selection required.
    if (isDesktopRuntime() && options.workspaceType() !== "remote") {
      if (skillsRoot !== "__global__") skillsLoaded = false;
      if (!optionsOverride?.force && skillsLoaded) return;
      if (refreshSkillsInFlight) return;
      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;
      try {
        setStateField("skillsStatus", null);
        const local = await listLocalSkills("");
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(local)
          ? local.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
              kind: (entry as { kind?: string }).kind,
              workflowType: (entry as { workflowType?: string }).workflowType,
            }))
          : [];
        mutateState((current) => ({
          ...current,
          skills: next,
          skillsStatus: next.length ? null : t("skills.no_skills_found"),
          skillsContextKey: getWorkspaceContextKey(),
        }));
        skillsLoaded = true;
        skillsRoot = "__global__";
      } catch (error) {
        if (refreshSkillsAborted) return;
        mutateState((current) => ({
          ...current,
          skills: [],
          skillsStatus: error instanceof Error ? error.message : t("skills.failed_to_load"),
        }));
      } finally {
        refreshSkillsInFlight = false;
      }
      return;
    }

    if (!root && !hasLegalworkTarget) {
      mutateState((current) => ({
        ...current,
        skills: [],
        skillsStatus: t("skills.pick_workspace_first"),
      }));
      return;
    }

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      const skillCacheKey = root || legalworkWorkspaceId;
      if (skillCacheKey !== skillsRoot) skillsLoaded = false;
      if (!optionsOverride?.force && skillsLoaded) return;
      if (refreshSkillsInFlight) return;

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;
      try {
        setStateField("skillsStatus", null);
        const response = await legalworkClient.listSkills(legalworkWorkspaceId, { includeGlobal: isLocalWorkspace });
        if (refreshSkillsAborted) return;
        let next: SkillCard[] = Array.isArray(response.items)
          ? response.items.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
              kind: (entry as { kind?: string }).kind,
              workflowType: (entry as { workflowType?: string }).workflowType,
            }))
          : [];
        // The legalwork list doesn't surface SKILL.md frontmatter `kind`/`workflow_type`,
        // so on desktop we enrich from the local files (which do) — that's how workflows
        // stay distinguishable from skills without a name prefix.
        if (isDesktopRuntime() && root) {
          try {
            const localMeta = await listLocalSkills(root);
            if (!refreshSkillsAborted && Array.isArray(localMeta)) {
              const byName = new Map(localMeta.map((s) => [s.name, s as { kind?: string; workflowType?: string }]));
              next = next.map((card) => {
                const meta = byName.get(card.name);
                return meta ? { ...card, kind: meta.kind ?? card.kind, workflowType: meta.workflowType ?? card.workflowType } : card;
              });
            }
          } catch {
            // best-effort enrichment; fall back to whatever the list returned
          }
        }
        mutateState((current) => ({
          ...current,
          skills: next,
          skillsStatus: next.length ? null : t("skills.no_skills_found"),
          skillsContextKey: getWorkspaceContextKey(),
        }));
        skillsLoaded = true;
        skillsRoot = skillCacheKey;
      } catch (error) {
        if (refreshSkillsAborted) return;
        mutateState((current) => ({
          ...current,
          skills: [],
          skillsStatus: error instanceof Error ? error.message : t("skills.failed_to_load"),
        }));
      } finally {
        refreshSkillsInFlight = false;
      }
      return;
    }

    if (hasLegalworkTarget) {
      mutateState((current) => ({
        ...current,
        skills: [],
        skillsStatus: "LegalWork server cannot read skills for this workspace.",
      }));
      return;
    }

    if (isLocalWorkspace && isDesktopRuntime()) {
      if (root !== skillsRoot) skillsLoaded = false;
      if (!optionsOverride?.force && skillsLoaded) return;
      if (refreshSkillsInFlight) return;

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;
      try {
        setStateField("skillsStatus", null);
        const local = await listLocalSkills(root);
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(local)
          ? local.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
              kind: (entry as { kind?: string }).kind,
              workflowType: (entry as { workflowType?: string }).workflowType,
            }))
          : [];
        mutateState((current) => ({
          ...current,
          skills: next,
          skillsStatus: next.length ? null : t("skills.no_skills_found"),
          skillsContextKey: getWorkspaceContextKey(),
        }));
        skillsLoaded = true;
        skillsRoot = root;
      } catch (error) {
        if (refreshSkillsAborted) return;
        mutateState((current) => ({
          ...current,
          skills: [],
          skillsStatus: error instanceof Error ? error.message : t("skills.failed_to_load"),
        }));
      } finally {
        refreshSkillsInFlight = false;
      }
      return;
    }

    const client = options.client();
    if (!client) {
      mutateState((current) => ({
        ...current,
        skills: [],
        skillsStatus: "LegalWork server unavailable. Connect to load skills.",
      }));
      return;
    }

    if (root !== skillsRoot) skillsLoaded = false;
    if (!optionsOverride?.force && skillsLoaded) return;
    if (refreshSkillsInFlight) return;

    refreshSkillsInFlight = true;
    refreshSkillsAborted = false;
    try {
      setStateField("skillsStatus", null);
      const rawClient = client as unknown as { _client?: { get: (input: { url: string }) => Promise<unknown> } };
      if (!rawClient._client) throw new Error("OpenCode client unavailable.");
      const result = await rawClient._client.get({ url: "/skill" }) as {
        data?: Array<{ name: string; description: string; location: string }>;
        error?: unknown;
      };
      if (result?.data === undefined) {
        const err = result?.error;
        const message = err instanceof Error ? err.message : typeof err === "string" ? err : t("skills.failed_to_load");
        throw new Error(message);
      }
      if (refreshSkillsAborted) return;
      const next: SkillCard[] = Array.isArray(result.data)
        ? result.data.map((entry) => ({
            name: entry.name,
            description: entry.description,
            path: formatSkillPath(entry.location),
          }))
        : [];
      mutateState((current) => ({
        ...current,
        skills: next,
        skillsStatus: next.length ? null : t("skills.no_skills_found"),
        skillsContextKey: getWorkspaceContextKey(),
      }));
      skillsLoaded = true;
      skillsRoot = root;
    } catch (error) {
      if (refreshSkillsAborted) return;
      mutateState((current) => ({
        ...current,
        skills: [],
        skillsStatus: error instanceof Error ? error.message : t("skills.failed_to_load"),
      }));
    } finally {
      refreshSkillsInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Attached files — files in a skill's own resources/ folder
  // (.opencode/skills/<name>/resources/). Served by the LegalWork server only;
  // there is no desktop-local fallback because the agent reads the files from
  // the workspace directly. The state always holds the resources of the skill
  // most recently passed to refreshSkillResources (the one open in the editor).
  // ---------------------------------------------------------------------------

  const resolveSkillResourcesTarget = async () => {
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUse =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skillResources?.read !== false &&
      Boolean(legalworkClient && legalworkWorkspaceId);
    return { legalworkClient, legalworkWorkspaceId, canUse };
  };

  async function refreshSkillResources(skillName: string) {
    const skill = skillName.trim();
    if (!skill) return;
    const { legalworkClient, legalworkWorkspaceId, canUse } = await resolveSkillResourcesTarget();
    if (!canUse || !legalworkClient || !legalworkWorkspaceId) {
      mutateState((current) => ({
        ...current,
        skillResources: [],
        skillResourcesStatus: t("skill_resources.unavailable"),
      }));
      return;
    }
    try {
      const response = await legalworkClient.listSkillResources(legalworkWorkspaceId, skill);
      const next: SkillResourceCard[] = Array.isArray(response.items)
        ? response.items.map((item) => ({
            name: item.name,
            path: item.path,
            size: item.size,
            updatedAt: item.updatedAt,
          }))
        : [];
      mutateState((current) => ({ ...current, skillResources: next, skillResourcesStatus: null }));
    } catch (error) {
      mutateState((current) => ({
        ...current,
        skillResources: [],
        skillResourcesStatus: error instanceof Error ? error.message : t("skill_resources.load_failed"),
      }));
    }
  }

  async function readSkillResource(
    skillName: string,
    fileName: string,
  ): Promise<{ name: string; path: string; content: string } | null> {
    const skill = skillName.trim();
    const name = fileName.trim();
    if (!skill || !name) return null;
    const { legalworkClient, legalworkWorkspaceId, canUse } = await resolveSkillResourcesTarget();
    if (!canUse || !legalworkClient || !legalworkWorkspaceId) {
      setStateField("skillResourcesStatus", t("skill_resources.unavailable"));
      return null;
    }
    try {
      const result = await legalworkClient.getSkillResource(legalworkWorkspaceId, skill, name);
      return { name: result.item.name, path: result.item.path, content: result.content };
    } catch (error) {
      setStateField(
        "skillResourcesStatus",
        error instanceof Error ? error.message : t("skill_resources.load_failed"),
      );
      return null;
    }
  }

  async function saveSkillResource(
    skillName: string,
    input: { name: string; content?: string; contentBase64?: string },
  ): Promise<{ ok: boolean; message: string }> {
    const skill = skillName.trim();
    const name = input.name.trim();
    if (!skill || !name) return { ok: false, message: t("skill_resources.save_failed") };
    const { legalworkClient, legalworkWorkspaceId, canUse } = await resolveSkillResourcesTarget();
    if (!canUse || !legalworkClient || !legalworkWorkspaceId) {
      return { ok: false, message: t("skill_resources.unavailable") };
    }
    options.setBusy(true);
    options.setError(null);
    try {
      const result = await legalworkClient.upsertSkillResource(legalworkWorkspaceId, skill, {
        name,
        ...(typeof input.contentBase64 === "string"
          ? { contentBase64: input.contentBase64 }
          : { content: input.content ?? "" }),
      });
      await refreshSkillResources(skill);
      return {
        ok: true,
        message: result.action === "added" ? t("skill_resources.added") : t("skill_resources.updated"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      setStateField("skillResourcesStatus", message);
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function deleteSkillResource(skillName: string, fileName: string): Promise<{ ok: boolean; message: string }> {
    const skill = skillName.trim();
    const name = fileName.trim();
    if (!skill || !name) return { ok: false, message: t("skill_resources.save_failed") };
    const { legalworkClient, legalworkWorkspaceId, canUse } = await resolveSkillResourcesTarget();
    if (!canUse || !legalworkClient || !legalworkWorkspaceId) {
      return { ok: false, message: t("skill_resources.unavailable") };
    }
    options.setBusy(true);
    options.setError(null);
    try {
      await legalworkClient.deleteSkillResource(legalworkWorkspaceId, skill, name);
      await refreshSkillResources(skill);
      return { ok: true, message: t("skill_resources.removed") };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      setStateField("skillResourcesStatus", message);
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  // Export a skill/workflow folder (SKILL.md + resources/) as one zip to a
  // user-picked location. Desktop-only: the folder lives on this machine and
  // the save dialog is native.
  async function exportSkillZip(skillName: string): Promise<{ ok: boolean; message: string }> {
    const name = skillName.trim();
    if (!name) return { ok: false, message: t("skill_export.failed") };
    if (!isDesktopRuntime()) return { ok: false, message: t("skill_export.desktop_only") };
    const target = await saveFile({
      title: t("skill_export.dialog_title"),
      defaultPath: `${name}.zip`,
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!target) return { ok: true, message: "" }; // user cancelled the dialog
    try {
      const result = (await exportSkillZipCommand("", name, target)) as {
        ok: boolean;
        stdout?: string;
        stderr?: string;
      };
      if (!result.ok) return { ok: false, message: result.stderr || t("skill_export.failed") };
      return { ok: true, message: t("skill_export.done", { name }) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : t("skill_export.failed") };
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.plugins?.read !== false;

    if (refreshPluginsInFlight) return;
    refreshPluginsInFlight = true;
    refreshPluginsAborted = false;

    const scope = scopeOverride ?? snapshot.pluginScope;
    const targetDir = options.projectDir().trim();

    if (scope !== "project" && !isLocalWorkspace) {
      mutateState((current) => ({
        ...current,
        pluginStatus: "Global plugins are only available for local workers.",
        pluginList: [],
        sidebarPluginStatus: "Global plugins require a local worker.",
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      mutateState((current) => ({
        ...current,
        pluginConfig: null,
        pluginConfigPath: `opencode.json (${isRemoteWorkspace ? "remote" : "legalwork"} server)`,
      }));

      try {
        mutateState((current) => ({ ...current, pluginStatus: null, sidebarPluginStatus: null }));
        if (refreshPluginsAborted) return;
        const result = await legalworkClient.listPlugins(legalworkWorkspaceId, { includeGlobal: false });
        if (refreshPluginsAborted) return;
        const projectItems = result.items.filter((item) => item.scope === "project");
        const list = toProjectPluginListEntries(projectItems);
        mutateState((current) => ({
          ...current,
          pluginList: list,
          sidebarPluginList: list.map((entry) => entry.name),
          pluginStatus: list.length ? null : "No plugins configured yet.",
          sidebarPluginStatus: null,
          pluginsContextKey: getWorkspaceContextKey(),
        }));
      } catch (error) {
        if (refreshPluginsAborted) return;
        mutateState((current) => ({
          ...current,
          pluginList: [],
          sidebarPluginList: [],
          sidebarPluginStatus: "Failed to load plugins.",
          pluginStatus: error instanceof Error ? error.message : "Failed to load plugins.",
        }));
      } finally {
        refreshPluginsInFlight = false;
      }
      return;
    }

    if (scope === "project" && hasLegalworkTarget) {
      mutateState((current) => ({
        ...current,
        pluginStatus: "LegalWork server cannot read plugins for this workspace.",
        pluginList: [],
        sidebarPluginStatus: "LegalWork server cannot read plugins for this workspace.",
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    if (!isDesktopRuntime()) {
      mutateState((current) => ({
        ...current,
        pluginStatus: t("skills.plugin_management_host_only"),
        pluginList: [],
        sidebarPluginStatus: t("skills.plugins_host_only"),
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    if (!isLocalWorkspace && !canUseLegalworkServer) {
      mutateState((current) => ({
        ...current,
        pluginStatus: "LegalWork server unavailable. Connect to manage plugins.",
        pluginList: [],
        sidebarPluginStatus: "Connect a LegalWork server to load plugins.",
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && !targetDir) {
      mutateState((current) => ({
        ...current,
        pluginStatus: t("skills.pick_project_for_plugins"),
        pluginList: [],
        sidebarPluginStatus: t("skills.pick_project_for_active"),
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    try {
      mutateState((current) => ({ ...current, pluginStatus: null, sidebarPluginStatus: null }));
      if (refreshPluginsAborted) return;
      const config = (await readOpencodeConfig(scope, targetDir)) as OpencodeConfigFile;
      if (refreshPluginsAborted) return;
      mutateState((current) => ({ ...current, pluginConfig: (config as OpencodeConfigFile | null), pluginConfigPath: config.path ?? null }));

      if (!config.exists) {
        mutateState((current) => ({
          ...current,
          pluginList: [],
          pluginStatus: t("skills.no_opencode_found"),
          sidebarPluginList: [],
          sidebarPluginStatus: t("skills.no_opencode_workspace"),
        }));
        return;
      }

      let nextSidebarPluginList: string[] = [];
      let nextSidebarPluginStatus: string | null = null;
      try {
        nextSidebarPluginList = parsePluginListFromContent(config.content ?? "");
      } catch {
        nextSidebarPluginList = [];
        nextSidebarPluginStatus = t("skills.failed_parse_opencode");
      }

      const nextPluginNames: string[] = [];
      let nextPluginStatus: string | null = null;
      loadPluginsFromConfigHelpers(
        config as never,
        (value) => {
          nextPluginNames.splice(0, nextPluginNames.length, ...applyStateAction(nextPluginNames, value));
        },
        (message) => {
          nextPluginStatus = message;
        },
      );

      mutateState((current) => ({
        ...current,
        pluginList: toConfigPluginListEntries(nextPluginNames),
        pluginStatus: nextPluginStatus,
        sidebarPluginList: nextSidebarPluginList,
        sidebarPluginStatus: nextSidebarPluginStatus,
        pluginsContextKey: getWorkspaceContextKey(),
      }));
    } catch (error) {
      if (refreshPluginsAborted) return;
      mutateState((current) => ({
        ...current,
        pluginConfig: null,
        pluginConfigPath: null,
        pluginList: [],
        pluginStatus: error instanceof Error ? error.message : t("skills.failed_load_opencode"),
        sidebarPluginStatus: t("skills.failed_load_active"),
        sidebarPluginList: [],
      }));
    } finally {
      refreshPluginsInFlight = false;
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    const pluginName = (pluginNameOverride ?? snapshot.pluginInput).trim();
    const isManualInput = pluginNameOverride == null;
    const triggerName = stripPluginVersion(pluginName);

    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.plugins?.write !== false;

    if (!pluginName) {
      if (isManualInput) setStateField("pluginStatus", t("skills.enter_plugin_name"));
      return;
    }

    if (snapshot.pluginScope !== "project" && !isLocalWorkspace) {
      setStateField("pluginStatus", "Global plugins are only available for local workers.");
      return;
    }

    if (snapshot.pluginScope === "project" && canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      try {
        setStateField("pluginStatus", null);
        await legalworkClient.addPlugin(legalworkWorkspaceId, pluginName);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) setStateField("pluginInput", "");
        await refreshPlugins("project");
      } catch (error) {
        setStateField("pluginStatus", error instanceof Error ? error.message : "Failed to add plugin.");
      }
      return;
    }

    if (snapshot.pluginScope === "project" && hasLegalworkTarget) {
      setStateField("pluginStatus", "LegalWork server cannot write plugins for this workspace.");
      return;
    }

    if (!isDesktopRuntime()) {
      setStateField("pluginStatus", t("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace) {
      setStateField("pluginStatus", "LegalWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = snapshot.pluginScope;
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setStateField("pluginStatus", t("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setStateField("pluginStatus", null);
      const config = (await readOpencodeConfig(scope, targetDir)) as OpencodeConfigFile;
      const raw = config.content ?? "";

      if (!raw.trim()) {
        const payload = { $schema: "https://opencode.ai/config.json", plugin: [pluginName] };
        await writeOpencodeConfig(scope, targetDir, `${JSON.stringify(payload, null, 2)}\n`);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) setStateField("pluginInput", "");
        await refreshPlugins(scope);
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setStateField("pluginStatus", t("skills.plugin_already_listed"));
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
      const updated = applyEdits(raw, edits);
      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
      if (isManualInput) setStateField("pluginInput", "");
      await refreshPlugins(scope);
    } catch (error) {
      setStateField("pluginStatus", error instanceof Error ? error.message : t("skills.failed_update_opencode"));
    }
  }

  async function removePlugin(pluginName: string) {
    const name = pluginName.trim();
    if (!name) return;
    const triggerName = stripPluginVersion(name);
    const existingPlugin = snapshot.pluginList.find((entry) => entry.name === name);
    if (existingPlugin && !existingPlugin.removable) {
      setStateField("pluginStatus", "Directory-discovered plugins are read-only.");
      return;
    }

    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.plugins?.write !== false;

    if (snapshot.pluginScope !== "project" && !isLocalWorkspace) {
      setStateField("pluginStatus", "Global plugins are only available for local workers.");
      return;
    }

    if (snapshot.pluginScope === "project" && canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      try {
        setStateField("pluginStatus", null);
        await legalworkClient.removePlugin(legalworkWorkspaceId, name);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
        await refreshPlugins("project");
      } catch (error) {
        setStateField("pluginStatus", error instanceof Error ? error.message : "Failed to remove plugin.");
      }
      return;
    }

    if (snapshot.pluginScope === "project" && hasLegalworkTarget) {
      setStateField("pluginStatus", "LegalWork server cannot write plugins for this workspace.");
      return;
    }

    if (!isDesktopRuntime()) {
      setStateField("pluginStatus", t("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace) {
      setStateField("pluginStatus", "LegalWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = snapshot.pluginScope;
    const targetDir = options.projectDir().trim();
    if (scope === "project" && !targetDir) {
      setStateField("pluginStatus", t("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setStateField("pluginStatus", null);
      const config = (await readOpencodeConfig(scope, targetDir)) as OpencodeConfigFile;
      const raw = config.content ?? "";
      if (!raw.trim()) {
        setStateField("pluginStatus", "No plugins configured yet.");
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(name).toLowerCase();
      const next = plugins.filter((entry) => stripPluginVersion(entry).toLowerCase() !== desired);
      if (next.length === plugins.length) {
        setStateField("pluginStatus", "Plugin not found.");
        return;
      }

      const edits = modify(raw, ["plugin"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
      const updated = applyEdits(raw, edits);
      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
      await refreshPlugins(scope);
    } catch (error) {
      setStateField("pluginStatus", error instanceof Error ? error.message : t("skills.failed_update_opencode"));
    }
  }

  async function importLocalSkill(opts?: { asWorkflow?: boolean }) {
    if (!isDesktopRuntime()) {
      options.setError(t("skills.desktop_required"));
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      const selection = await pickDirectory({ title: t("skills.select_skill_folder") });
      const sourceDir = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!sourceDir) return;
      const inferredName = sourceDir.split(/[\\/]/).filter(Boolean).pop();
      // Desktop skills are GLOBAL — copy into the shared skills dir ("" projectDir),
      // the same place the list reads, so the import shows up immediately. The whole
      // folder is copied recursively, so supporting files come along. For a workflow
      // import, copy straight under the `workflow-` prefix the Workflows view detects
      // (so siblings are preserved) and rewrite only the SKILL.md name to match.
      const targetName =
        opts?.asWorkflow && inferredName && !inferredName.startsWith("workflow-")
          ? `workflow-assistant-${inferredName}`
          : inferredName;
      const renamed = Boolean(targetName && targetName !== inferredName);
      const result = (await importSkill("", sourceDir, {
        overwrite: false,
        ...(renamed ? { targetName } : {}),
      })) as {
        ok: boolean;
        stderr?: string;
        stdout?: string;
        status?: number;
      };
      if (!result.ok) {
        setStateField("skillsStatus", result.stderr || result.stdout || t("skills.import_failed").replace("{status}", String(result.status)));
      } else {
        if (renamed && targetName) {
          try {
            const read = await readLocalSkill("", targetName);
            const content = read?.content ?? "";
            const tagged = /(^|\n)name:\s*.*$/m.test(content)
              ? content.replace(/(^|\n)name:\s*.*$/m, `$1name: ${targetName}`)
              : content.replace(/^---\n/, `---\nname: ${targetName}\n`);
            if (tagged !== content) await writeLocalSkill("", targetName, tagged);
          } catch {
            // best-effort: the folder is already named as a workflow even if the
            // SKILL.md name rewrite fails (parseSkillEntry falls back to the folder).
          }
        }
        setStateField("skillsStatus", result.stdout || t("skills.imported"));
        options.markReloadRequired?.("skills", { type: "skill", name: targetName, action: "added" });
      }
      await refreshSkills({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  // Import a skill/workflow from a zip — the shape exportSkillZip produces, so
  // exported workflows round-trip. The main process detects the folder name,
  // applies the workflow- prefix, and writes into the global skills dir.
  async function importLocalSkillZip(opts?: { asWorkflow?: boolean }) {
    if (!isDesktopRuntime()) {
      options.setError(t("skills.desktop_required"));
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      const selection = await pickFile({
        title: t("skills.select_skill_zip"),
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      const archivePath = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!archivePath) return;
      const result = (await importSkillZipCommand("", archivePath, {
        overwrite: false,
        asWorkflow: opts?.asWorkflow === true,
      })) as { ok: boolean; stderr?: string; stdout?: string; status?: number };
      if (!result.ok) {
        setStateField("skillsStatus", result.stderr || result.stdout || t("skills.import_failed").replace("{status}", String(result.status)));
      } else {
        setStateField("skillsStatus", result.stdout || t("skills.imported"));
        options.markReloadRequired?.("skills", { type: "skill", name: undefined, action: "added" });
      }
      await refreshSkills({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function installSkillCreator(): Promise<{ ok: boolean; message: string }> {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skills?.write !== false;

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      options.setBusy(true);
      options.setError(null);
      setStateField("skillsStatus", t("skills.installing_skill_creator"));
      try {
        await legalworkClient.upsertSkill(legalworkWorkspaceId, { name: "skill-creator", content: skillCreatorTemplate });
        const message = t("skills.skill_creator_installed");
        setStateField("skillsStatus", message);
        options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
        await refreshSkills({ force: true });
        return { ok: true, message };
      } catch (error) {
        const raw = error instanceof Error ? error.message : t("skills.unknown_error");
        const message = addOpencodeCacheHint(raw);
        setStateField("skillsStatus", message);
        options.setError(message);
        return { ok: false, message };
      } finally {
        options.setBusy(false);
      }
    }

    if (hasLegalworkTarget) {
      const message = "LegalWork server cannot write skills for this workspace.";
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }

    if (isRemoteWorkspace) {
      const message = "LegalWork server unavailable. Connect to install skills.";
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (!isDesktopRuntime()) {
      const message = t("skills.desktop_required");
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (!isLocalWorkspace) {
      const message = "Local workers are required to install skills.";
      options.setError(message);
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }

    const targetDir = options.selectedWorkspaceRoot().trim();
    if (!targetDir) {
      const message = t("skills.pick_workspace_first");
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", t("skills.installing_skill_creator"));
    try {
      const result = (await installSkillTemplate("", "skill-creator", skillCreatorTemplate, { overwrite: false })) as { ok: boolean; stderr: string; stdout: string };
      if (!result.ok && /already exists/i.test(result.stderr)) {
        const message = t("skills.skill_creator_already_installed");
        setStateField("skillsStatus", message);
        await refreshSkills({ force: true });
        return { ok: true, message };
      }
      if (!result.ok) {
        const message = result.stderr || result.stdout || t("skills.install_failed");
        setStateField("skillsStatus", message);
        await refreshSkills({ force: true });
        return { ok: false, message };
      }
      const message = result.stdout || t("skills.skill_creator_installed");
      setStateField("skillsStatus", message);
      options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
      await refreshSkills({ force: true });
      return { ok: true, message };
    } catch (error) {
      const raw = error instanceof Error ? error.message : t("skills.unknown_error");
      const message = addOpencodeCacheHint(raw);
      setStateField("skillsStatus", message);
      options.setError(message);
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function revealSkillsFolder() {
    if (!isDesktopRuntime()) {
      setStateField("skillsStatus", t("skills.desktop_required"));
      return;
    }
    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setStateField("skillsStatus", t("skills.pick_workspace_first"));
      return;
    }

    try {
      const [opencodeSkills, claudeSkills, legacySkills] = await Promise.all([
        joinDesktopPath(root, ".opencode", "skills"),
        joinDesktopPath(root, ".claude", "skills"),
        joinDesktopPath(root, ".opencode", "skill"),
      ]);
      const tryOpen = async (target: string) => {
        try {
          await openDesktopPath(target);
          return true;
        } catch {
          return false;
        }
      };
      if (await tryOpen(opencodeSkills)) return;
      if (await tryOpen(claudeSkills)) return;
      if (await tryOpen(legacySkills)) return;
      await revealDesktopItemInDir(opencodeSkills);
    } catch (error) {
      setStateField("skillsStatus", error instanceof Error ? error.message : t("skills.reveal_failed"));
    }
  }

  async function uninstallSkill(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      await deleteWorkspaceSkill(trimmed);
      setStateField("skillsStatus", t("skills.uninstalled"));
      options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "removed" });
      await refreshSkills({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      setStateField("skillsStatus", message);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function readSkill(name: string): Promise<{ name: string; path: string; content: string } | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const root = options.selectedWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skills?.read !== false;

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      try {
        setStateField("skillsStatus", null);
        const result = await legalworkClient.getSkill(legalworkWorkspaceId, trimmed, { includeGlobal: isLocalWorkspace });
        return { name: result.item.name, path: result.item.path, content: result.content };
      } catch (error) {
        setStateField("skillsStatus", error instanceof Error ? error.message : t("skills.failed_to_load"));
        return null;
      }
    }

    if (hasLegalworkTarget) {
      setStateField("skillsStatus", "LegalWork server cannot read skills for this workspace.");
      return null;
    }

    if (!root) {
      setStateField("skillsStatus", t("skills.pick_workspace_first"));
      return null;
    }

    if (isRemoteWorkspace) {
      setStateField("skillsStatus", "LegalWork server unavailable. Connect to view skills.");
      return null;
    }
    if (!isDesktopRuntime()) {
      setStateField("skillsStatus", t("skills.desktop_required"));
      return null;
    }
    if (!isLocalWorkspace) {
      setStateField("skillsStatus", "Local workers are required to view skills.");
      return null;
    }

    try {
      setStateField("skillsStatus", null);
      const result = (await readLocalSkill("", trimmed)) as { path: string; content: string };
      return { name: trimmed, path: result.path, content: result.content };
    } catch (error) {
      setStateField("skillsStatus", error instanceof Error ? error.message : t("skills.failed_to_load"));
      return null;
    }
  }

  async function saveSkill(input: { name: string; content: string; description?: string }) {
    const trimmed = input.name.trim();
    if (!trimmed) return;
    const root = options.selectedWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skills?.write !== false;

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      options.setBusy(true);
      options.setError(null);
      setStateField("skillsStatus", null);
      try {
        await legalworkClient.upsertSkill(legalworkWorkspaceId, {
          name: trimmed,
          content: input.content,
          description: input.description,
        });
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
        await refreshSkills({ force: true });
        setStateField("skillsStatus", "Saved.");
      } catch (error) {
        const message = error instanceof Error ? error.message : t("skills.unknown_error");
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
      }
      return;
    }

    if (hasLegalworkTarget) {
      setStateField("skillsStatus", "LegalWork server cannot write skills for this workspace.");
      return;
    }

    if (!root) {
      setStateField("skillsStatus", t("skills.pick_workspace_first"));
      return;
    }

    if (isRemoteWorkspace) {
      setStateField("skillsStatus", "LegalWork server unavailable. Connect to edit skills.");
      return;
    }
    if (!isDesktopRuntime()) {
      setStateField("skillsStatus", t("skills.desktop_required"));
      return;
    }
    if (!isLocalWorkspace) {
      setStateField("skillsStatus", "Local workers are required to edit skills.");
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      const result = (await writeLocalSkill("", trimmed, input.content)) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        setStateField("skillsStatus", result.stderr || result.stdout || t("skills.unknown_error"));
      } else {
        setStateField("skillsStatus", result.stdout || "Saved.");
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
      }
      await refreshSkills({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  // Create a brand-new skill from the Skills form. Unlike saveSkill (which uses
  // writeLocalSkill and only UPDATES an existing SKILL.md), this uses
  // installSkillTemplate which mkdir's + writes a fresh .opencode/skills/<name>/SKILL.md.
  async function createSkill(input: { name: string; content: string; description?: string }): Promise<{ ok: boolean; message: string }> {
    const trimmed = input.name.trim();
    if (!trimmed) return { ok: false, message: "Skill name is required." };
    const root = options.selectedWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const { legalworkSnapshot, legalworkClient, legalworkWorkspaceId, hasLegalworkTarget } =
      await resolveWorkspaceServerTarget();
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.skills?.write !== false;

    // Desktop: skills/workflows are GLOBAL — install to the shared skills dir (empty
    // projectDir) so a new skill is immediately available in every workspace.
    if (isDesktopRuntime()) {
      options.setBusy(true);
      options.setError(null);
      setStateField("skillsStatus", null);
      try {
        const result = (await installSkillTemplate("", trimmed, input.content, { overwrite: false })) as { ok: boolean; stderr?: string; stdout?: string };
        if (!result.ok) {
          const message = result.stderr || result.stdout || t("skills.unknown_error");
          setStateField("skillsStatus", message);
          return { ok: false, message };
        }
        setStateField("skillsStatus", result.stdout || "Created.");
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "added" });
        await refreshSkills({ force: true });
        return { ok: true, message: result.stdout || "Created." };
      } catch (error) {
        const message = error instanceof Error ? error.message : t("skills.unknown_error");
        options.setError(addOpencodeCacheHint(message));
        return { ok: false, message };
      } finally {
        options.setBusy(false);
      }
    }

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      options.setBusy(true);
      options.setError(null);
      setStateField("skillsStatus", null);
      try {
        await legalworkClient.upsertSkill(legalworkWorkspaceId, {
          name: trimmed,
          content: input.content,
          description: input.description,
        });
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "added" });
        await refreshSkills({ force: true });
        setStateField("skillsStatus", "Created.");
        return { ok: true, message: "Created." };
      } catch (error) {
        const message = error instanceof Error ? error.message : t("skills.unknown_error");
        options.setError(addOpencodeCacheHint(message));
        return { ok: false, message };
      } finally {
        options.setBusy(false);
      }
    }

    if (hasLegalworkTarget) {
      const message = "LegalWork server cannot write skills for this workspace.";
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (!root) {
      const message = t("skills.pick_workspace_first");
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (isRemoteWorkspace) {
      const message = "LegalWork server unavailable. Connect to create skills.";
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (!isDesktopRuntime()) {
      const message = t("skills.desktop_required");
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (!isLocalWorkspace) {
      const message = "Local workers are required to create skills.";
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      const result = (await installSkillTemplate(root, trimmed, input.content, { overwrite: false })) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        const message = result.stderr || result.stdout || t("skills.unknown_error");
        setStateField("skillsStatus", message);
        return { ok: false, message };
      }
      setStateField("skillsStatus", result.stdout || "Created.");
      options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "added" });
      await refreshSkills({ force: true });
      return { ok: true, message: result.stdout || "Created." };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  function abortRefreshes() {
    refreshSkillsAborted = true;
    refreshPluginsAborted = true;
    refreshHubSkillsAborted = true;
  }

  function ensureSkillsFresh() {
    if (!snapshot.skillsStale) return;
    void refreshSkills({ force: true });
  }

  function ensurePluginsFresh(scopeOverride?: PluginScope) {
    if (!snapshot.pluginsStale) return;
    void refreshPlugins(scopeOverride);
  }

  function ensureHubSkillsFresh() {
    if (!snapshot.hubSkillsStale) return;
    void refreshHubSkills({ force: true });
  }

  const setHubRepo = (repoInput: Partial<HubSkillRepo> | null, optionsOverride?: { remember?: boolean }) => {
    const next = normalizeHubRepo(repoInput);
    mutateState((current) => ({ ...current, hubRepo: next }));
    hubSkillsLoaded = false;
    if (optionsOverride?.remember === false || !next) {
      persistHubRepos();
      return;
    }
    mutateState((current) => {
      const seen = new Set<string>();
      const merged = [next, ...current.hubRepos];
      const deduped: HubSkillRepo[] = [];
      for (const item of merged) {
        const key = hubRepoKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      return { ...current, hubRepos: deduped };
    });
    persistHubRepos();
  };

  const addHubRepo = (repoInput: Partial<HubSkillRepo>) => {
    const next = normalizeHubRepo(repoInput);
    if (!next) return;
    setHubRepo(next);
  };

  const removeHubRepo = (repoInput: Partial<HubSkillRepo>) => {
    const target = normalizeHubRepo(repoInput);
    if (!target) return;
    const targetKey = hubRepoKey(target);
    const nextRepos = snapshot.hubRepos.filter((item) => hubRepoKey(item) !== targetKey);
    mutateState((current) => ({ ...current, hubRepos: nextRepos }));
    const activeRepo = snapshot.hubRepo;
    if (activeRepo && hubRepoKey(activeRepo) === targetKey) {
      mutateState((current) => ({
        ...current,
        hubRepo: nextRepos[0] ?? null,
        hubSkills: nextRepos.length ? current.hubSkills : [],
        hubSkillsStatus: nextRepos.length ? current.hubSkillsStatus : "No hub repo selected. Add a GitHub repo to browse skills.",
      }));
      hubSkillsLoaded = false;
      if (!nextRepos.length) {
        hubSkillsLoadKey = "";
      }
    }
    persistHubRepos();
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;

    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(HUB_REPOS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { selected?: unknown; repos?: unknown[]; custom?: unknown[] };
          const storedRepos = Array.isArray(parsed?.repos)
            ? normalizeHubRepoList(parsed.repos)
            : Array.isArray(parsed?.custom)
              ? normalizeHubRepoList(parsed.custom)
              : [];
          const selected = parsed?.selected && typeof parsed.selected === "object"
            ? normalizeHubRepo(parsed.selected as Partial<HubSkillRepo>)
            : null;
          const selectedKey = selected ? hubRepoKey(selected) : null;
          const hasSelected = selectedKey ? storedRepos.some((item) => hubRepoKey(item) === selectedKey) : false;
          const nextRepos = selected && !hasSelected ? [selected, ...storedRepos] : storedRepos;
          mutateState((current) => ({
            ...current,
            hubRepos: nextRepos,
            hubRepo: selected && nextRepos.length ? selected : nextRepos[0] ?? null,
          }));
        }
      } catch {
        // ignore
      }

    }

    stopLegalworkSubscription = options.legalworkServer.subscribe(() => {
      syncFromOptions();
    });

    syncFromOptions();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    started = false;
    abortRefreshes();
    stopLegalworkSubscription?.();
    stopLegalworkSubscription = null;
    listeners.clear();
  };

  const syncFromOptions = () => {
    if (disposed) return;
    const key = getWorkspaceContextKey();
    if (key === lastWorkspaceContextKey) return;
    lastWorkspaceContextKey = key;
    invalidateWorkspaceCaches();
    touch();
    if (!key || key === "::::") return;
    void refreshSkills({ force: true });
    void refreshPlugins();
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    skills: () => snapshot.skills,
    skillsStatus: () => snapshot.skillsStatus,
    skillResources: () => snapshot.skillResources,
    skillResourcesStatus: () => snapshot.skillResourcesStatus,
    hubSkills: () => snapshot.hubSkills,
    hubSkillsStatus: () => snapshot.hubSkillsStatus,
    hubRepo: () => snapshot.hubRepo,
    hubRepos: () => snapshot.hubRepos,
    get pluginScope() {
      return snapshot.pluginScope;
    },
    setPluginScope(value: SetStateAction<PluginScope>) {
      const resolved = applyStateAction(state.pluginScope, value);
      setStateField("pluginScope", resolved);
    },
    pluginConfig: () => snapshot.pluginConfig,
    pluginConfigPath: () => snapshot.pluginConfigPath,
    pluginList: () => snapshot.pluginList,
    pluginInput: () => snapshot.pluginInput,
    setPluginInput(value: SetStateAction<string>) {
      const resolved = applyStateAction(state.pluginInput, value);
      setStateField("pluginInput", resolved);
    },
    pluginStatus: () => snapshot.pluginStatus,
    activePluginGuide: () => snapshot.activePluginGuide,
    setActivePluginGuide(value: SetStateAction<string | null>) {
      const resolved = applyStateAction(state.activePluginGuide, value);
      setStateField("activePluginGuide", resolved);
    },
    sidebarPluginList: () => snapshot.sidebarPluginList,
    sidebarPluginStatus: () => snapshot.sidebarPluginStatus,
    workspaceContextKey: () => snapshot.workspaceContextKey,
    skillsStale: () => snapshot.skillsStale,
    pluginsStale: () => snapshot.pluginsStale,
    hubSkillsStale: () => snapshot.hubSkillsStale,
    isPluginInstalledByName,
    refreshSkills,
    refreshHubSkills,
    setHubRepo,
    addHubRepo,
    removeHubRepo,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    importLocalSkillZip,
    scanGithubSkills,
    importGithubSkills,
    installSkillCreator,
    installHubSkill,
    previewClaudePlugin,
    installClaudePlugin,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    createSkill,
    exportSkillZip,
    refreshSkillResources,
    readSkillResource,
    saveSkillResource,
    deleteSkillResource,
    abortRefreshes,
    ensureSkillsFresh,
    ensurePluginsFresh,
    ensureHubSkillsFresh,
  };
}

export function useExtensionsStoreSnapshot(store: ExtensionsStore) {
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
