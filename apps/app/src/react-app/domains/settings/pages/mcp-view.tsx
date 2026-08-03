/** @jsxImportSource react */
import { useEffect, useReducer, useRef, useState, type SetStateAction } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cloud,
  Code2,
  CreditCard,
  FolderOpen,
  Globe,
  Loader2,
  MonitorSmartphone,
  Plug2,
  Plus,
  Power,
  Search,
  Settings2,
  Share2,
  Unplug,
  Zap,
} from "lucide-react";

import { isBuiltInLegalWorkExtension, getMcpServerName, type ExtensionKind, type McpDirectoryInfo } from "../../../../app/constants";
import { evaluateEnablement } from "../../../../app/enablement";
import type { EnablementResult } from "../../../../app/extensions";
import type { ImportedPlugin } from "../../../../app/lib/extension-imports";
import { ExtensionDetailModal } from "../../../design-system/extension-detail-modal";
import { resolveExtensionIconSrc } from "../../../design-system/extension-icon-src";
import { ExtensionMeshAvatar } from "../../../design-system/extension-mesh-avatar";
import {
  openDesktopPath,
  openDesktopUrl,
  readOpencodeConfig,
  revealDesktopItemInDir,
  type OpencodeConfigFile,
} from "../../../../app/lib/desktop";
import {
  getMcpIdentityKey,
  normalizeMcpSlug,
} from "../../../../app/mcp";
import type { McpServerEntry, McpStatusMap } from "../../../../app/types";
import { formatRelativeTime, isDesktopRuntime, isWindowsPlatform } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import { McpConnectorSetupModal } from "../../connections/modals/mcp-connector-setup-modal";
import {
  isLegalWorkExtensionEnabled,
  isLegalWorkExtensionHidden,
  LEGALWORK_EXTENSION_STATE_CHANGED,
  setLegalWorkExtensionEnabled,
  setLegalWorkExtensionHidden,
} from "../extension-state";
import {
  initialMcpViewLocalState,
  mcpViewLocalReducer,
  type ConfigScope,
  type McpViewLocalState,
} from "./mcp-view-state";
import { HubScopeToggle, useHubScope } from "./hub-scope-context";

export type ReactMcpStatus =
  | "connected"
  | "needs_auth"
  | "needs_client_registration"
  | "failed"
  | "disabled"
  | "disconnected";

export type SkillItem = {
  name: string;
  description?: string;
  trigger?: string;
  path: string;
};

const getSkillHiddenId = (skill: SkillItem) => `skill:${skill.name}`;

export type McpViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  /** Installed skills to render alongside MCPs in the grid. */
  installedSkills?: SkillItem[];
  /** Installed marketplace packages to render alongside runtime extensions. */
  installedPlugins?: ImportedPlugin[];
  /** Uninstall a skill by name. */
  uninstallSkill?: (name: string) => void;
  /** Remove an imported marketplace package by plugin id. */
  removeCloudPlugin?: (pluginId: string) => void | Promise<unknown>;
  /** Read skill content by name. */
  readSkill?: (name: string) => Promise<{ content: string } | null>;
  readConfigFile?: (scope: "project" | "global") => Promise<OpencodeConfigFile | null>;
  showHeader?: boolean;
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (name: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  /** Return extension-specific config UI for the detail modal. */
  configSlotForEntry?: (entry: McpDirectoryInfo) => React.ReactNode | null;
  /** Check if an extension-kind entry is connected/active. */
  isExtensionConnected?: (entry: McpDirectoryInfo) => boolean;
  /** Enablement context for evaluating extension active state. */
  enablementContext?: import("../../../../app/enablement").EnablementContext;
  /** Organization policy restriction for LegalWork-provided built-in extensions. */
  builtInExtensionsDisabled?: boolean;
  /** Firm Hub: share an MCP server entry org-wide (gated on admin_hub). */
  canShareWithFirm?: boolean;
  onShareWithFirm?: (mcpName: string) => void | Promise<void>;
  /** Firm Hub: "download integrations shared with your firm" section (self-gating). */
  firmDownloadView?: React.ReactNode;
  /** Opens the multi-select "Share with your firm" dialog (Team scope only). */
  onOpenTeamShare?: () => void;
};

const builtInExtensionDisabledReason = "Disabled by organization";

// Reference-style connector cards: soft-bordered tiles in a 2-column grid with
// mono type tags and quiet secondary text — shares the surface language with the
// Workflows card grid (no accent bars).
const pageTitleClass = "text-[34px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text";
const quickCardClass =
  "group relative flex cursor-pointer flex-col text-left rounded-[16px] border border-dls-border bg-dls-surface p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-[rgba(var(--dls-accent-rgb),0.25)] hover:shadow-[0_14px_34px_-18px_rgba(8,23,79,0.28)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)]";
const quickCardFeaturedClass =
  "border-[rgba(var(--dls-accent-rgb),0.55)] bg-[rgba(var(--dls-accent-rgb),0.06)] ring-1 ring-[rgba(var(--dls-accent-rgb),0.18)] shadow-[0_16px_38px_-22px_rgba(8,23,79,0.45)]";
const featuredTagClass =
  "shrink-0 rounded-full bg-[rgba(var(--dls-accent-rgb),0.12)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-dls-accent";
const typeTagClass = "shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-dls-secondary/70";
const rowIconBtnClass =
  "inline-flex size-8 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-40";
const ghostActionClass =
  "inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50";

const addAppButtonClass =
  "inline-flex items-center gap-1.5 rounded-full border border-dls-border bg-dls-surface px-4 py-2 text-[13px] font-medium text-dls-text shadow-[0_1px_2px_rgba(2,6,23,0.05)] transition-colors hover:border-[rgba(var(--dls-accent-rgb),0.45)] hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50";

const statusDot = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return "bg-green-9";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-9";
    case "disabled":
      return "bg-gray-8";
    case "disconnected":
      return "bg-gray-7";
    default:
      return "bg-red-9";
  }
};

const friendlyStatus = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return t("mcp.friendly_status_ready");
    case "needs_auth":
    case "needs_client_registration":
      return t("mcp.friendly_status_needs_signin");
    case "disabled":
      return t("mcp.friendly_status_paused");
    case "disconnected":
      return t("mcp.friendly_status_offline");
    default:
      return t("mcp.friendly_status_issue");
  }
};

const statusBadgeStyle = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return "bg-green-3 text-green-11";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-3 text-amber-11";
    case "disabled":
    case "disconnected":
      return "bg-gray-3 text-gray-11";
    default:
      return "bg-red-3 text-red-11";
  }
};

