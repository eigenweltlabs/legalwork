/** @jsxImportSource react */
import { packageParts } from "./plugin-package-contents";
import { IntegrationAddMenu, IntegrationMoreMenu, IntegrationLibraryRow, IntegrationLibraryHeader, IntegrationSearch, IntegrationGroupHeading, IntegrationEmptyState, useIntegrationAddRequest, useIntegrationLibraryLayout } from "./integration-library";
import { useEffect, useState, type SetStateAction } from "react";
import { connectorDefinitions } from "@legalwork/types/connectors";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cloud,
  Code2,
  CreditCard,
  Globe,
  Loader2,
  MonitorSmartphone,
  Plug2,
  Plus,
  Search,
  Share2,
  Unplug,
  Zap,
} from "lucide-react";

import { isBuiltInLegalWorkExtension, getMcpServerName, type ExtensionKind, type McpDirectoryInfo } from "../../../../app/constants";
import { evaluateEnablement } from "../../../../app/enablement";
import { isTrustedBuiltInExtension, type EnablementResult } from "../../../../app/extensions";
import type { ImportedPlugin } from "../../../../app/lib/extension-imports";
import { ExtensionDetailModal } from "../../../design-system/extension-detail-modal";
import { resolveBrandIconSrc } from "../../../design-system/extension-icon-src";
import { ExtensionMeshAvatar } from "../../../design-system/extension-mesh-avatar";
import {
  openDesktopUrl,
  revealDesktopItemInDir,
} from "../../../../app/lib/desktop";
import {
  getMcpIdentityKey,
  normalizeMcpSlug,
} from "../../../../app/mcp";
import type { McpMigrationStatus, McpServerEntry, McpStatusMap } from "../../../../app/types";
import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { mcpMigrationStatus } from "@/app/mcp-connect-state";
import { importedConnectorPlugin, pluginImportConnectorName, pluginImportName } from "./plugin-import-presentation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import type { LegalworkMcpProbeResult, LegalworkMcpRegisterClientResult } from "../../../../app/lib/legalwork-server";
import { McpConnectorSetupModal } from "../../connections/modals/mcp-connector-setup-modal";
import {
  isLegalWorkExtensionEnabled,
  isLegalWorkExtensionHidden,
  LEGALWORK_EXTENSION_STATE_CHANGED,
  setLegalWorkExtensionEnabled,
  setLegalWorkExtensionHidden,
} from "../extension-state";
import { HubScopeToggle, useHubScope } from "./hub-scope-context";
import { orgPolicyAllows, orgPolicyOffText, useOrgPolicyForbids } from "../../connections/org-policy";
import { OrgPolicyNote } from "../../connections/org-policy-ui";
import { HubTabs, type HubTab } from "../segmented-tabs";
import type { FirmHubItem } from "@legalwork/types/firm-hub";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { FirmConnectorLibrary, FirmConnectorRow, firmConnectorName } from "./firm-connectors";
import { ConnectorStatus, McpMigrationRecovery, configuredConnectorState, type ConnectorState } from "./connector-status";
import { connectorUsesOAuth } from "@legalwork/types/connector-config";
import { connectorNeedsSetup } from "@/app/mcp-configuration";
import { McpConfigurationForm } from "../../connections/modals/mcp-configuration-form";

export type ReactMcpStatus = ConnectorState;

export type SkillItem = {
  name: string;
  description?: string;
  trigger?: string;
  path: string;
};

const getSkillHiddenId = (skill: SkillItem) => `skill:${skill.name}`;

