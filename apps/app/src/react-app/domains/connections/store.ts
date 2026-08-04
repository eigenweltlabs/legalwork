import { useSyncExternalStore } from "react";

import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

import { t } from "../../../i18n";
import {
  getMcpServerName,
  MCP_QUICK_CONNECT,
  type McpDirectoryInfo,
} from "../../../app/constants";
import { extensionResource } from "../../../app/extensions";
import { captureAnalyticsEvent } from "../../../app/lib/analytics";
import { captureAppError } from "../../../app/lib/app-error";
import { createClient, unwrap } from "../../../app/lib/opencode";
import { finishPerf, perfNow, recordPerfLog } from "../../../app/lib/perf-log";
import {
  mergeRuntimeMcpServer,
  readOpencodeConfig,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../../../app/lib/desktop";
import { toSessionTransportDirectory } from "../../../app/lib/session-scope";
import {
  parseMcpServersFromContent,
  removeMcpFromConfig,
  validateMcpServerName,
} from "../../../app/mcp";
import { buildLegalworkWorkspaceBaseUrl } from "../../../app/lib/legalwork-server";
import type {
  Client,
  McpServerEntry,
  McpStatusMap,
  ReloadReason,
  ReloadTrigger,
} from "../../../app/types";
import { isDesktopRuntime, normalizeDirectoryPath, safeStringify } from "../../../app/utils";

import type { LegalworkServerStore } from "./legalwork-server-store";

type SetStateAction<T> = T | ((current: T) => T);

export type ConnectionsStoreSnapshot = {
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  mcpAuthModalOpen: boolean;
  mcpAuthEntry: McpDirectoryInfo | null;
  mcpAuthNeedsReload: boolean;
};

type MutableState = ConnectionsStoreSnapshot;

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;

export function createConnectionsStore(options: {
  client: () => Client | null;
  setClient: (value: Client | null) => void;
  projectDir: () => string;
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  legalworkServer: LegalworkServerStore;
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  setProjectDir?: (value: string) => void;
  developerMode: () => boolean;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const listeners = new Set<() => void>();

  let started = false;
  let disposed = false;
  let lastWorkspaceContextKey = "";
  let lastProjectDir = "";
  let snapshot: ConnectionsStoreSnapshot;

  let state: MutableState = {
    mcpServers: [],
    mcpStatus: null,
    mcpLastUpdatedAt: null,
    mcpStatuses: {},
    mcpConnectingName: null,
    selectedMcp: null,
    mcpAuthModalOpen: false,
    mcpAuthEntry: null,
    mcpAuthNeedsReload: false,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const refreshSnapshot = () => {
    snapshot = {
      mcpServers: state.mcpServers,
      mcpStatus: state.mcpStatus,
      mcpLastUpdatedAt: state.mcpLastUpdatedAt,
      mcpStatuses: state.mcpStatuses,
      mcpConnectingName: state.mcpConnectingName,
      selectedMcp: state.selectedMcp,
      mcpAuthModalOpen: state.mcpAuthModalOpen,
      mcpAuthEntry: state.mcpAuthEntry,
      mcpAuthNeedsReload: state.mcpAuthNeedsReload,
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

  const getWorkspaceContextKey = () => {
    const workspaceId = options.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(options.selectedWorkspaceRoot().trim());
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    const workspaceType = options.workspaceType();
    return `${workspaceType}:${workspaceId}:${root}:${runtimeWorkspaceId}`;
  };

  const getLegalworkSnapshot = () => options.legalworkServer.getSnapshot();

  const resolveLegalworkWorkspaceId = async () => {
    const current = options.runtimeWorkspaceId()?.trim();
    if (current) return current;
    const legalworkSnapshot = getLegalworkSnapshot();
    if (legalworkSnapshot.legalworkServerStatus !== "connected" || !legalworkSnapshot.legalworkServerClient) {
      return null;
    }
    const ensured = (await options.ensureRuntimeWorkspaceId?.())?.trim();
    if (ensured) return ensured;
    return options.workspaceType() === "local" ? options.selectedWorkspaceId().trim() || null : null;
  };

  const resolveConfigLegalworkTarget = async (mode: "read" | "write") => {
    const legalworkSnapshot = getLegalworkSnapshot();
    const legalworkClient = legalworkSnapshot.legalworkServerClient;
    const legalworkWorkspaceId = await resolveLegalworkWorkspaceId();
    const hasLegalworkTarget =
      legalworkSnapshot.legalworkServerStatus === "connected" &&
      Boolean(legalworkClient && legalworkWorkspaceId);
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.config?.[mode] !== false;
    return {
      legalworkClient,
      legalworkWorkspaceId,
      hasLegalworkTarget,
      canUseLegalworkServer,
    };
  };

  const resolveMcpLegalworkTarget = async (mode: "read" | "write") => {
    const legalworkSnapshot = getLegalworkSnapshot();
    const legalworkClient = legalworkSnapshot.legalworkServerClient;
    const legalworkWorkspaceId = await resolveLegalworkWorkspaceId();
    const hasLegalworkTarget =
      legalworkSnapshot.legalworkServerStatus === "connected" &&
      Boolean(legalworkClient && legalworkWorkspaceId);
    const canUseLegalworkServer =
      hasLegalworkTarget &&
      legalworkSnapshot.legalworkServerCapabilities?.mcp?.[mode] !== false;
    return {
      legalworkClient,
      legalworkWorkspaceId,
      hasLegalworkTarget,
      canUseLegalworkServer,
    };
  };

  const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(
      Object.entries(status).filter(([name]) => configured.has(name)),
    ) as McpStatusMap;
  };

  const readMcpConfigFile = async (scope: "project" | "global"): Promise<OpencodeConfigFile | null> => {
    const projectDir = options.projectDir().trim();
    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveConfigLegalworkTarget("read");

    if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
      return legalworkClient.readOpencodeConfigFile(legalworkWorkspaceId, scope);
    }

    if (hasLegalworkTarget) {
      return null;
    }

    if (options.workspaceType() !== "local" || !isDesktopRuntime()) {
      return null;
    }

    return readOpencodeConfig(scope, projectDir) as Promise<OpencodeConfigFile>;
  };

  const ensureActiveClient = async () => {
    let activeClient = options.client();
    if (activeClient) {
      return activeClient;
    }

    const legalworkSnapshot = getLegalworkSnapshot();
    const legalworkBaseUrl = legalworkSnapshot.legalworkServerBaseUrl.trim();
    const token = legalworkSnapshot.legalworkServerAuth.token?.trim();
    if (!legalworkBaseUrl || !token) {
      return null;
    }

    const mountedBaseUrl =
      buildLegalworkWorkspaceBaseUrl(legalworkBaseUrl, await resolveLegalworkWorkspaceId()) ?? legalworkBaseUrl;
    activeClient = createClient(`${mountedBaseUrl.replace(/\/+$/, "")}/opencode`, undefined, {
      token,
      mode: "legalwork",
    });
    options.setClient(activeClient);
    return activeClient;
  };

  const resolveWritableLegalworkTarget = async () => {
    return resolveMcpLegalworkTarget("write");
  };

  const resolveProjectDir = async (activeClient: Client | null, currentProjectDir: string) => {
    let resolvedProjectDir = currentProjectDir;
    if (!resolvedProjectDir && activeClient) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = toSessionTransportDirectory(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          options.setProjectDir?.(discovered);
        }
      } catch {
        // ignore
      }
    }

    return resolvedProjectDir;
  };

  const listMcpFromLegalworkServer = async (projectDir: string) => {
    const legalworkSnapshot = getLegalworkSnapshot();
    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveMcpLegalworkTarget("read");
    const canTryLegalworkServer = canUseLegalworkServer;

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-check", {
      workspaceType: options.workspaceType(),
      projectDir: projectDir || null,
      legalworkStatus: legalworkSnapshot.legalworkServerStatus,
      hasLegalworkClient: Boolean(legalworkClient),
      legalworkWorkspaceId: legalworkWorkspaceId ?? null,
      canReadMcp: legalworkSnapshot.legalworkServerCapabilities?.mcp?.read ?? null,
      canTryLegalworkServer,
    });

    if (hasLegalworkTarget && !canTryLegalworkServer) {
      throw new Error("LegalWork server cannot read MCP config for this workspace.");
    }

    if (!canTryLegalworkServer || !legalworkClient || !legalworkWorkspaceId) return null;

    const response = await legalworkClient.listMcp(legalworkWorkspaceId);
    const next = response.items.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
    }));
    const engineSync = response.engineSync ?? null;

    let nextStatuses: McpStatusMap = {};
    const activeClient = options.client();
    if (activeClient && projectDir) {
      try {
        const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
        nextStatuses = filterConfiguredStatuses(status as McpStatusMap, next);
      } catch {
        nextStatuses = {};
      }
    }

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-result", {
      count: next.length,
      names: next.map((entry) => entry.name),
      sources: next.map((entry) => entry.source ?? "unknown"),
      engineSyncStatus: engineSync?.status ?? null,
    });

    return { next, nextStatuses, engineSync };
  };

  const resolveDesktopCommand = async (commandName: "getComputerUseMcpCommand" | "getLegalworkUiMcpCommand", fallbackOnError = true) => {
    try {
      const command = await window.__LEGALWORK_ELECTRON__?.invokeDesktop?.(commandName);
      if (Array.isArray(command) && command.every((part) => typeof part === "string") && command.length > 0) {
        return command;
      }
    } catch (error) {
      if (!fallbackOnError) {
        throw error instanceof Error
          ? error
          : new Error("Computer Use helper app is unavailable. Restart LegalWork or reinstall the app.");
      }
      // Fall through to the published package command in the manifest/catalog.
    }
    return null;
  };

  const resolveLocalMcpCommand = async (entry: McpDirectoryInfo) => {
    const mcpResource = extensionResource(entry.extensionManifest, "mcp");
    if (mcpResource?.localCommandRef === "legalwork.computerUseMcp") {
      const command = await resolveDesktopCommand("getComputerUseMcpCommand", false);
      return command ?? entry.command;
    }
    if (mcpResource?.localCommandRef === "legalwork.uiMcp" || entry.serverName === "legalwork-ui") {
      const command = await resolveDesktopCommand("getLegalworkUiMcpCommand");
      return command ?? entry.command;
    }
    return entry.command;
  };

  const resolveLocalMcpEnvironment = async (entry: McpDirectoryInfo) => {
    if (entry.serverName !== "legalwork-ui") return undefined;
    try {
      const environment = await window.__LEGALWORK_ELECTRON__?.invokeDesktop?.("getLegalworkUiMcpEnvironment");
      if (environment && typeof environment === "object" && !Array.isArray(environment)) {
        return Object.fromEntries(
          Object.entries(environment).filter((entry): entry is [string, string] =>
            typeof entry[0] === "string" && typeof entry[1] === "string"
          ),
        );
      }
    } catch {
      // Discovery fallback in legalwork-ui-mcp still handles normal launches.
    }
    return undefined;
  };

  async function refreshMcpServers() {
    if (disposed) return;

    const projectDir = options.projectDir().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";

    // Desktop, local workspace: MCP servers are GLOBAL — read the shared opencode config
    // so the list is identical in every workspace and needs no workspace selected.
    if (isDesktopRuntime() && !isRemoteWorkspace) {
      try {
        setStateField("mcpStatus", null);
        const globalConfig = (await readOpencodeConfig("global", "")) as OpencodeConfigFile;
        const globalServers = globalConfig.exists && globalConfig.content
          ? parseMcpServersFromContent(globalConfig.content).map((entry) => ({
              ...entry,
              source: "config.global" as const,
            }))
          : [];
        const globalNames = new Set(globalServers.map((entry) => entry.name));
        const runtimeServers = state.mcpServers.filter(
          (entry) => entry.source === "config.remote" && !globalNames.has(entry.name),
        );
        const next = [...globalServers, ...runtimeServers];
        let nextStatuses = state.mcpStatuses;
        const activeClient = options.client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            nextStatuses = filterConfiguredStatuses(status as McpStatusMap, next);
          } catch {
            nextStatuses = {};
          }
        }
        mutateState((current) => ({
          ...current,
          mcpServers: next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: nextStatuses,
          mcpStatus: next.length ? null : "No MCP servers configured yet. Add one to use it in every workspace.",
        }));
        return;
      } catch (error) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
        }));
        return;
      }
    }

    try {
      setStateField("mcpStatus", null);
      const serverResult = await listMcpFromLegalworkServer(projectDir);
      if (serverResult) {
        // Surface engine registration failures instead of leaving users
        // staring at an MCP that silently shows as disconnected.
        const failedNames = serverResult.engineSync?.status === "failed"
          ? serverResult.engineSync.failures.map((failure) => failure.name).join(", ")
          : "";
        mutateState((current) => ({
          ...current,
          mcpServers: serverResult.next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: serverResult.nextStatuses,
          mcpStatus: failedNames
            ? `Some MCPs could not be registered with the engine: ${failedNames}. They may appear disconnected — try reloading the engine.`
            : serverResult.next.length ? null : "No MCP servers configured yet.",
        }));
        return;
      }
    } catch (error) {
      recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-error", {
        message: error instanceof Error ? error.message : String(error),
      });
      const serverTarget = await resolveMcpLegalworkTarget("read").catch(() => null);
      if (isRemoteWorkspace || serverTarget?.hasLegalworkTarget) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
        }));
        return;
      }
    }

    if (isRemoteWorkspace) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "LegalWork server unavailable. MCP config is read-only.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    if (!isDesktopRuntime()) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "MCP configuration is only available for local workspaces.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    if (!projectDir) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "Pick a workspace folder to load MCP servers.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    try {
      setStateField("mcpStatus", null);
      recordPerfLog(options.developerMode(), "mcp.refresh", "desktop-project-fallback", {
        projectDir,
      });
      const [globalConfig, projectConfig] = await Promise.all([
        readOpencodeConfig("global", projectDir) as Promise<OpencodeConfigFile>,
        readOpencodeConfig("project", projectDir) as Promise<OpencodeConfigFile>,
      ]);
      const globalServers = globalConfig.exists && globalConfig.content
        ? parseMcpServersFromContent(globalConfig.content).map((entry) => ({
          ...entry,
          source: "config.global" as const,
        }))
        : [];
      const projectServers = projectConfig.exists && projectConfig.content
        ? parseMcpServersFromContent(projectConfig.content)
        : [];
      const projectNames = new Set(projectServers.map((entry) => entry.name));
      const fileServers = [
        ...globalServers.filter((entry) => !projectNames.has(entry.name)),
        ...projectServers,
      ];
      // Runtime-DB MCPs (source "config.remote") only exist on the LegalWork
      // server. Keep the last-known entries instead of silently dropping them
      // while the server is briefly unreachable (startup race) — otherwise
      // enabled MCPs like legalwork-ui render as "off".
      const fileNames = new Set(fileServers.map((entry) => entry.name));
      const runtimeServers = state.mcpServers.filter(
        (entry) => entry.source === "config.remote" && !fileNames.has(entry.name),
      );
      const next = [...fileServers, ...runtimeServers];

      recordPerfLog(options.developerMode(), "mcp.refresh", "desktop-project-fallback-result", {
        globalConfigPath: globalConfig.path,
        projectConfigPath: projectConfig.path,
        count: next.length,
        names: next.map((entry) => entry.name),
        sources: next.map((entry) => entry.source ?? "unknown"),
      });

      if (!globalConfig.exists && !projectConfig.exists && runtimeServers.length === 0) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: "No opencode.json found yet. Create one by connecting an MCP.",
        }));
        return;
      }

      let nextStatuses = state.mcpStatuses;
      const activeClient = options.client();
      if (activeClient) {
        try {
          const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
          nextStatuses = filterConfiguredStatuses(status as McpStatusMap, next);
        } catch {
          nextStatuses = {};
        }
      }

      mutateState((current) => ({
        ...current,
        mcpServers: next,
        mcpLastUpdatedAt: Date.now(),
        mcpStatuses: nextStatuses,
        mcpStatus: next.length ? null : "No MCP servers configured yet.",
      }));
    } catch (error) {
      mutateState((current) => ({
        ...current,
        mcpServers: [],
        mcpStatuses: {},
        mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
      }));
    }
  }

  async function connectMcp(entry: McpDirectoryInfo): Promise<boolean> {
    const startedAt = perfNow();
    const legalworkSnapshot = getLegalworkSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && legalworkSnapshot.legalworkServerStatus === "connected");
    const projectDir = options.projectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(options.developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveWritableLegalworkTarget();

    if (isRemoteWorkspace && !canUseLegalworkServer) {
      setStateField("mcpStatus", "LegalWork server unavailable. MCP config is read-only.");
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "legalwork-server-unavailable",
      });
      return false;
    }

    if (hasLegalworkTarget && !canUseLegalworkServer) {
      setStateField("mcpStatus", "LegalWork server MCP config is read-only.");
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "legalwork-server-read-only",
      });
      return false;
    }

    if (!canUseLegalworkServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", t("mcp.desktop_required"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return false;
    }

    if (!isRemoteWorkspace && !projectDir && !canUseLegalworkServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return false;
    }

    const activeClient = canUseLegalworkServer ? options.client() ?? await ensureActiveClient().catch(() => null) : await ensureActiveClient();
    if (!activeClient && !canUseLegalworkServer) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return false;
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseLegalworkServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return false;
    }

    const slug = entry.id ?? getMcpServerName(entry);
    const action = snapshot.mcpServers.some((server) => server.name === slug) ? "updated" : "added";

    try {
      mutateState((current) => ({ ...current, mcpStatus: null, mcpConnectingName: entry.name }));

      // Resolve dynamic URLs for built-in MCPs
      let resolvedUrl = entry.url;
      // User-supplied auth headers (e.g. an Authorization: Bearer token) connect
      // header-authed servers like iManage that reject the engine's loopback OAuth.
      let resolvedHeaders: Record<string, string> | undefined =
        entry.headers && Object.keys(entry.headers).length > 0 ? entry.headers : undefined;
      if (!resolvedUrl && entry.serverName === "legalwork-ui") {
        try {
          const bridgeInfo = await window.__LEGALWORK_ELECTRON__?.invokeDesktop?.("getUiControlBridgeInfo");
          if (bridgeInfo?.baseUrl) {
            resolvedUrl = `${bridgeInfo.baseUrl}/mcp`;
            if (bridgeInfo.token) {
              resolvedHeaders = { Authorization: `Bearer ${bridgeInfo.token}` };
            }
          }
        } catch {
          // Bridge not available
        }
      }

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!resolvedUrl) {
          throw new Error("Missing MCP URL. Is the LegalWork desktop app running?");
        }
        mcpEntryConfig["url"] = resolvedUrl;
        if (resolvedHeaders) {
          mcpEntryConfig["headers"] = resolvedHeaders;
          // Header-authed entries must not trigger OAuth auto-detection;
          // otherwise opencode reports "needs_auth" despite valid headers.
          mcpEntryConfig["oauth"] = false;
        }
        if (!resolvedHeaders) {
          if (entry.oauthConfig) {
            mcpEntryConfig["oauth"] = entry.oauthConfig;
          } else if (entry.oauth) {
            mcpEntryConfig["oauth"] = {};
          }
        }
      }

      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = await resolveLocalMcpCommand(entry);
        const environment = await resolveLocalMcpEnvironment(entry);
        if (environment) {
          mcpEntryConfig["environment"] = environment;
        }
      }

      if (isDesktopRuntime()) {
        // Persist to the GLOBAL opencode config so the MCP loads in every workspace
        // (opencode reads its global config for all projects). The engine hot-add below
        // connects it immediately in the active workspace.
        const configFile = await readOpencodeConfig("global", "") as OpencodeConfigFile;

        const raw = configFile.exists && configFile.content?.trim()
          ? configFile.content
          : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

        const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
        parse(raw, parseErrors, { allowTrailingComma: true });
        if (parseErrors.length > 0) {
          const details = parseErrors
            .map((entry) => printParseErrorCode(entry.error))
            .join(", ");
          throw new Error(`Failed to parse opencode config: ${details}`);
        }

        let updated = raw;
        const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
        updated = applyEdits(
          updated,
          modify(updated, ["$schema"], "https://opencode.ai/config.json", { formattingOptions }),
        );
        updated = applyEdits(
          updated,
          modify(updated, ["mcp", slug], mcpEntryConfig, { formattingOptions }),
        );

        const writeResult = await writeOpencodeConfig(
          "global",
          "",
          updated.endsWith("\n") ? updated : `${updated}\n`,
        ) as { ok: boolean; stderr?: string; stdout?: string };
        if (!writeResult.ok) {
          throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write global opencode.json");
        }

        // The global file is not what the packaged engine reads. On a config
        // change it disposes the workspace instance and rebuilds it from the
        // runtime opencode config plus the workspace's own files — the global
        // config is not among them (verified from the engine log, which lists
        // every path an instance loads). Merging into the runtime config makes
        // the connector global: every workspace, old and new, gets it on the
        // next instance build.
        try {
          await mergeRuntimeMcpServer(slug, mcpEntryConfig);
        } catch {
          // The hot-add below still carries this session; the entry simply
          // will not survive an instance rebuild.
        }
        // And the runtime store, for setups where a LegalWork server manages
        // the engine (remote/hosted); no server client exists on plain desktop.
        if (legalworkClient && legalworkWorkspaceId) {
          try {
            await legalworkClient.addMcp(legalworkWorkspaceId, { name: slug, config: mcpEntryConfig });
          } catch {
            // The config writes above already succeeded.
          }
        }
      } else if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
        await legalworkClient.addMcp(legalworkWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        throw new Error(t("mcp.connect_server_first"));
      }

      let engineHasMcp = false;
      if (isDesktopRuntime() && activeClient && resolvedProjectDir) {
        // Hot-add to the active workspace's engine for a live connection + OAuth
        // detection. Other workspaces load the MCP from global config on next start.
        const mcpAddConfig =
          entryType === "remote"
            ? {
                type: "remote" as const,
                url: resolvedUrl ?? entry.url!,
                enabled: true,
                ...(resolvedHeaders ? { headers: resolvedHeaders, oauth: false as const } : {}),
                ...(!resolvedHeaders && entry.oauthConfig ? { oauth: entry.oauthConfig } : {}),
                ...(!resolvedHeaders && !entry.oauthConfig && entry.oauth ? { oauth: {} } : {}),
              }
            : {
                type: "local" as const,
                command: (mcpEntryConfig["command"] as string[]) ?? entry.command!,
                enabled: true,
              };

        // Registering with the running engine is what makes the server usable
        // now; the config write only matters at next start. A single silent
        // failure here used to leave the engine without the server while the
        // flow carried on into sign-in, which then failed with a raw
        // McpServerNotFoundError. So retry, and confirm the engine really has
        // it before anything downstream assumes so.
        for (let attempt = 0; attempt < 3 && !engineHasMcp; attempt += 1) {
          try {
            const status = unwrap(
              await activeClient.mcp.add({
                directory: resolvedProjectDir,
                name: slug,
                config: mcpAddConfig,
              }),
            );
            setStateField("mcpStatuses", status as McpStatusMap);
            engineHasMcp = Object.prototype.hasOwnProperty.call(status ?? {}, slug);
          } catch {
            // Transient: the engine may still be starting for this workspace.
          }
          if (!engineHasMcp) {
            try {
              const status = unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
              if (Object.prototype.hasOwnProperty.call(status ?? {}, slug)) {
                setStateField("mcpStatuses", status as McpStatusMap);
                engineHasMcp = true;
                break;
              }
            } catch {
              // Fall through to the next attempt.
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }
      } else {
        setStateField("mcpStatuses", filterConfiguredStatuses(snapshot.mcpStatuses, snapshot.mcpServers));
      }
      options.markReloadRequired?.("mcp", { type: "mcp", name: slug, action });
      await refreshMcpServers();

      // OAuth is auto-detected: open the sign-in modal when the directory
      // entry declares OAuth up front, or when the engine reports the fresh
      // remote entry as needing auth. Custom apps no longer ask the user to
      // know whether their server uses OAuth.
      let needsAuth = Boolean(entry.oauth) && !resolvedHeaders;
      if (!needsAuth && entryType === "remote" && !resolvedHeaders) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const detected = snapshot.mcpStatuses[slug]?.status;
          if (detected === "needs_auth" || detected === "needs_client_registration") {
            needsAuth = true;
            break;
          }
          if (detected === "connected" || detected === "failed" || detected === "disabled") break;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await refreshMcpServers();
        }
      }

      if (needsAuth) {
        mutateState((current) => ({
          ...current,
          mcpAuthEntry: entry,
          mcpAuthNeedsReload: !engineHasMcp,
          mcpAuthModalOpen: true,
        }));
      } else {
        setStateField("mcpStatus", t("mcp.connected"));
      }

      await refreshMcpServers();
      finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
      captureAnalyticsEvent("integration_connected", {});
      return true;
    } catch (error) {
      captureAppError("integration_connect", error);
      console.error("[mcp.connect] failed", entry.name, error);
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.connect_failed"),
      );
      finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      return false;
    } finally {
      setStateField("mcpConnectingName", null);
    }
  }

  function authorizeMcp(entry: McpServerEntry) {
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setStateField("mcpStatus", t("mcp.login_unavailable"));
      return;
    }

    const matchingQuickConnect = MCP_QUICK_CONNECT.find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    mutateState((current) => ({
      ...current,
      mcpAuthEntry:
        matchingQuickConnect ?? {
          name: entry.name,
          description: "",
          type: "remote",
          url: entry.config.url,
          oauth: true,
        },
      mcpAuthNeedsReload: false,
      mcpAuthModalOpen: true,
    }));
  }

  async function logoutMcpAuth(name: string) {
    const legalworkSnapshot = getLegalworkSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && legalworkSnapshot.legalworkServerStatus === "connected");
    const projectDir = options.projectDir().trim();

    const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
      await resolveWritableLegalworkTarget();

    if (isRemoteWorkspace && !canUseLegalworkServer) {
      setStateField("mcpStatus", "LegalWork server unavailable. MCP auth is read-only.");
      return;
    }

    if (hasLegalworkTarget && !canUseLegalworkServer) {
      setStateField("mcpStatus", "LegalWork server MCP auth is read-only.");
      return;
    }

    if (!canUseLegalworkServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", t("mcp.desktop_required"));
      return;
    }

    const activeClient = canUseLegalworkServer ? options.client() : await ensureActiveClient();
    if (!activeClient && !canUseLegalworkServer) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      return;
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseLegalworkServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      return;
    }

    const safeName = validateMcpServerName(name);
    setStateField("mcpStatus", null);

    try {
      if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
        await legalworkClient.logoutMcpAuth(legalworkWorkspaceId, safeName);
      } else {
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      try {
        if (activeClient && resolvedProjectDir) {
          const status = unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
          setStateField("mcpStatuses", status as McpStatusMap);
        }
      } catch {
        // ignore
      }

      await refreshMcpServers();
      setStateField("mcpStatus", t("mcp.logout_success").replace("{server}", safeName));
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.logout_failed"),
      );
    }
  }

  async function removeMcp(name: string) {
    try {
      setStateField("mcpStatus", null);

      const { legalworkClient, legalworkWorkspaceId, hasLegalworkTarget, canUseLegalworkServer } =
        await resolveWritableLegalworkTarget();

      if (isDesktopRuntime()) {
        const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
        // Remove from the GLOBAL opencode config (applies to every workspace).
        const configFile = await readOpencodeConfig("global", "") as OpencodeConfigFile;
        if (configFile.exists && configFile.content?.trim()) {
          const updated = applyEdits(
            configFile.content,
            modify(configFile.content, ["mcp", name], undefined, { formattingOptions }),
          );
          await writeOpencodeConfig("global", "", updated.endsWith("\n") ? updated : `${updated}\n`);
        }

        // Connect merges into the runtime opencode config (the file the
        // packaged engine reads for every workspace), so removal deletes from
        // the same place or the server resurrects on the next instance build.
        try {
          await mergeRuntimeMcpServer(name, null);
        } catch {
          // Removal from the global config above already succeeded.
        }
      } else if (canUseLegalworkServer && legalworkClient && legalworkWorkspaceId) {
        await legalworkClient.removeMcp(legalworkWorkspaceId, name);
      } else {
        setStateField("mcpStatus", "MCP configuration is read-only here.");
        return;
      }

      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "removed" });
      await refreshMcpServers();
      if (snapshot.selectedMcp === name) {
        setStateField("selectedMcp", null);
      }
      setStateField("mcpStatus", null);
      captureAnalyticsEvent("integration_disconnected", {});
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.remove_failed"),
      );
    }
  }

  function notifyMcpReloading() {
    setStateField("mcpStatus", t("mcp.reloading_status"));
  }

  // OpenCode reconnects MCP servers asynchronously after /instance/dispose,
  // so an immediate mcp.status query returns stale "disconnected". Poll on
  // a backoff until every enabled MCP reaches a terminal status, with the
  // banner up the whole time so users see continuous feedback.
  async function pollMcpServersAfterReload(): Promise<void> {
    if (disposed) return;
    notifyMcpReloading();
    await refreshMcpServers();

    const settled = (statuses: McpStatusMap, servers: McpServerEntry[]) => {
      const expected = servers.filter((s) => s.config.enabled !== false);
      if (expected.length === 0) return true;
      return expected.every((server) => {
        const status = statuses[server.name]?.status;
        return status === "connected" || status === "needs_auth" || status === "failed";
      });
    };

    const delays = [400, 800, 1500, 2500, 4000];
    for (const delay of delays) {
      if (disposed) return;
      if (settled(snapshot.mcpStatuses, snapshot.mcpServers)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await refreshMcpServers();
    }

    if (disposed) return;
    // Only clear the reloading banner if it's still ours. refreshMcpServers
    // may have already replaced it with a real message (e.g. "No MCP servers").
    if (snapshot.mcpStatus === t("mcp.reloading_status")) {
      setStateField("mcpStatus", null);
    }
  }

  // Server-only path. Local fallback would rewrite opencode.jsonc whole and
  // clobber inline comments — settings-route.tsx already gates the prop so
  // this never gets called when the server is unavailable. Reload UX comes
  // from the existing reload-required popup; no extra banner here.
  async function setMcpEnabled(name: string, enabled: boolean) {
    try {
      const { legalworkClient, legalworkWorkspaceId, canUseLegalworkServer } =
        await resolveWritableLegalworkTarget();

      if (!canUseLegalworkServer || !legalworkClient || !legalworkWorkspaceId) {
        setStateField("mcpStatus", t("mcp.toggle_requires_server"));
        return;
      }

      await legalworkClient.setMcpEnabled(legalworkWorkspaceId, name, enabled);
      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "updated" });
      await refreshMcpServers();
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.toggle_failed"),
      );
    }
  }

  function closeMcpAuthModal() {
    mutateState((current) => ({
      ...current,
      mcpAuthModalOpen: false,
      mcpAuthEntry: null,
      mcpAuthNeedsReload: false,
    }));
  }

  async function completeMcpAuthModal() {
    closeMcpAuthModal();
    await refreshMcpServers();
  }

  const syncFromOptions = () => {
    const workspaceContextKey = getWorkspaceContextKey();
    const projectDir = options.projectDir().trim();
    const changed =
      workspaceContextKey !== lastWorkspaceContextKey || projectDir !== lastProjectDir;

    lastWorkspaceContextKey = workspaceContextKey;
    lastProjectDir = projectDir;

    if (!started || disposed || !changed) {
      return;
    }

    if (!isDesktopRuntime() && getLegalworkSnapshot().legalworkServerStatus !== "connected") {
      return;
    }

    void refreshMcpServers();
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;
    syncFromOptions();
  };

  const dispose = () => {
    disposed = true;
    started = false;
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
    get mcpServers() {
      return snapshot.mcpServers;
    },
    get mcpStatus() {
      return snapshot.mcpStatus;
    },
    get mcpLastUpdatedAt() {
      return snapshot.mcpLastUpdatedAt;
    },
    get mcpStatuses() {
      return snapshot.mcpStatuses;
    },
    get mcpConnectingName() {
      return snapshot.mcpConnectingName;
    },
    get selectedMcp() {
      return snapshot.selectedMcp;
    },
    setSelectedMcp(value: SetStateAction<string | null>) {
      const resolved = applyStateAction(state.selectedMcp, value);
      setStateField("selectedMcp", resolved);
    },
    quickConnect: MCP_QUICK_CONNECT,
    readMcpConfigFile,
    refreshMcpServers,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    setMcpEnabled,
    notifyMcpReloading,
    pollMcpServersAfterReload,
    get mcpAuthModalOpen() {
      return snapshot.mcpAuthModalOpen;
    },
    get mcpAuthEntry() {
      return snapshot.mcpAuthEntry;
    },
    get mcpAuthNeedsReload() {
      return snapshot.mcpAuthNeedsReload;
    },
    closeMcpAuthModal,
    completeMcpAuthModal,
  };
}

export function useConnectionsStoreSnapshot(store: ConnectionsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