const serviceIcon = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return BookOpen;
  if (lower.includes("linear")) return Zap;
  if (lower.includes("sentry")) return CircleAlert;
  if (lower.includes("stripe")) return CreditCard;
  if (lower.includes("context")) return Globe;
  if (lower.includes("devtools")) {
    return MonitorSmartphone;
  }
  if (lower.includes("legalwork") && lower.includes("cloud")) return Cloud;
  if (lower.includes("legalwork") && lower.includes("ui")) return MonitorSmartphone;
  return Plug2;
};

const serviceColor = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "text-gray-12";
  if (lower.includes("linear")) return "text-blue-11";
  if (lower.includes("sentry")) return "text-purple-11";
  if (lower.includes("stripe")) return "text-blue-11";
  if (lower.includes("context")) return "text-green-11";
  if (lower.includes("devtools")) {
    return "text-amber-11";
  }
  if (lower.includes("legalwork")) return "text-gray-12";
  return "text-dls-secondary";
};

const serviceIconBg = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "bg-gray-3 border-gray-6";
  if (lower.includes("linear")) return "bg-blue-3 border-blue-6";
  if (lower.includes("sentry")) return "bg-purple-3 border-purple-6";
  if (lower.includes("stripe")) return "bg-blue-3 border-blue-6";
  if (lower.includes("context")) return "bg-green-3 border-green-6";
  if (lower.includes("devtools")) {
    return "bg-amber-3 border-amber-6";
  }
  if (lower.includes("legalwork")) return "bg-gray-3 border-gray-6";
  return "bg-dls-hover border-dls-border";
};

// Inline brand icon for ledger rows — reproduces ExtensionCard's icon resolution
// (direct iconSrc → Simple Icons CDN slug → MarbleAvatar fallback) without
// importing the card component itself.
function LedgerBrandIcon(props: {
  name: string;
  iconSlug?: string;
  iconSrc?: string;
  kind: ExtensionKind;
  connecting?: boolean;
}) {
  const resolvedIconSrc = props.iconSrc ? resolveExtensionIconSrc(props.iconSrc) : undefined;
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-hover">
      {props.connecting ? (
        <Loader2 size={16} className="animate-spin text-dls-secondary" />
      ) : resolvedIconSrc ? (
        <div className="flex size-6 items-center justify-center rounded-md bg-white">
          <img src={resolvedIconSrc} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
        </div>
      ) : props.iconSlug ? (
        <div className="flex size-6 items-center justify-center rounded-md bg-white">
          <img src={`https://cdn.simpleicons.org/${props.iconSlug}`} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
        </div>
      ) : (
        <ExtensionMeshAvatar name={props.name} category={props.kind} className="size-6 rounded-md shadow-inner" />
      )}
    </div>
  );
}

function extensionResourceLabels(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.resources.map((resource) => resource.label ?? resource.id) ?? [];
}

function extensionContributionLabels(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.contributions?.map((contribution) => contribution.label ?? contribution.ref ?? contribution.type) ?? [];
}

function isToggleOnlyExtension(entry: McpDirectoryInfo) {
  if (entry.kind !== "extension") return false;
  return entry.extensionManifest?.contributions?.some((contribution) =>
    contribution.type === "session-side-panel" || contribution.type === "session-rail-item"
  ) === true;
}

type ExtensionFilter = "all" | "mcp" | "skill" | "plugin";