export type McpViewProps = {
  /** Reuse connector setup within a plugin without mounting another library. */
  detailsOnly?: boolean;
  pluginName?: string;
  busy: boolean;
  selectedWorkspaceRoot: string;
  workspaceKey?: string;
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
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (name: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => boolean | void | Promise<boolean | void>;
  /** Check how a remote MCP server signs in before it is added (custom connectors). */
  probeMcp?: (url: string, headers?: Record<string, string>) => Promise<LegalworkMcpProbeResult>;
  /** Register with the sign-in provider when a custom connector is added with automatic OAuth. */
  registerMcpClient?: (url: string, headers?: Record<string, string>) => Promise<LegalworkMcpRegisterClientResult>;
  cancelPendingMcpAuth?: () => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  retryMcpMigration?: (name: string) => Promise<unknown>;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  /** Return extension-specific config UI for the detail modal. */
  configSlotForEntry?: (entry: McpDirectoryInfo) => React.ReactNode | null;
  /** Check if an extension-kind entry is connected/active. */
  isExtensionConnected?: (entry: McpDirectoryInfo) => boolean;
  /** Enablement context for evaluating extension active state. */
  enablementContext?: import("../../../../app/enablement").EnablementContext;
  /** Whether the firm's policy switched off a LegalWork-provided built-in extension. */
  builtInExtensionDisabled?: (entry: McpDirectoryInfo) => boolean;
  /** Firm Hub: share an MCP server entry org-wide (gated on admin_hub). */
  canShareWithFirm?: boolean;
  onShareWithFirm?: (mcpName: string, displayName?: string) => void | Promise<void>;
  /** Firm Hub: "download integrations shared with your firm" section (self-gating). */
  firmDownloadView?: React.ReactNode;
  /** Team connectors join the configured library with their hub-owned controls. */
  firmClient?: LegalworkServerClient | null;
  onFirmConfigApplied?: () => void;
  /** Opens the multi-select "Share with your firm" dialog (Team scope only). */
  onOpenTeamShare?: () => void;
};

const builtInExtensionDisabledReason = "Disabled by organization";

// Reference-style connector cards: soft-bordered tiles in a 2-column grid with
// mono type tags and quiet secondary text — shares the surface language with the
// Workflows card grid (no accent bars).
const quickCardClass =
  "group relative flex cursor-pointer flex-col rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-foreground/20 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const quickCardFeaturedClass =
  "border-foreground/20 bg-muted/20";
const featuredTagClass =
  "shrink-0 rounded-full bg-[rgba(var(--dls-accent-rgb),0.12)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-dls-accent";
const typeTagClass = "shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-dls-secondary/70";
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

// Inline brand icon for ledger rows — reproduces ExtensionCard's icon resolution
// (direct iconSrc → bundled Simple Icons slug → MarbleAvatar fallback) without
// importing the card component itself.
function LedgerBrandIcon(props: {
  name: string;
  iconSlug?: string;
  iconSrc?: string;
  kind: ExtensionKind;
  connecting?: boolean;
}) {
  const resolvedIconSrc = resolveBrandIconSrc(props.iconSrc, props.iconSlug);
  return (
    <div className="flex size-9 shrink-0 items-center justify-center">
      {props.connecting ? (
        <Loader2 size={16} className="animate-spin text-dls-secondary" />
      ) : resolvedIconSrc ? (
        <img src={resolvedIconSrc} alt="" width={24} height={24} loading="lazy" className="block size-6 object-contain" />
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

// A browsing category only; enablement and organization policy retain their own checks.
const isDirectoryTool = (entry: McpDirectoryInfo) => entry.kind === "ui-control" || isTrustedBuiltInExtension(entry.extensionManifest);

type ExtensionFilter = "all" | "mcp" | "builtin" | "skill" | "plugin";

export function McpView(props: McpViewProps) {
  const libraryLayout = useIntegrationLibraryLayout();
  const importedPackages = libraryLayout?.importedPackages;
  const connectorsForbidden = useOrgPolicyForbids("connectors.allowCustom");
  const policyDisabled = (entry: McpDirectoryInfo) => isBuiltInLegalWorkExtension(entry) && props.builtInExtensionDisabled?.(entry) === true;
  const [detailEntry, setDetailEntry] = useState<McpDirectoryInfo | null>(null);
  const [setupEntry, setSetupEntry] = useState<McpDirectoryInfo | null>(null);
  const [detailSkill, setDetailSkill] = useState<SkillItem | null>(null);
  const [detailSkillContent, setDetailSkillContent] = useState<string | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<ImportedPlugin | null>(null);
  const [legalworkUiMcpCommand, setLegalworkUiMcpCommand] = useState<string[] | null>(null);
  const [legalworkUiMcpEnvironment, setLegalworkUiMcpEnvironment] = useState<Record<string, string> | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  useEffect(() => {
    if (libraryLayout?.directoryRequest) setDirectoryOpen(true);
  }, [libraryLayout?.directoryRequest]);
  useEffect(() => { if (libraryLayout?.addRequest || libraryLayout?.customPluginOpen) setDirectoryOpen(false); }, [libraryLayout?.addRequest, libraryLayout?.customPluginOpen]);
  const [detailsFromDirectory, setDetailsFromDirectory] = useState(false);
  const [localLibrarySearch, setLibrarySearch] = useState("");
  const librarySearch = libraryLayout?.pluginSearch ?? localLibrarySearch;
  useEffect(() => {
    const name = libraryLayout?.connectorToOpen;
    if (!name || !props.mcpServers.some(entry => entry.name === name)) return;
    setLibrarySearch("");
    props.setSelectedMcp(name);
    libraryLayout.onConnectorOpened?.();
  }, [libraryLayout?.connectorToOpen, libraryLayout?.onConnectorOpened, props.mcpServers, props.setSelectedMcp]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const directoryFilters: HubTab<ExtensionFilter>[] = [
    { id: "all", label: t("mcp.filter_all") },
    { id: "mcp", label: t("integrations.services") },
    { id: "builtin", label: t("integrations.builtin_tools") },
  ];
  if (props.installedSkills?.length) directoryFilters.push({ id: "skill", label: t("mcp.filter_skills") });
  useEffect(() => {
    setSetupEntry(null);
    setDirectoryOpen(false);
    setLibrarySearch("");
    setSearch("");
  }, [props.workspaceKey, props.selectedWorkspaceRoot]);
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

  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutTarget, setLogoutTarget] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [addMcpModalOpen, setAddMcpModalOpen] = useState(false);
  const [togglingMcp, setTogglingMcp] = useState<string | null>(null);
  const managedAdd = useIntegrationAddRequest("connector", async () => {
    setDirectoryOpen(false);
    if (props.busy || connectorsForbidden || !showLocal) return;
    if (await orgPolicyAllows("connectors.allowCustom")) setAddMcpModalOpen(true);
  });

  const quickConnectList = props.quickConnect.filter((entry) => !connectorDefinitions.some((provider) => provider.kind === "files" && provider.id === entry.id));

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
      } catch {
        setLegalworkUiMcpCommand(null);
        setLegalworkUiMcpEnvironment(null);
      }
    })();
  }, []);

  const resolveQuickConnectMatch = (name: string) =>
    quickConnectList.find((candidate) => {
      const candidateKey = getMcpIdentityKey(candidate);
      return (
        candidateKey === name ||
        candidate.name === name ||
        normalizeMcpSlug(candidate.name) === name
      );
    });

  const displayName = (name: string) => resolveQuickConnectMatch(name)?.name ?? pluginImportConnectorName(name);

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

  const isEntryConfigured = (entry: McpDirectoryInfo) => {
    if (policyDisabled(entry)) return false;
    const enablement = enablementForEntry(entry);
    if (enablement) return enablement.active;
    if (isToggleOnlyExtension(entry)) return isLegalWorkExtensionEnabled(entry);
    if (entry.kind === "extension" && !isMcpBackedExtension(entry)) return props.isExtensionConnected?.(entry) ?? false;
    return isQuickConnectConfigured(entry);
  };

  const libraryQuery = librarySearch.trim().toLocaleLowerCase();
  const matchesLibrary = (name: string, description?: string) =>
    `${name} ${description ?? ""}`.toLocaleLowerCase().includes(libraryQuery);
  const libraryServers = props.mcpServers.filter(entry => {
    const owner = importedConnectorPlugin(entry.name, importedPackages);
    return !(libraryLayout?.pluginSearch !== undefined && owner) && matchesLibrary(`${displayName(entry.name)} ${owner ? pluginImportName(owner) : ""}`, resolveQuickConnectMatch(entry.name)?.description);
  });
  const libraryEntries = quickConnectList.filter(entry =>
    !isQuickConnectConfigured(entry) && isEntryConfigured(entry) && !isLegalWorkExtensionHidden(entry) && matchesLibrary(entry.name, entry.description));
  const openEntryDetails = (entry: McpDirectoryInfo) => {
    setDetailsFromDirectory(directoryOpen);
    setDirectoryOpen(false);
    setDetailEntry(entry);
  };

  const launchCommandForEntry = (entry: McpDirectoryInfo) => {
    if (entry.serverName === "legalwork-ui") return legalworkUiMcpCommand ?? undefined;
    return entry.command;
  };

  const supportsOauth = (entry: McpServerEntry) =>
    connectorUsesOAuth(entry.config);

  const resolveStatus = (entry: McpServerEntry): ReactMcpStatus => {
    return configuredConnectorState(entry, props.mcpStatuses[entry.name]);
  };

  const hiddenCount = quickConnectList.filter((entry) => isLegalWorkExtensionHidden(entry)).length +
    (props.installedSkills ?? []).filter((skill) => isLegalWorkExtensionHidden(getSkillHiddenId(skill))).length +
    (props.installedPlugins ?? []).filter((plugin) => isLegalWorkExtensionHidden(`plugin:${plugin.pluginId}`)).length;
  const policyHiddenBuiltInCount = quickConnectList.filter((entry) => policyDisabled(entry) && !isLegalWorkExtensionHidden(entry)).length;
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

  const logoutConfirmation = (
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
  );
  if (props.detailsOnly) {
    const entry = props.mcpServers.find(item => item.name === props.selectedMcp);
    return <>
      {entry ? <McpConfiguredServerDetails entry={entry} directoryEntry={resolveQuickConnectMatch(entry.name)} status={resolveStatus(entry)} errorInfo={readMcpErrorInfo(props.mcpStatuses[entry.name])} migration={mcpMigrationStatus(props.mcpStatuses[entry.name])} onRetryMigration={props.retryMcpMigration} selected busy={props.busy} logoutBusy={logoutBusy} logoutTarget={logoutTarget} togglingMcp={togglingMcp} displayName={displayName} supportsOauth={supportsOauth} onSelect={props.setSelectedMcp} onAuthorize={props.authorizeMcp} onConfigure={props.connectMcp} onCancelSetup={props.cancelPendingMcpAuth} onRequestLogout={requestLogout} onRemove={props.removeMcp} onToggleEnabled={props.setMcpEnabled} onToggleBusy={setTogglingMcp} pluginName={props.pluginName} /> : <Dialog open onOpenChange={open => { if (!open) props.setSelectedMcp(null); }}><DialogContent><DialogHeader><DialogTitle>{t("extensions.connectors_label")}</DialogTitle><DialogDescription>{t("plugin_details.unavailable")}</DialogDescription></DialogHeader><Button variant="outline" onClick={() => props.setSelectedMcp(null)}><ArrowLeft />{t("plugin_details.back", { name: props.pluginName ?? "" })}</Button></DialogContent></Dialog>}
      {logoutConfirmation}
    </>;
  }

  return (
    <section className="space-y-6 max-w-5xl w-full animate-in fade-in duration-300">
      <div className="space-y-5 empty:hidden">
        <IntegrationLibraryHeader title={t("extensions.connectors_label")} description={t("integrations.connectors_description")} leadingActions={showLocal ? <Button variant="outline" size="sm" disabled={props.busy} onClick={() => setDirectoryOpen(true)}>{t("mcp.browse_directory")}</Button> : undefined} actions={showLocal ? <>
          {!managedAdd ? <IntegrationAddMenu disabled={props.busy} actions={[
            { label: t("mcp.add_modal_title"), icon: Plus, disabled: connectorsForbidden, onClick: async () => { if (await orgPolicyAllows("connectors.allowCustom")) setAddMcpModalOpen(true); } },
          ]} /> : null}
          <IntegrationMoreMenu busy={props.busy} />
        </> : undefined} />
        <OrgPolicyNote policyKey="connectors.allowCustom" />

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

        {showLocal ? <IntegrationSearch toolbar value={librarySearch} onChange={setLibrarySearch} label={t("mcp.search_connectors")} /> : null}
      </div>

      {showTeam ? props.firmDownloadView : null}

      {showLocal ? (
      <>
      {props.mcpStatus ? (
        <div className="whitespace-pre-wrap wrap-break-word rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {props.mcpStatus}
        </div>
      ) : null}

      {quickConnectList.some(policyDisabled) ? (
        <div className="rounded-[20px] border border-amber-6 bg-amber-2 px-5 py-4 text-[13px] text-amber-11">
          {t("mcp.builtins_blocked")}
        </div>
      ) : null}

      <McpConfiguredServersSection
        firmClient={props.firmClient}
        onFirmConfigApplied={props.onFirmConfigApplied}
        search={librarySearch}
        servers={libraryServers}
        entries={libraryEntries}
        searching={libraryQuery.length > 0}
        directoryEntry={resolveQuickConnectMatch}
        onEntryDetail={openEntryDetails}
        statuses={props.mcpStatuses}
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
        onRetryMigration={props.retryMcpMigration}
        onConfigure={props.connectMcp}
        onCancelSetup={props.cancelPendingMcpAuth}
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

      <Dialog open={directoryOpen} onOpenChange={setDirectoryOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-3rem)] flex-col gap-5 bg-background sm:max-w-4xl">
          <DialogHeader className="shrink-0 pe-8">
            <DialogTitle>{t("mcp.directory_title")}</DialogTitle>
            <DialogDescription>{t("mcp.directory_description")}</DialogDescription>
          </DialogHeader>
          <div className="shrink-0 space-y-3">
            <div className="flex items-center gap-3">
              <div className="relative min-w-0 flex-1">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dls-secondary" />
              <Input autoFocus className="ps-10" aria-label={t("mcp.search_directory")} placeholder={t("mcp.search_directory")} value={search} onChange={event => setSearch(event.target.value)} />
              </div>
              {libraryLayout?.directoryActions ? <div className="shrink-0">{libraryLayout.directoryActions}</div> : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
              <HubTabs items={directoryFilters} value={filter} onChange={setFilter} label={t("mcp.directory_title")} />
              <button
                type="button"
                onClick={() => setShowHidden((current) => !current)}
                className={
                  showHidden
                    ? "font-medium text-dls-text transition-colors"
                    : "text-dls-secondary transition-colors hover:text-dls-text"
                }
              >
                {showHidden
                  ? t("mcp.showing_hidden")
                  : hiddenOrPolicyCount > 0
                    ? t("mcp.show_hidden_count", { count: hiddenOrPolicyCount })
                    : t("mcp.show_hidden")}
              </button>
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto pe-1">
            <McpQuickConnectSection
              entries={
                quickConnectList.filter((entry) => {
                  if (!showHidden && (isLegalWorkExtensionHidden(entry) || (policyDisabled(entry)))) return false;
                  if (filter === "skill") return false;
                  if (filter === "mcp" && isDirectoryTool(entry)) return false;
                  if (filter === "builtin" && !isDirectoryTool(entry)) return false;
                  if (!search.trim()) return true;
                  const q = search.toLowerCase();
                  return entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
                })
              }
              installedSkills={
                (props.installedSkills ?? []).filter((skill) => {
                  if (!showHidden && isLegalWorkExtensionHidden(getSkillHiddenId(skill))) return false;
                  if (filter === "mcp" || filter === "builtin") return false;
                  if (!search.trim()) return true;
                  const q = search.toLowerCase();
                  return skill.name.toLowerCase().includes(q) || (skill.description ?? "").toLowerCase().includes(q);
                })
              }
              installedPlugins={
                (props.installedPlugins ?? []).filter((plugin) => {
                  if (!showHidden && isLegalWorkExtensionHidden(`plugin:${plugin.pluginId}`)) return false;
                  if (filter === "mcp" || filter === "builtin" || filter === "skill") return false;
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
                policyDisabled(entry)
                  ? builtInExtensionDisabledReason
                  : connectorsForbidden && !isBuiltInLegalWorkExtension(entry) && entry.kind !== "ui-control"
                    ? orgPolicyOffText("connectors.allowCustom")
                    : null
              }
              isConfigured={isEntryConfigured}
              enablementForEntry={props.enablementContext ? enablementForEntry : undefined}
              statusForEntry={quickConnectStatus}
              onConnect={props.connectMcp}
              onDetail={openEntryDetails}
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
          </div>
        </DialogContent>
      </Dialog>

      </>
      ) : null}

      {logoutConfirmation}

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
        onProbe={props.probeMcp}
        onRegisterClient={props.registerMcpClient}
        busy={props.busy}
        isRemoteWorkspace={props.isRemoteWorkspace}
      />

      <McpConnectorSetupModal
        entry={setupEntry}
        open={Boolean(setupEntry)}
        onClose={() => setSetupEntry(null)}
        onCancel={props.cancelPendingMcpAuth}
        onConnect={props.connectMcp}
      />

      {detailEntry ? (() => {
        const extensionConfigSlot = props.configSlotForEntry?.(detailEntry) ?? null;
        const hasConfigSlot = extensionConfigSlot !== null;
        const hidden = isLegalWorkExtensionHidden(detailEntry);
        const disabledReason = policyDisabled(detailEntry)
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
        const isNativeConnector = connectorDefinitions.some((connector) => connector.id === detailEntry.id);
        return (
          <ExtensionDetailModal
            open={!!detailEntry}
            onClose={() => { setDetailEntry(null); if (detailsFromDirectory) setDirectoryOpen(true); }}
            name={detailEntry.name}
            description={detailEntry.description}
            setupNote={detailEntry.setupNote}
            brandWordmark={detailEntry.brandWordmark}
            learnMoreUrl={detailEntry.learnMoreUrl}
            iconSlug={detailEntry.iconSlug}
            iconSrc={detailEntry.iconSrc}
            fallbackIcon={serviceIcon(detailEntry.name)}
            kind={detailEntry.kind ?? "mcp"}
            presentation={isNativeConnector ? "connector" : "default"}
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
            configSlotFirst={detailEntry.id === "open-computer-use"}
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
            description={detailSkill.description ?? t("mcp.installed_skill")}
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
            description={detailPlugin.description ?? t("mcp.marketplace_installed")}
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
  onShareMcp?: (mcpName: string, displayName?: string) => void | Promise<void>;
  onSkillDetail?: (skill: SkillItem) => void;
  onPluginDetail?: (plugin: ImportedPlugin) => void;
}) {
  const skills = props.installedSkills ?? [];
  const plugins = props.installedPlugins ?? [];
  const totalCount = props.entries.length + skills.length + plugins.length;

  return (
    <div className="space-y-4">
      <IntegrationGroupHeading title={t("mcp.available_apps")} count={totalCount} />

      {totalCount === 0 ? (
        <IntegrationEmptyState icon={Unplug} title={t("mcp.no_extensions_found")} description={t("mcp.no_extensions_hint")} />
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
            const typeLabel = isDirectoryTool(entry) ? t("integrations.builtin_tools") : t("extensions.connectors_label");
            const actionLabel = configured
              ? t("mcp.view_details")
              : entry.requestAccessUrl
                ? t("mcp.request_access")
                : entryNeedsSetup(entry)
                  ? t("mcp.set_up_connect")
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
                  {/* Without a glyph the header row would collapse to the
                      wordmark's own 0.92 line box, which reads as cramped and
                      leaves this card's first row shorter than every other
                      card's. Hold the icon's height and centre the lettering
                      in it. */}
                  <div className={`flex min-w-0 items-center gap-2.5 ${entry.brandWordmark ? "min-h-10" : ""}`}>
                    {/* A product with its own wordmark needs no glyph beside it:
                        the lettering is the mark, and a second one reads as
                        clutter rather than as branding. */}
                    {entry.brandWordmark ? null : (
                      <LedgerBrandIcon
                        name={entry.name}
                        iconSlug={entry.iconSlug}
                        iconSrc={entry.iconSrc}
                        kind={kind}
                        connecting={connecting}
                      />
                    )}
                    {entry.brandWordmark ? (
                      <h4 className="lw-brand-wordmark truncate text-[21px]">{entry.name.toUpperCase()}</h4>
                    ) : (
                      <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{entry.name}</h4>
                    )}
                  </div>
                  {configured ? (
                    <CheckCircle2 size={16} className="mt-1 shrink-0 text-green-9" />
                  ) : someMet ? (
                    <CircleAlert size={16} className="mt-1 shrink-0 text-amber-9" />
                  ) : null}
                </div>
                <p className={`text-[13px] leading-relaxed text-dls-secondary ${entry.brandWordmark ? "mt-3" : "mt-2"} line-clamp-2`}>{entry.description}</p>
                {disabledReason ? (
                  <p className="mt-1.5 text-[12px] font-medium text-amber-11">{disabledReason}</p>
                ) : null}
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {configured ? (
                      <ConnectorStatus state="connected" />
                    ) : someMet ? (
                      <ConnectorStatus state="needs_auth" />
                    ) : (
                      <span className="text-xs text-muted-foreground">{typeLabel}</span>
                    )}
                    {hidden ? <span className={typeTagClass}>Hidden</span> : null}
                    {entry.featured ? <span className={featuredTagClass}>{t("mcp.quick_connect_featured")}</span> : null}
                    {entry.preview ? <span className={typeTagClass}>{t("extension_card.preview")}</span> : null}
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
                <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">{skill.description ?? t("mcp.installed_skill")}</p>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={typeTagClass}>Skill</span>
                    {hidden ? <span className={typeTagClass}>Hidden</span> : null}
                  </div>
                  <span className="shrink-0 text-[12px] font-medium text-dls-secondary transition-colors group-hover:text-dls-text">{t("mcp.view_details")}</span>
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
                  <span className="shrink-0 text-[12px] font-medium text-dls-secondary transition-colors group-hover:text-dls-text">{t("mcp.view_details")}</span>
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
  firmClient?: LegalworkServerClient | null;
  onFirmConfigApplied?: () => void;
  search: string;
  servers: McpServerEntry[];
  entries: McpDirectoryInfo[];
  searching: boolean;
  directoryEntry: (name: string) => McpDirectoryInfo | undefined;
  onEntryDetail: (entry: McpDirectoryInfo) => void;
  statuses: McpStatusMap;
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
  onRetryMigration?: McpViewProps["retryMcpMigration"];
  onConfigure: McpViewProps["connectMcp"];
  onCancelSetup?: () => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
  canShareWithFirm?: boolean;
  onShareWithFirm?: (mcpName: string, displayName?: string) => void | Promise<void>;
}) {
  const layout = useIntegrationLibraryLayout();
  const source = layout?.source ?? "all";
  const hasPluginResults = layout?.pluginSearch !== undefined && source !== "team" && layout.importedPackages?.some(plugin => (plugin.sourceKind === undefined || plugin.sourceKind === "plugin") && `${pluginImportName(plugin)} ${plugin.description ?? ""} ${packageParts(plugin.files.map(file => file.objectType))}`.toLowerCase().includes(props.search.trim().toLowerCase()));
  const renderLibrary = (firmItems: FirmHubItem[]) => {
    const query = props.search.trim().toLowerCase();
    const matchingFirmItems = firmItems.filter(item => !query || `${item.name} ${firmConnectorName(item.name)} ${item.description}`.toLowerCase().includes(query));
    const firmServerNames = new Set(firmItems.flatMap(item => item.connector && (item.installation === "automatic" || item.added) ? [item.connector.serverName] : []));
    type ConnectorRow = { kind: "server"; item: McpServerEntry } | { kind: "entry"; item: McpDirectoryInfo } | { kind: "firm"; item: FirmHubItem };
    const rows: ConnectorRow[] = [
      ...(source === "team" ? [] : props.servers.filter(item => !firmServerNames.has(item.name))).map((item): ConnectorRow => ({ kind: "server", item })),
      ...(source === "team" ? [] : props.entries).map((item): ConnectorRow => ({ kind: "entry", item })),
      ...(source === "personal" ? [] : matchingFirmItems).map((item): ConnectorRow => ({ kind: "firm", item })),
    ];
    const priority = (row: ConnectorRow) => {
      if (row.kind === "entry") return 0;
      if (row.kind === "firm") {
        if (row.item.installation !== "automatic" && !row.item.added) return 2;
        return row.item.connector && props.statuses[row.item.connector.serverName]?.status === "connected" ? 0 : 1;
      }
      const status = props.resolveStatus(row.item);
      return status === "connected" ? 0 : status === "disabled" ? 2 : 1;
    };
    rows.sort((a, b) => priority(a) - priority(b));
    return (
      <div className="space-y-4">
        <IntegrationGroupHeading hideInLibrary title={t("mcp.your_apps")} count={rows.length} />

        {rows.length ? (
          <div className="space-y-1">
            {rows.map(row => {
              if (row.kind === "firm") return props.firmClient ? <FirmConnectorRow key={`firm:${row.item.id}`} item={row.item} client={props.firmClient} statuses={props.statuses} busy={props.busy} onChanged={props.onFirmConfigApplied} onRetryMigration={props.onRetryMigration} onSignIn={(name, url) => props.onAuthorize({ name, config: { type: "remote", url } })} /> : null;
              if (row.kind === "entry") return <McpConnectedToolRow key={`entry:${getMcpIdentityKey(row.item)}`} entry={row.item} busy={props.busy} onDetail={props.onEntryDetail} />;
              const entry = row.item;
              return (
                <McpConfiguredServerRow
                  key={entry.name}
                  entry={entry}
                  directoryEntry={props.directoryEntry(entry.name)}
                  status={props.resolveStatus(entry)}
                  errorInfo={readMcpErrorInfo(props.statuses[entry.name])}
                  migration={mcpMigrationStatus(props.statuses[entry.name])}
                  selected={props.selectedMcp === entry.name}
                  busy={props.busy}
                  logoutBusy={props.logoutBusy}
                  logoutTarget={props.logoutTarget}
                  togglingMcp={props.togglingMcp}
                  displayName={props.displayName}
                  supportsOauth={props.supportsOauth}
                  onSelect={props.onSelect}
                  onAuthorize={props.onAuthorize}
                  onRetryMigration={props.onRetryMigration}
                  onConfigure={props.onConfigure}
                  onCancelSetup={props.onCancelSetup}
                  onRequestLogout={props.onRequestLogout}
                  onRemove={props.onRemove}
                  onToggleEnabled={props.onToggleEnabled}
                  onToggleBusy={props.onToggleBusy}
                  canShareWithFirm={props.canShareWithFirm}
                  onShareWithFirm={props.onShareWithFirm}
                />
              );
            })}
          </div>
        ) : hasPluginResults ? null : (
          <IntegrationEmptyState icon={Unplug} title={t(props.searching ? layout?.pluginSearch !== undefined ? "integrations.no_plugin_matches" : "mcp.no_connector_matches" : source === "team" ? "integrations.no_shared_connectors" : layout?.pluginSearch !== undefined ? "integrations.no_plugins" : "mcp.no_apps_yet")} description={props.searching ? t("mcp.connector_search_hint") : source === "team" ? undefined : t("mcp.no_apps_hint")} />
        )}
      </div>
    );
  };
  return props.firmClient ? <FirmConnectorLibrary client={props.firmClient}>{renderLibrary}</FirmConnectorLibrary> : renderLibrary([]);
}

function McpConnectedToolRow(props: { entry: McpDirectoryInfo; busy: boolean; onDetail: (entry: McpDirectoryInfo) => void }) {
  const entry = props.entry;
  return <IntegrationLibraryRow name={entry.name} description={entry.description} busy={props.busy} onOpen={() => props.onDetail(entry)}
    icon={<LedgerBrandIcon name={entry.name} iconSlug={entry.iconSlug} iconSrc={entry.iconSrc} kind={entry.kind ?? "mcp"} />}
    actions={isToggleOnlyExtension(entry) ? <DropdownMenuItem onClick={() => setLegalWorkExtensionEnabled(entry, false)}>{t("mcp.disable_app")}</DropdownMenuItem> : undefined} />;
}

function readMcpErrorInfo(status: McpStatusMap[string] | undefined) {
  if (status?.status === "connecting" && status.migration) return status.message ?? null;
  if (!status || status.status !== "failed") return null;
  return "error" in status ? status.error : t("mcp.connection_failed");
}

function McpConfiguredServerRow(props: {
  entry: McpServerEntry;
  directoryEntry: McpDirectoryInfo | undefined;
  status: ReactMcpStatus;
  errorInfo: string | null;
  migration?: McpMigrationStatus;
  selected: boolean;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  displayName: (name: string) => string;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onSelect: (name: string | null) => void;
  onAuthorize: (entry: McpServerEntry) => void;
  onRetryMigration?: McpViewProps["retryMcpMigration"];
  onConfigure: McpViewProps["connectMcp"];
  onCancelSetup?: () => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
  canShareWithFirm?: boolean;
  onShareWithFirm?: (mcpName: string, displayName?: string) => void | Promise<void>;
  pluginName?: string;
}) {
  const owner = importedConnectorPlugin(props.entry.name, useIntegrationLibraryLayout()?.importedPackages);
  return (
    <>
      <IntegrationLibraryRow name={props.displayName(props.entry.name)} description={props.directoryEntry?.description ?? t("integrations.custom_connector")} source={owner ? t("integrations.plugin_source", { name: pluginImportName(owner) }) : undefined} icon={<McpConfiguredServerIcon {...props} />} busy={props.busy} onOpen={() => props.onSelect(props.entry.name)} status={<ConnectorStatus state={props.status} />}
        onShare={props.canShareWithFirm && props.onShareWithFirm ? () => void props.onShareWithFirm?.(props.entry.name, props.displayName(props.entry.name)) : undefined}
        onRemove={props.entry.source !== "config.global" ? () => props.onRemove(props.entry.name) : undefined} />
      <McpConfiguredServerDetails {...props} />
    </>
  );
}

function McpConfiguredServerIcon(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  const directory = props.directoryEntry;
  const Icon = serviceIcon(props.entry.name);
  return directory ? <LedgerBrandIcon name={directory.name} iconSlug={directory.iconSlug} iconSrc={directory.iconSrc} kind={directory.kind ?? "mcp"} /> :
    <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border"><Icon className="size-4 text-muted-foreground" /></div>;
}

function McpConnectorStatus(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  if (props.onToggleEnabled && props.entry.source !== "config.global" && (props.status === "connected" || props.status === "disabled")) return null;
  return <ConnectorStatus state={props.status} />;
}

function McpConnectorToggle(props: Parameters<typeof McpConfiguredServerRow>[0] & { onSetup?: () => void }) {
  if (!props.onToggleEnabled || props.entry.source === "config.global") return null;
  return <Switch
    checked={props.entry.config.enabled !== false}
    disabled={props.busy || props.togglingMcp !== null}
    aria-label={`${t(props.entry.config.enabled === false ? "mcp.enable_app" : "mcp.disable_app")} ${props.displayName(props.entry.name)}`}
    onCheckedChange={enabled => {
      if (enabled && connectorNeedsSetup(props.entry.config)) { props.onSetup?.(); return; }
      if (props.togglingMcp) return;
      props.onToggleBusy(props.entry.name);
      void Promise.resolve(props.onToggleEnabled?.(props.entry.name, enabled)).finally(() => props.onToggleBusy(null));
    }}
  />;
}

function McpConfiguredServerDetails(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  const [signingIn, setSigningIn] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!props.selected) setEditing(false); }, [props.selected]);
  const needsSetup = connectorNeedsSetup(props.entry.config);
  const signIn = async () => {
    setSigningIn(true);
    try { await props.onAuthorize(props.entry); }
    finally { setSigningIn(false); }
  };
  return <Dialog open={props.selected} onOpenChange={open => { if (!open) props.onSelect(null); }}>
    <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto bg-background">
      <DialogHeader className="pe-6">
        {editing || props.pluginName ? <Button variant="ghost" size="sm" className="-ml-2 mb-2 w-fit max-w-full" onClick={() => editing ? setEditing(false) : props.onSelect(null)}><ArrowLeft className="size-4 shrink-0" /><span className="truncate">{editing ? t("common.back") : t("plugin_details.back", { name: props.pluginName ?? "" })}</span></Button> : null}
        <div className="mb-1 flex items-center gap-3"><McpConfiguredServerIcon {...props} /><DialogTitle>{props.displayName(props.entry.name)}</DialogTitle></div>
        <DialogDescription>{editing ? t("connector_setup.required_hint") : props.directoryEntry?.description ?? t("integrations.connector_details")}</DialogDescription>
      </DialogHeader>
      {editing ? <McpConfigurationForm key={props.entry.name} entry={props.entry} onBack={() => setEditing(false)} onConnect={props.onConfigure} onCancel={props.onCancelSetup} /> : <>
      <div className="divide-y divide-border">
        <div className="flex items-center justify-between gap-4 pb-5">
          <div className="space-y-2"><h3 className="text-sm font-medium">{t("integrations.connector_chat_access")}</h3><McpConnectorStatus {...props} /></div>
          {needsSetup && props.entry.source === "config.remote" && props.onToggleEnabled ? <Button size="sm" disabled={props.busy} onClick={() => setEditing(true)}>{t("connector_setup.action")}</Button> : <McpConnectorToggle {...props} onSetup={() => setEditing(true)} />}
        </div>
        {props.supportsOauth(props.entry) && !needsSetup && !props.migration ? <div className="flex items-center justify-between gap-4 py-5">
          <div className="min-w-0 space-y-1"><h3 className="text-sm font-medium">{t("integrations.connector_account_access")}</h3><p className="text-xs leading-5 text-muted-foreground">{t(props.entry.config.enabled === false && props.onToggleEnabled ? "integrations.connector_enable_signin_hint" : "integrations.connector_account_hint")}</p></div>
          {props.status === "connected" ? <Button variant="outline" size="sm" disabled={props.busy || props.logoutBusy} onClick={() => props.onRequestLogout(props.entry.name)}>{t(props.logoutBusy && props.logoutTarget === props.entry.name ? "mcp.logout_working" : "mcp.logout_action")}</Button> : <Button size="sm" disabled={props.busy || signingIn || props.togglingMcp !== null} onClick={() => void signIn()}>{signingIn ? <Loader2 className="animate-spin" /> : null}{t("mcp.login_action")}</Button>}
        </div> : null}
        {props.entry.source === "config.remote" && props.onToggleEnabled && !needsSetup ? <div className="flex items-center justify-between gap-4 py-4"><span className="text-sm font-medium">{t("connector_setup.settings")}</span><Button variant="outline" size="sm" disabled={props.busy} onClick={() => setEditing(true)}>{t("common.edit")}</Button></div> : null}
        <details className="group pt-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><Code2 className="size-3.5" />{t("mcp.technical_details")}<ChevronDown className="ms-auto size-3.5 transition-transform group-open:rotate-180" /></summary>
          <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground"><p>{t(props.entry.config.type === "remote" ? "integrations.connector_remote" : "integrations.connector_local")}</p><p className="break-all font-mono">{props.entry.config.type === "remote" ? props.entry.config.url : props.entry.config.command?.join(" ")}</p></div>
        </details>
      </div>
      {props.migration ? <McpMigrationRecovery migration={props.migration} message={props.errorInfo} busy={props.busy || signingIn} onRetry={props.onRetryMigration ? () => props.onRetryMigration!(props.entry.name) : undefined} onReconnect={signIn} /> : null}
      {props.errorInfo && !needsSetup && !props.migration ? <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs leading-5 text-destructive">{props.errorInfo}</p> : null}
      {props.entry.source !== "config.global" && !props.pluginName ? <DialogFooter className="justify-start sm:justify-start">
        <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/5 hover:text-destructive" disabled={props.busy} onClick={() => props.onRemove(props.entry.name)}>{t("mcp.remove_app")}</Button>
      </DialogFooter> : null}
      </>}
    </DialogContent>
  </Dialog>;
}

export default McpView;