export function McpView(props: McpViewProps) {
  const showHeader = props.showHeader !== false;
  const [detailEntry, setDetailEntry] = useState<McpDirectoryInfo | null>(null);
  const [setupEntry, setSetupEntry] = useState<McpDirectoryInfo | null>(null);
  const [detailSkill, setDetailSkill] = useState<SkillItem | null>(null);
  const [detailSkillContent, setDetailSkillContent] = useState<string | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<ImportedPlugin | null>(null);
  const [legalworkUiMcpCommand, setLegalworkUiMcpCommand] = useState<string[] | null>(null);
  const [legalworkUiMcpEnvironment, setLegalworkUiMcpEnvironment] = useState<Record<string, string> | null>(null);
  const [computerUseMcpCommand, setComputerUseMcpCommand] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  // Local | Team toggle (see skills-view). Only meaningful with a Team view.
  const [hubScope, setHubScope] = useState<"local" | "team">("local");
  // A page-level owner (Integrations page) may control the scope via context; if
  // so, follow it and hide our own toggle. Standalone use keeps the local toggle.
  const externalScope = useHubScope();
  const scope = externalScope ?? hubScope;
  const hasTeamView = Boolean(props.firmDownloadView);
  const showInternalToggle = hasTeamView && externalScope === null;
  const showLocal = !hasTeamView || scope === "local";
  const showTeam = hasTeamView && scope === "team";
  const [showHidden, setShowHidden] = useState(false);
  const [, setExtensionStateVersion] = useState(0);

  const [localState, dispatchLocal] = useReducer(
    mcpViewLocalReducer,
    initialMcpViewLocalState,
  );
  const {
    logoutOpen,
    logoutTarget,
    logoutBusy,
    removeOpen,
    removeTarget,
    configScope,
    projectConfig,
    globalConfig,
    configError,
    revealBusy,
    showAdvanced,
    addMcpModalOpen,
    togglingMcp,
  } = localState;
  const setLocal = <K extends keyof McpViewLocalState>(
    key: K,
    value: SetStateAction<McpViewLocalState[K]>,
  ) => dispatchLocal({ type: "set", key, value });
  const setLogoutOpen = (value: SetStateAction<boolean>) => setLocal("logoutOpen", value);
  const setLogoutTarget = (value: SetStateAction<string | null>) => setLocal("logoutTarget", value);
  const setLogoutBusy = (value: SetStateAction<boolean>) => setLocal("logoutBusy", value);
  const setRemoveOpen = (value: SetStateAction<boolean>) => setLocal("removeOpen", value);
  const setRemoveTarget = (value: SetStateAction<string | null>) => setLocal("removeTarget", value);
  const setConfigScope = (value: SetStateAction<ConfigScope>) => setLocal("configScope", value);
  const setConfigError = (value: SetStateAction<string | null>) => setLocal("configError", value);
  const setRevealBusy = (value: SetStateAction<boolean>) => setLocal("revealBusy", value);
  const setShowAdvanced = (value: SetStateAction<boolean>) => setLocal("showAdvanced", value);
  const setAddMcpModalOpen = (value: SetStateAction<boolean>) => setLocal("addMcpModalOpen", value);
  const setTogglingMcp = (value: SetStateAction<string | null>) => setLocal("togglingMcp", value);
  const configRequestId = useRef(0);

  const quickConnectList = props.quickConnect;

  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(LEGALWORK_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(LEGALWORK_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void (async () => {
      try {
        const command = await window.__LEGALWORK_ELECTRON__?.invokeDesktop?.("getLegalworkUiMcpCommand");
        if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
          setLegalworkUiMcpCommand(command);
        }
        const environment = await window.__LEGALWORK_ELECTRON__?.invokeDesktop?.("getLegalworkUiMcpEnvironment");
        if (environment && typeof environment === "object" && !Array.isArray(environment)) {
          setLegalworkUiMcpEnvironment(Object.fromEntries(
            Object.entries(environment).filter((entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string"
            ),
          ));
        }
        const computerUseCommand = await window.__LEGALWORK_ELECTRON__?.invokeDesktop?.("getComputerUseMcpCommand");
        if (Array.isArray(computerUseCommand) && computerUseCommand.every((part) => typeof part === "string")) {
          setComputerUseMcpCommand(computerUseCommand);
        }
      } catch {
        setLegalworkUiMcpCommand(null);
        setLegalworkUiMcpEnvironment(null);
        setComputerUseMcpCommand(null);
      }
    })();
  }, []);

  useEffect(() => {
    const root = props.selectedWorkspaceRoot.trim();
    const nextId = configRequestId.current + 1;
    configRequestId.current = nextId;
    const readConfig = props.readConfigFile;
    const canReadDesktopConfig = !props.isRemoteWorkspace && isDesktopRuntime();

    if (!readConfig && !canReadDesktopConfig) {
      dispatchLocal({ type: "configUnavailable" });
      return;
    }

    void (async () => {
      try {
        setConfigError(null);
        const [project, global] = await Promise.all([
          root
            ? readConfig
              ? readConfig("project")
              : canReadDesktopConfig
              ? readOpencodeConfig("project", root)
              : Promise.resolve(null)
            : Promise.resolve(null),
          readConfig
            ? readConfig("global")
            : canReadDesktopConfig
            ? readOpencodeConfig("global", root)
            : Promise.resolve(null),
        ]);
        if (nextId !== configRequestId.current) return;
        dispatchLocal({
          type: "configLoaded",
          project: project as OpencodeConfigFile | null,
          global: global as OpencodeConfigFile | null,
        });
      } catch (error) {
        if (nextId !== configRequestId.current) return;
        dispatchLocal({
          type: "configLoadError",
          error: error instanceof Error ? error.message : t("mcp.config_load_failed"),
        });
      }
    })();
  }, [props.isRemoteWorkspace, props.readConfigFile, props.selectedWorkspaceRoot]);

  const activeConfig = configScope === "project" ? projectConfig : globalConfig;

  const revealLabel = isWindowsPlatform()
    ? t("mcp.open_file")
    : t("mcp.reveal_in_finder");

  const canRevealConfig =
    isDesktopRuntime() &&
    !props.isRemoteWorkspace &&
    !revealBusy &&
    !(configScope === "project" && !props.selectedWorkspaceRoot.trim()) &&
    Boolean(activeConfig?.exists);

  const resolveQuickConnectMatch = (name: string) =>
    quickConnectList.find((candidate) => {
      const candidateKey = getMcpIdentityKey(candidate);
      return (
        candidateKey === name ||
        candidate.name === name ||
        normalizeMcpSlug(candidate.name) === name
      );
    });

  const displayName = (name: string) => resolveQuickConnectMatch(name)?.name ?? name;

  const quickConnectStatus = (entry: McpDirectoryInfo) =>
    props.mcpStatuses[getMcpIdentityKey(entry)];

  const isQuickConnectConfigured = (entry: McpDirectoryInfo) =>
    props.mcpServers.some((server) => server.name === getMcpIdentityKey(entry));

  const isMcpBackedExtension = (entry: McpDirectoryInfo) =>
    entry.kind === "extension" && Boolean(entry.type || entry.command?.length || entry.url);

  const enablementForEntry = (entry: McpDirectoryInfo): { active: boolean; results: EnablementResult[] } | null => {
    const manifest = entry.extensionManifest;
    if (manifest?.enablement && props.enablementContext) {
      return evaluateEnablement(manifest.enablement, props.enablementContext);
    }
    return null;
  };

  const launchCommandForEntry = (entry: McpDirectoryInfo) => {
    if (entry.serverName === "legalwork-ui") return legalworkUiMcpCommand ?? undefined;
    if (entry.serverName === "computer-use") return computerUseMcpCommand ?? entry.command;
    return entry.command;
  };

  const supportsOauth = (entry: McpServerEntry) =>
    entry.config.type === "remote" && entry.config.oauth !== false;

  const resolveStatus = (entry: McpServerEntry): ReactMcpStatus => {
    if (entry.config.enabled === false) return "disabled";
    const resolved = props.mcpStatuses[entry.name];
    return resolved?.status ?? "disconnected";
  };

  const connectedCount = props.mcpServers.filter(
    (entry) => resolveStatus(entry) === "connected",
  ).length;
  const hiddenCount = quickConnectList.filter((entry) => isLegalWorkExtensionHidden(entry)).length +
    (props.installedSkills ?? []).filter((skill) => isLegalWorkExtensionHidden(getSkillHiddenId(skill))).length +
    (props.installedPlugins ?? []).filter((plugin) => isLegalWorkExtensionHidden(`plugin:${plugin.pluginId}`)).length;
  const policyHiddenBuiltInCount = props.builtInExtensionsDisabled
    ? quickConnectList.filter((entry) => isBuiltInLegalWorkExtension(entry) && !isLegalWorkExtensionHidden(entry)).length
    : 0;
  const hiddenOrPolicyCount = hiddenCount + policyHiddenBuiltInCount;

  const requestLogout = (name: string) => {
    if (!name.trim()) return;
    setLogoutTarget(name);
    setLogoutOpen(true);
  };

  const confirmLogout = async () => {
    const name = logoutTarget;
    if (!name || logoutBusy) return;
    setLogoutBusy(true);
    try {
      await props.logoutMcpAuth(name);
    } finally {
      setLogoutBusy(false);
      setLogoutOpen(false);
      setLogoutTarget(null);
    }
  };

  const revealConfig = async () => {
    if (!isDesktopRuntime() || revealBusy) return;
    const root = props.selectedWorkspaceRoot.trim();

    if (configScope === "project" && !root) {
      setConfigError(t("mcp.pick_workspace_error"));
      return;
    }

    setRevealBusy(true);
    setConfigError(null);
    try {
      const resolved = props.readConfigFile
        ? await props.readConfigFile(configScope)
        : !props.isRemoteWorkspace
        ? await readOpencodeConfig(configScope, root)
        : null;
      const configFile = resolved as OpencodeConfigFile | null;
      if (!configFile) {
        throw new Error(t("mcp.config_load_failed"));
      }
      if (isWindowsPlatform()) {
        await openDesktopPath(configFile.path);
      } else {
        await revealDesktopItemInDir(configFile.path);
      }
    } catch (error) {
      setConfigError(
        error instanceof Error ? error.message : t("mcp.reveal_config_failed"),
      );
    } finally {
      setRevealBusy(false);
    }
  };

  return (
    <section className="space-y-8 max-w-5xl w-full animate-in fade-in duration-300">
      <div className="space-y-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            {showHeader ? <McpViewHeader connectedCount={connectedCount} /> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAddMcpModalOpen(true)}
              className={addAppButtonClass}
            >
              <Plus size={14} />
              {t("mcp.add_modal_title")}
            </button>
          </div>
        </div>

        {showInternalToggle ? (
          <div className="flex items-center justify-between gap-3">
            <HubScopeToggle scope={hubScope} onChange={setHubScope} />
            {hubScope === "team" && props.onOpenTeamShare ? (
              <Button variant="outline" size="sm" onClick={props.onOpenTeamShare}>
                <Share2 className="size-4" /> Share with firm
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Search + filter */}
        {showLocal ? (
        <div className="space-y-3 border-t border-dls-border pt-5">
          <div className="relative w-full">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              className="w-full rounded-[14px] border border-dls-border bg-transparent py-2.5 pl-10 pr-3 text-[14px] text-dls-text placeholder:text-dls-secondary focus:border-[rgba(var(--dls-accent-rgb),0.4)] focus:outline-none"
              placeholder="Search connectors..."
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
          <div className="flex items-center justify-end gap-4 text-[13px]">
            {(["all", "mcp", "skill"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={
                  filter === f
                    ? "font-medium text-dls-text transition-colors"
                    : "text-dls-secondary transition-colors hover:text-dls-text"
                }
              >
                {f === "all" ? "All" : f === "mcp" ? "MCPs" : "Skills"}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowHidden((current) => !current)}
              className={
                showHidden
                  ? "font-medium text-dls-text transition-colors"
                  : "text-dls-secondary transition-colors hover:text-dls-text"
              }
            >
              {showHidden ? "Showing hidden" : hiddenOrPolicyCount > 0 ? `Show hidden (${hiddenOrPolicyCount})` : "Show hidden"}
            </button>
          </div>
        </div>
        ) : null}
      </div>

      {showTeam ? props.firmDownloadView : null}

      {showLocal ? (
      <>
      {props.mcpStatus ? (
        <div className="whitespace-pre-wrap wrap-break-word rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {props.mcpStatus}
        </div>
      ) : null}

      {props.builtInExtensionsDisabled ? (
        <div className="rounded-[20px] border border-amber-6 bg-amber-2 px-5 py-4 text-[13px] text-amber-11">
          Built-in LegalWork extensions are disabled by your organization. Use Show hidden to review blocked built-ins.
        </div>
      ) : null}

      <McpQuickConnectSection
        entries={
          quickConnectList.filter((entry) => {
            if (!showHidden && (isLegalWorkExtensionHidden(entry) || (props.builtInExtensionsDisabled && isBuiltInLegalWorkExtension(entry)))) return false;
            if (filter === "skill") return false;
            if (filter === "mcp" && (entry.kind ?? "mcp") !== "mcp" && entry.kind !== "ui-control") return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
          })
        }
        installedSkills={
          (props.installedSkills ?? []).filter((skill) => {
            if (!showHidden && isLegalWorkExtensionHidden(getSkillHiddenId(skill))) return false;
            if (filter === "mcp") return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return skill.name.toLowerCase().includes(q) || (skill.description ?? "").toLowerCase().includes(q);
          })
        }
        installedPlugins={
          (props.installedPlugins ?? []).filter((plugin) => {
            if (!showHidden && isLegalWorkExtensionHidden(`plugin:${plugin.pluginId}`)) return false;
            if (filter === "mcp" || filter === "skill") return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return [plugin.name, plugin.description ?? "", ...plugin.files.map((file) => `${file.title} ${file.objectType} ${file.path}`)]
              .join(" ")
              .toLowerCase()
              .includes(q);
          })
        }
        busy={props.busy}
        connectingName={props.mcpConnectingName}
        isEntryHidden={(entry) => isLegalWorkExtensionHidden(entry)}
        isSkillHidden={(skill) => isLegalWorkExtensionHidden(getSkillHiddenId(skill))}
        isPluginHidden={(plugin) => isLegalWorkExtensionHidden(`plugin:${plugin.pluginId}`)}
        disabledReasonForEntry={(entry) =>
          props.builtInExtensionsDisabled && isBuiltInLegalWorkExtension(entry)
            ? builtInExtensionDisabledReason
            : null
        }
        isConfigured={(entry) => {
          if (props.builtInExtensionsDisabled && isBuiltInLegalWorkExtension(entry)) return false;
          const result = enablementForEntry(entry);
          if (result) return result.active;
          // Fallback for entries without enablement context.
          if (isToggleOnlyExtension(entry)) return isLegalWorkExtensionEnabled(entry);
          if (entry.kind === "extension" && !isMcpBackedExtension(entry)) return props.isExtensionConnected?.(entry) ?? false;
          return isQuickConnectConfigured(entry);
        }}
        enablementForEntry={props.enablementContext ? enablementForEntry : undefined}
        statusForEntry={quickConnectStatus}
        onConnect={props.connectMcp}
        onDetail={setDetailEntry}
        shareRefForEntry={
          props.canShareWithFirm && props.onShareWithFirm
            ? (entry) => props.mcpServers.find((server) => server.name === getMcpIdentityKey(entry))?.name ?? null
            : undefined
        }
        onShareMcp={props.onShareWithFirm}
        onSkillDetail={(skill) => {
          setDetailSkill(skill);
          setDetailSkillContent(null);
          if (props.readSkill) {
            void props.readSkill(skill.name).then((result) => {
              if (result?.content) {
                setDetailSkillContent(result.content.slice(0, 2000));
              }
            });
          }
        }}
        onPluginDetail={setDetailPlugin}
      />

      <McpConfiguredServersSection
        servers={props.mcpServers}
        statuses={props.mcpStatuses}
        lastUpdatedAt={props.mcpLastUpdatedAt}
        selectedMcp={props.selectedMcp}
        busy={props.busy}
        logoutBusy={logoutBusy}
        logoutTarget={logoutTarget}
        togglingMcp={togglingMcp}
        displayName={displayName}
        resolveStatus={resolveStatus}
        supportsOauth={supportsOauth}
        onSelect={props.setSelectedMcp}
        onAuthorize={props.authorizeMcp}
        onRequestLogout={requestLogout}
        onRemove={(name) => {
          setRemoveTarget(name);
          setRemoveOpen(true);
        }}
        onToggleEnabled={props.setMcpEnabled}
        onToggleBusy={setTogglingMcp}
        canShareWithFirm={props.canShareWithFirm}
        onShareWithFirm={props.onShareWithFirm}
      />
      </>
      ) : null}

      <ConfirmModal
        open={logoutOpen}
        title={t("mcp.logout_modal_title")}
        message={t("mcp.logout_modal_message").replace("{server}", displayName(logoutTarget ?? ""))}
        confirmLabel={logoutBusy ? t("mcp.logout_working") : t("mcp.logout_action")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => {
          if (logoutBusy) return;
          setLogoutOpen(false);
          setLogoutTarget(null);
        }}
        onConfirm={() => {
          void confirmLogout();
        }}
      />

      <ConfirmModal
        open={removeOpen}
        title={t("mcp.remove_modal_title")}
        message={t("mcp.remove_modal_message").replace("{server}", displayName(removeTarget ?? ""))}
        confirmLabel={t("mcp.remove_app")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => {
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
        onConfirm={() => {
          if (removeTarget) props.removeMcp(removeTarget);
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
      />

      <AddMcpModal
        open={addMcpModalOpen}
        onClose={() => setAddMcpModalOpen(false)}
        onAdd={(entry) => props.connectMcp(entry)}
        busy={props.busy}
        isRemoteWorkspace={props.isRemoteWorkspace}
      />

      <McpConnectorSetupModal
        entry={setupEntry}
        open={Boolean(setupEntry)}
        onClose={() => setSetupEntry(null)}
        onConnect={(entry) => {
          props.connectMcp(entry);
          setSetupEntry(null);
        }}
      />

      {detailEntry ? (() => {
        const extensionConfigSlot = props.configSlotForEntry?.(detailEntry) ?? null;
        const hasConfigSlot = extensionConfigSlot !== null;
        const hidden = isLegalWorkExtensionHidden(detailEntry);
        const disabledReason = props.builtInExtensionsDisabled && isBuiltInLegalWorkExtension(detailEntry)
          ? builtInExtensionDisabledReason
          : null;
        const isConnected = disabledReason
          ? false
          : isToggleOnlyExtension(detailEntry)
          ? isLegalWorkExtensionEnabled(detailEntry)
          : detailEntry.kind === "extension" && !isMcpBackedExtension(detailEntry)
          ? props.isExtensionConnected?.(detailEntry) ?? false
          : isQuickConnectConfigured(detailEntry);
        const isGoogleWorkspace = detailEntry.id === "google-workspace";
        return (
          <ExtensionDetailModal
            open={!!detailEntry}
            onClose={() => setDetailEntry(null)}
            name={detailEntry.name}
            description={detailEntry.description}
            setupNote={detailEntry.setupNote}
            learnMoreUrl={detailEntry.learnMoreUrl}
            iconSlug={detailEntry.iconSlug}
            iconSrc={detailEntry.iconSrc}
            fallbackIcon={serviceIcon(detailEntry.name)}
            kind={detailEntry.kind ?? "mcp"}
            connected={isConnected}
            connecting={props.mcpConnectingName === detailEntry.name}
            hidden={hidden}
            preview={detailEntry.preview}
            disabledReason={disabledReason}
            setupInstructions={isGoogleWorkspace ? undefined : detailEntry.extensionManifest?.setup?.instructions}
            resourceLabels={isGoogleWorkspace ? [] : extensionResourceLabels(detailEntry)}
            contributionLabels={isGoogleWorkspace ? [] : extensionContributionLabels(detailEntry)}
            launchCommand={launchCommandForEntry(detailEntry)}
            environment={detailEntry.serverName === "legalwork-ui" ? legalworkUiMcpEnvironment ?? undefined : undefined}
            url={typeof detailEntry.url === "string" ? detailEntry.url : undefined}
            oauth={detailEntry.oauth}
            configSlot={disabledReason ? null : extensionConfigSlot}
            showEnablementCard={!isGoogleWorkspace}
            onConnect={disabledReason || detailEntry.requestAccessUrl ? undefined : isToggleOnlyExtension(detailEntry) ? () => {
              setLegalWorkExtensionEnabled(detailEntry, true);
              setDetailEntry(null);
            } : hasConfigSlot ? undefined : () => {
              if (entryNeedsSetup(detailEntry)) {
                setSetupEntry(detailEntry);
              } else {
                props.connectMcp(detailEntry);
              }
              setDetailEntry(null);
            }}
            onRequestAccess={detailEntry.requestAccessUrl ? () => {
              void openDesktopUrl(detailEntry.requestAccessUrl!);
              setDetailEntry(null);
            } : undefined}
            onUninstall={disabledReason ? undefined : isToggleOnlyExtension(detailEntry) && isConnected ? () => {
              setLegalWorkExtensionEnabled(detailEntry, false);
            } : isQuickConnectConfigured(detailEntry) ? () => {
              const slug = getMcpIdentityKey(detailEntry);
              props.removeMcp(slug);
              setDetailEntry(null);
            } : undefined}
            onHide={() => setLegalWorkExtensionHidden(detailEntry, true)}
            onShow={() => setLegalWorkExtensionHidden(detailEntry, false)}
          />
        );
      })() : null}

      {detailSkill ? (() => {
        const hidden = isLegalWorkExtensionHidden(getSkillHiddenId(detailSkill));
        return (
          <ExtensionDetailModal
            open={!!detailSkill}
            onClose={() => { setDetailSkill(null); setDetailSkillContent(null); }}
            name={detailSkill.name}
            description={detailSkill.description ?? "Installed skill"}
            kind="skill"
            connected={true}
            hidden={hidden}
            path={detailSkill.path}
            trigger={detailSkill.trigger}
            contentPreview={detailSkillContent ?? undefined}
            onReveal={detailSkill.path ? () => {
              void revealDesktopItemInDir(detailSkill.path);
            } : undefined}
            onUninstall={props.uninstallSkill ? () => {
              props.uninstallSkill?.(detailSkill.name);
              setDetailSkill(null);
            } : undefined}
            onHide={() => setLegalWorkExtensionHidden(getSkillHiddenId(detailSkill), true)}
            onShow={() => setLegalWorkExtensionHidden(getSkillHiddenId(detailSkill), false)}
          />
        );
      })() : null}

      {detailPlugin ? (() => {
        const hidden = isLegalWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`);
        return (
          <ExtensionDetailModal
            open={!!detailPlugin}
            onClose={() => setDetailPlugin(null)}
            name={detailPlugin.name}
            description={detailPlugin.description ?? "Marketplace extension installed in this workspace."}
            kind="extension"
            connected={true}
            hidden={hidden}
            onUninstall={props.removeCloudPlugin ? () => {
              void props.removeCloudPlugin?.(detailPlugin.pluginId);
              setDetailPlugin(null);
            } : undefined}
            onHide={() => setLegalWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`, true)}
            onShow={() => setLegalWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`, false)}
          />
        );
      })() : null}
    </section>
  );
}

function McpViewHeader(props: { connectedCount: number }) {
  return (
    <>
      <span className="lw-section-eyebrow uppercase text-dls-secondary">Connectors</span>
      <h2 className={`mt-3 ${pageTitleClass}`}>{t("mcp.apps_title")}</h2>
      <p className="mt-3 max-w-xl text-[14px] leading-[1.65] text-dls-secondary">{t("mcp.apps_subtitle")}</p>
      {props.connectedCount > 0 ? (
        <p className="mt-2 font-mono text-[11px] tabular-nums text-dls-secondary">
          {props.connectedCount.toString().padStart(2, "0")}{" "}
          {props.connectedCount === 1 ? t("mcp.app_connected") : t("mcp.apps_connected")}
        </p>
      ) : null}
    </>
  );
}

// A connector needs the setup form before connecting when its URL still has
// {placeholder} segments (instance/tenant/site) or the vendor has no OAuth
// dynamic client registration (firm must supply its own clientId/secret).
function entryNeedsSetup(entry: McpDirectoryInfo): boolean {
  return (
    (typeof entry.url === "string" && /\{[^}]+\}/.test(entry.url)) ||
    entry.requiresOauthClient === true ||
    entry.requiresToken === true
  );
}

function McpQuickConnectSection(props: {
  entries: McpDirectoryInfo[];
  installedSkills?: SkillItem[];
  installedPlugins?: ImportedPlugin[];
  busy: boolean;
  connectingName: string | null;
  isEntryHidden: (entry: McpDirectoryInfo) => boolean;
  isSkillHidden: (skill: SkillItem) => boolean;
  isPluginHidden: (plugin: ImportedPlugin) => boolean;
  disabledReasonForEntry: (entry: McpDirectoryInfo) => string | null;
  isConfigured: (entry: McpDirectoryInfo) => boolean;
  enablementForEntry?: (entry: McpDirectoryInfo) => { active: boolean; results: EnablementResult[] } | null;
  statusForEntry: (entry: McpDirectoryInfo) => { status: ReactMcpStatus } | undefined;
  onConnect: (entry: McpDirectoryInfo) => void;
  onDetail: (entry: McpDirectoryInfo) => void;
  shareRefForEntry?: (entry: McpDirectoryInfo) => string | null;
  onShareMcp?: (mcpName: string) => void | Promise<void>;
  onSkillDetail?: (skill: SkillItem) => void;
  onPluginDetail?: (plugin: ImportedPlugin) => void;
}) {
  const skills = props.installedSkills ?? [];
  const plugins = props.installedPlugins ?? [];
  const totalCount = props.entries.length + skills.length + plugins.length;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="lw-section-eyebrow uppercase text-dls-secondary">{t("mcp.available_apps")}</span>
        <span className="font-mono text-[11px] tabular-nums text-dls-secondary">
          {totalCount.toString().padStart(2, "0")}
        </span>
      </div>

      {totalCount === 0 ? (
        <div className="border-y border-dls-border py-16 text-center">
          <Unplug size={24} className="mx-auto mb-3 text-dls-secondary/30" />
          <div className="text-[14px] font-medium text-dls-secondary">No extensions found</div>
          <div className="mt-1 text-[13px] text-dls-secondary/60">Try a different search, filter, or open Marketplace to add one.</div>
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))]">
          {/* MCP entries */}
          {props.entries.map((entry) => {
            const configured = props.isConfigured(entry);
            const enablement = props.enablementForEntry?.(entry);
            const someMet = enablement
              ? enablement.results.some((r) => r.met) && !enablement.results.every((r) => r.met)
              : false;
            const connecting = props.connectingName === entry.name;
            const hidden = props.isEntryHidden(entry);
            const disabledReason = props.disabledReasonForEntry(entry);
            const kind = entry.kind ?? "mcp";
            const shareRef = props.shareRefForEntry?.(entry) ?? null;
            const typeLabel = kind === "skill" ? "Skill" : kind === "extension" ? "Extension" : "MCP";
            const actionLabel = configured
              ? "View details"
              : entry.requestAccessUrl
                ? "Request access"
                : entryNeedsSetup(entry)
                  ? "Set up & connect"
                  : t("mcp.tap_to_connect");
            return (
              <div
                key={getMcpIdentityKey(entry)}
                role="button"
                tabIndex={0}
                aria-disabled={props.busy}
                onClick={() => { if (!props.busy) props.onDetail(entry); }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  if (!props.busy) props.onDetail(entry);
                }}
                className={`${quickCardClass} ${entry.featured ? quickCardFeaturedClass : ""} ${hidden ? "opacity-70" : ""} ${props.busy ? "pointer-events-none opacity-60" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <LedgerBrandIcon
                      name={entry.name}
                      iconSlug={entry.iconSlug}
                      iconSrc={entry.iconSrc}
                      kind={kind}
                      connecting={connecting}
                    />
                    <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{entry.name}</h4>
                  </div>
                  {configured ? (
                    <CheckCircle2 size={16} className="mt-1 shrink-0 text-green-9" />
                  ) : someMet ? (
                    <CircleAlert size={16} className="mt-1 shrink-0 text-amber-9" />
                  ) : null}
                </div>
                <p className={`mt-2 text-[13px] leading-relaxed text-dls-secondary ${entry.featured ? "line-clamp-4" : "line-clamp-2"}`}>{entry.description}</p>
                {entry.setupNote ? (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-dls-secondary/80">{entry.setupNote}</p>
                ) : null}
                {entry.learnMoreUrl ? (
                  <button
                    type="button"
                    className="mt-2 self-start text-[12px] font-medium text-dls-accent underline-offset-2 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void openDesktopUrl(entry.learnMoreUrl!);
                    }}
                  >
                    {t("mcp.quick_connect_learn_more")}
                  </button>
                ) : null}
                {disabledReason ? (
                  <p className="mt-1.5 text-[12px] font-medium text-amber-11">{disabledReason}</p>
                ) : null}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {configured ? (
                      <span className={typeTagClass}>Connected</span>
                    ) : someMet ? (
                      <span className={typeTagClass}>Partial</span>
                    ) : (
                      <span className={typeTagClass}>{typeLabel}</span>
                    )}
                    {hidden ? <span className={typeTagClass}>Hidden</span> : null}
                    {entry.featured ? <span className={featuredTagClass}>{t("mcp.quick_connect_featured")}</span> : null}
                    {entry.preview ? <span className={typeTagClass}>Preview</span> : null}
                    {disabledReason ? <span className={typeTagClass}>Disabled</span> : null}
                  </div>
                  {shareRef && props.onShareMcp ? (
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void props.onShareMcp?.(shareRef);
                      }}
                      title={t("firm_hub.share_with_firm")}
                      aria-label={`${t("firm_hub.share_with_firm")}: ${entry.name}`}
                    >
                      <Share2 size={13} />
                      Share
                    </button>
                  ) : !disabledReason && !connecting ? (
                    <span className="shrink-0 text-[12px] font-medium text-dls-secondary transition-colors group-hover:text-dls-text">
                      {actionLabel}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}

          {/* Installed skills */}
          {skills.map((skill) => {
            const hidden = props.isSkillHidden(skill);
            return (
              <div
                key={`skill:${skill.name}`}
                role="button"
                tabIndex={0}
                onClick={() => props.onSkillDetail?.(skill)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  props.onSkillDetail?.(skill);
                }}
                className={`${quickCardClass} ${hidden ? "opacity-70" : ""}`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <LedgerBrandIcon name={skill.name} kind="skill" />
                  <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{skill.name}</h4>
                </div>
                <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">{skill.description ?? "Installed skill"}</p>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={typeTagClass}>Skill</span>
                    {hidden ? <span className={typeTagClass}>Hidden</span> : null}
                  </div>
                  <span className="shrink-0 text-[12px] font-medium text-dls-secondary transition-colors group-hover:text-dls-text">View details</span>
                </div>
              </div>
            );
          })}

          {/* Installed marketplace plugins */}
          {plugins.map((plugin) => {
            const hidden = props.isPluginHidden(plugin);
            const fileCount = plugin.files.length;
            return (
              <div
                key={`plugin:${plugin.pluginId}`}
                role="button"
                tabIndex={0}
                onClick={() => props.onPluginDetail?.(plugin)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  props.onPluginDetail?.(plugin);
                }}
                className={`${quickCardClass} ${hidden ? "opacity-70" : ""}`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <LedgerBrandIcon name={plugin.name} kind="extension" />
                  <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{plugin.name}</h4>
                </div>
                <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
                  {plugin.description ?? `Marketplace extension with ${fileCount} installed file${fileCount === 1 ? "" : "s"}.`}
                </p>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={typeTagClass}>Extension</span>
                    {hidden ? <span className={typeTagClass}>Hidden</span> : null}
                  </div>
                  <span className="shrink-0 text-[12px] font-medium text-dls-secondary transition-colors group-hover:text-dls-text">View details</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function McpConfiguredServersSection(props: {
  servers: McpServerEntry[];
  statuses: McpStatusMap;
  lastUpdatedAt: number | null;
  selectedMcp: string | null;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  displayName: (name: string) => string;
  resolveStatus: (entry: McpServerEntry) => ReactMcpStatus;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onSelect: (name: string | null) => void;
  onAuthorize: (entry: McpServerEntry) => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
  canShareWithFirm?: boolean;
  onShareWithFirm?: (mcpName: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="lw-section-eyebrow uppercase text-dls-secondary">{t("mcp.your_apps")}</span>
        <div className="flex items-baseline gap-3">
          {props.lastUpdatedAt ? (
            <span className="font-mono text-[11px] tabular-nums text-dls-secondary/70">
              {t("mcp.last_synced")} {formatRelativeTime(props.lastUpdatedAt)}
            </span>
          ) : null}
          <span className="font-mono text-[11px] tabular-nums text-dls-secondary">
            {props.servers.length.toString().padStart(2, "0")}
          </span>
        </div>
      </div>

      {props.servers.length ? (
        <div className="divide-y divide-dls-border border-y border-dls-border">
          {props.servers.map((entry) => (
            <McpConfiguredServerRow
              key={entry.name}
              entry={entry}
              status={props.resolveStatus(entry)}
              errorInfo={readMcpErrorInfo(props.statuses[entry.name])}
              selected={props.selectedMcp === entry.name}
              busy={props.busy}
              logoutBusy={props.logoutBusy}
              logoutTarget={props.logoutTarget}
              togglingMcp={props.togglingMcp}
              displayName={props.displayName}
              supportsOauth={props.supportsOauth}
              onSelect={props.onSelect}
              onAuthorize={props.onAuthorize}
              onRequestLogout={props.onRequestLogout}
              onRemove={props.onRemove}
              onToggleEnabled={props.onToggleEnabled}
              onToggleBusy={props.onToggleBusy}
              canShareWithFirm={props.canShareWithFirm}
              onShareWithFirm={props.onShareWithFirm}
            />
          ))}
        </div>
      ) : (
        <div className="border-y border-dls-border py-16 text-center">
          <Unplug size={24} className="mx-auto mb-3 text-dls-secondary/30" />
          <div className="text-[14px] font-medium text-dls-secondary">{t("mcp.no_apps_yet")}</div>
          <div className="mt-1 text-[13px] text-dls-secondary/60">{t("mcp.no_apps_hint")}</div>
        </div>
      )}
    </div>
  );
}

function readMcpErrorInfo(status: McpStatusMap[string] | undefined) {
  if (!status || status.status !== "failed") return null;
  return "error" in status ? status.error : t("mcp.connection_failed");
}

function McpConfiguredServerRow(props: {
  entry: McpServerEntry;
  status: ReactMcpStatus;
  errorInfo: string | null;
  selected: boolean;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  displayName: (name: string) => string;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onSelect: (name: string | null) => void;
  onAuthorize: (entry: McpServerEntry) => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
  canShareWithFirm?: boolean;
  onShareWithFirm?: (mcpName: string) => void | Promise<void>;
}) {
  const Icon = serviceIcon(props.entry.name);
  return (
    <div className={`group relative transition-colors ${props.selected ? "bg-dls-hover/40" : "hover:bg-dls-hover/60"}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={props.selected}
        className="w-full py-4 pl-5 pr-3 text-left"
        onClick={() => props.onSelect(props.selected ? null : props.entry.name)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.onSelect(props.selected ? null : props.entry.name);
        }}
      >
        <div className="flex items-center gap-4">
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${props.status === "connected" ? "border-green-6 bg-green-3" : serviceIconBg(props.entry.name)}`}>
            <Icon size={16} className={props.status === "connected" ? "text-green-11" : serviceColor(props.entry.name)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{props.displayName(props.entry.name)}</div>
          </div>
          {props.canShareWithFirm && props.onShareWithFirm ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={(event) => {
                event.stopPropagation();
                void props.onShareWithFirm?.(props.entry.name);
              }}
              title={t("firm_hub.share_with_firm")}
            >
              <Share2 size={13} />
              Share
            </Button>
          ) : null}
          <div className="flex shrink-0 items-center gap-2">
            <div className={`size-1.5 rounded-full ${statusDot(props.status)}`} />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dls-secondary/70">{friendlyStatus(props.status)}</span>
          </div>
          <div className={`transition-transform ${props.selected ? "rotate-180" : ""}`}>
            <ChevronDown size={14} className="text-dls-secondary/40" />
          </div>
        </div>
      </div>

      {props.selected ? <McpConfiguredServerDetails {...props} /> : null}
    </div>
  );
}

function McpConfiguredServerDetails(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  return (
    <div className="animate-in fade-in slide-in-from-top-1 space-y-3 border-t border-dls-border pb-4 pl-5 pr-3 pt-3 duration-200">
      <div className="flex items-center gap-4 text-xs">
        <span className="text-dls-secondary">{t("mcp.connection_type")}</span>
        <span className="text-dls-text">{props.entry.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
          {t("mcp.cap_tools")}
        </span>
        {props.entry.config.type === "remote" ? (
          <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
            {t("mcp.cap_signin")}
          </span>
        ) : null}
      </div>
      {props.errorInfo ? <div className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11">{props.errorInfo}</div> : null}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-dls-secondary transition-colors hover:text-dls-text">
          <Code2 size={11} />
          {t("mcp.technical_details")}
          <ChevronDown size={10} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-1.5 break-all rounded-lg bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">
          {props.entry.config.type === "remote" ? props.entry.config.url : props.entry.config.command?.join(" ")}
        </div>
      </details>
      <McpConfiguredServerAuthActions {...props} />
      <div className="flex justify-end gap-2 pt-1">
        {props.onToggleEnabled && props.entry.source !== "config.global" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={props.busy || props.togglingMcp === props.entry.name}
            onClick={(event) => {
              event.stopPropagation();
              if (props.togglingMcp) return;
              const next = props.entry.config.enabled !== false ? false : true;
              props.onToggleBusy(props.entry.name);
              void Promise.resolve(props.onToggleEnabled?.(props.entry.name, next)).finally(() => props.onToggleBusy(null));
            }}
          >
            <Power size={13} />
            {props.entry.config.enabled === false ? t("mcp.enable_app") : t("mcp.disable_app")}
          </Button>
        ) : null}
        <Button
          variant="destructive"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove(props.entry.name);
          }}
        >
          {t("mcp.remove_app")}
        </Button>
      </div>
    </div>
  );
}

function McpConfiguredServerAuthActions(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  if (!props.supportsOauth(props.entry)) return null;
  if (props.status !== "connected") {
    return (
      <>
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-xs text-dls-secondary">{t("mcp.logout_label")}</div>
          <Button size="sm" disabled={props.busy} onClick={() => props.onAuthorize(props.entry)}>
            {t("mcp.login_action")}
          </Button>
        </div>
        <div className="text-[11px] text-dls-secondary/70">{t("mcp.login_hint")}</div>
      </>
    );
  }
  return (
    <>
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-xs text-dls-secondary">{t("mcp.logout_label")}</div>
        <Button
          variant="destructive"
          size="sm"
          disabled={props.busy || props.logoutBusy}
          onClick={() => props.onRequestLogout(props.entry.name)}
        >
          {props.logoutBusy && props.logoutTarget === props.entry.name ? t("mcp.logout_working") : t("mcp.logout_action")}
        </Button>
      </div>
      <div className="text-[11px] text-dls-secondary/70">{t("mcp.logout_hint")}</div>
    </>
  );
}

function McpAdvancedConfigSection(props: {
  open: boolean;
  configScope: ConfigScope;
  activeConfig: OpencodeConfigFile | null;
  canRevealConfig: boolean;
  revealBusy: boolean;
  revealLabel: string;
  configError: string | null;
  onToggle: () => void;
  onScopeChange: (scope: ConfigScope) => void;
  onReveal: () => Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-dls-border bg-dls-surface">
      <button type="button" className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-dls-hover" onClick={props.onToggle}>
        <div className="flex items-center gap-3">
          <Settings2 size={16} className="text-dls-secondary" />
          <div className="text-left">
            <div className="text-sm font-medium text-dls-text">{t("mcp.advanced_settings")}</div>
            <div className="text-xs text-dls-secondary">{t("mcp.advanced_settings_hint")}</div>
          </div>
        </div>
        <div className={`transition-transform ${props.open ? "rotate-180" : ""}`}>
          <ChevronDown size={16} className="text-dls-secondary" />
        </div>
      </button>
      {props.open ? (
        <div className="animate-in fade-in slide-in-from-top-1 space-y-4 border-t border-dls-border px-5 py-4 duration-200">
          <div className="flex items-center gap-1.5">
            <McpConfigScopeButton scope="project" activeScope={props.configScope} onScopeChange={props.onScopeChange} />
            <McpConfigScopeButton scope="global" activeScope={props.configScope} onScopeChange={props.onScopeChange} />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <div className="text-dls-secondary">{t("mcp.config_file")}</div>
            <div className="truncate font-mono text-[11px] text-dls-secondary/80">
              {props.activeConfig?.path ?? t("mcp.config_not_loaded")}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void props.onReveal()} disabled={!props.canRevealConfig}>
                {props.revealBusy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t("mcp.opening_label")}
                  </>
                ) : (
                  <>
                    <FolderOpen size={14} />
                    {props.revealLabel}
                  </>
                )}
              </Button>
            </div>
            {props.activeConfig && props.activeConfig.exists === false ? <div className="text-[11px] text-dls-secondary">{t("mcp.file_not_found")}</div> : null}
          </div>
          {props.configError ? <div className="text-xs text-red-11">{props.configError}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function McpConfigScopeButton(props: {
  scope: ConfigScope;
  activeScope: ConfigScope;
  onScopeChange: (scope: ConfigScope) => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        props.activeScope === props.scope
          ? "bg-dls-active text-dls-text"
          : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
      }`}
      onClick={() => props.onScopeChange(props.scope)}
    >
      {props.scope === "project" ? t("mcp.scope_project") : t("mcp.scope_global")}
    </button>
  );
}

export default McpView;
