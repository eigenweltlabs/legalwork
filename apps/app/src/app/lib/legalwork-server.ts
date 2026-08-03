import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2/client";
import { desktopFetch } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";
import type { ExecResult, OpencodeConfigFile, WorkspaceInfo, WorkspaceList } from "./desktop";
import type { ImportedMarketplace, ImportedPlugin } from "./extension-imports";
import type {
  BenchmarkCatalogResponse,
  BenchmarkCustomTaskInput,
  BenchmarkAnalytics,
  BenchmarkImportResponse,
  BenchmarkImportZipResponse,
  BenchmarkItemDetail,
  BenchmarkRunCreateInput,
  BenchmarkRunDetail,
  BenchmarkRunProgress,
  BenchmarkRunSummary,
  BenchmarkTaskDefinition,
  BenchmarkTaskDocument,
  BenchmarkTaskItem,
  BenchmarkWorkType,
} from "./benchmark-types";

export * from "./benchmark-types";

export type LegalworkServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "legalwork" | "opencode" };
  skillResources?: { read: boolean; write: boolean };
  hub?: {
    skills?: {
      read: boolean;
      install: boolean;
      repo?: { owner: string; name: string; ref: string };
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  sandbox?: { enabled: boolean; backend: "none" | "docker" | "container" };
  proxy?: { opencode: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type LegalworkServerStatus = "connected" | "disconnected" | "limited";

export type LegalworkServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId?: string | null;
  selectedWorkspaceId?: string | null;
  workspace: LegalworkWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type LegalworkRuntimeServiceName = "legalwork-server" | "opencode";

export type LegalworkRuntimeServiceSnapshot = {
  name: LegalworkRuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

export type LegalworkRuntimeSnapshot = {
  ok: boolean;
  orchestrator?: {
    version: string;
    startedAt: number;
  };
  worker?: {
    workspace: string;
    sandboxMode: string;
  };
  upgrade?: {
    status: "idle" | "running" | "failed";
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    operationId: string | null;
    services: LegalworkRuntimeServiceName[];
  };
  services: LegalworkRuntimeServiceSnapshot[];
};

export type LegalworkServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
  hostToken?: string;
  remoteAccessEnabled?: boolean;
};

/** One model from the Eigenwelt platform manifest / sign-in exchange. */
export type EigenweltManifestModel = {
  id: string;
  name?: string;
  contextLength?: number;
  toolCall?: boolean;
  reasoning?: boolean;
};

/** Per-firm daily usage snapshot from the platform (cents, plus a percentage). */
export type EigenweltUsage = {
  dailyAllowanceCents: number;
  dailyRemainingCents: number;
  /** Share of today's allowance consumed, 0–100 (server-computed). */
  dailyUsedPercent: number;
  extraUsageEnabled: boolean;
  prepaidBalanceCents: number;
};

/** Subscription entitlements. OPTIONAL — absent means the free/legacy tier. */
export type EigenweltEntitlements = {
  plan: "plus" | "pro" | null;
  subscriptionStatus: string | null;
  features: string[];
  seats: number;
  usage: EigenweltUsage;
};

export type EigenweltAccountIdentity = {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  orgId: string;
  orgName: string;
};

/** Feature flags the platform may grant (subset the app gates surfaces on). */
export type EigenweltFeature = "admin_hub" | "settings_presets" | "org_management" | "premium_models";

/** App-safe connection view: entitlements + platformURL, never the secret token. */
export type EigenweltEntitlementsView = {
  entitlements: EigenweltEntitlements | null;
  account: EigenweltAccountIdentity | null;
  platformURL: string | null;
  /** Signed in with an Eigenwelt account — independent of the served model list. */
  connected: boolean;
};

/** Payload delivered once "Sign in with Eigenwelt" completes in the browser. */
export type EigenweltSignInPayload = {
  apiKey: string;
  baseURL: string;
  orgId?: string;
  orgName?: string;
  account?: EigenweltAccountIdentity;
  models: EigenweltManifestModel[];
  entitlements?: EigenweltEntitlements;
  /** Short-lived Bearer for the platform hub APIs (~15 min). Secret. */
  platformToken?: string;
  /** Epoch millis when `platformToken` expires; the server refreshes before then. */
  accessTokenExpiresAt?: number;
  /** Long-lived rotating refresh token (secret); persisted server-side only. */
  refreshToken?: string;
  /** Platform origin for hub/billing links, e.g. https://platform.eigenweltlabs.com. */
  platformURL?: string;
};

export type EigenweltSignInWaitResult = EigenweltSignInPayload | { pending: true };

export type EigenweltManifest = {
  baseURL: string;
  models: EigenweltManifestModel[];
};

export type EigenweltHubKind =
  | "skill"
  | "workflow"
  | "mcp"
  | "plugin"
  | "integration"
  | "preset";

/** One shared item in the firm hub (list view — no payload). */
export type EigenweltHubItem = {
  id: string;
  kind: EigenweltHubKind;
  name: string;
  description: string;
  createdByUserId: string;
  version: number;
  updatedAt: string;
  /** Platform-pinned items sort first (optional; only newer platforms send it). */
  pinned?: boolean;
  /** Sharer identity (for "filter by team member"). */
  createdByName?: string | null;
  createdByEmail?: string | null;
  /** An encrypted key is attached and this caller may copy it. */
  hasSecret?: boolean;
  canAccessSecret?: boolean;
};

/** One item to push in a batch share. `ref` is the LOCAL identifier
 * (skill name, MCP name, or plugin spec/path). */
export type EigenweltHubShareItem = {
  kind: EigenweltHubKind;
  ref: string;
  description?: string;
  /** MCP only: include the configured key (encrypted, allow-scoped). */
  includeSecret?: boolean;
  /** Who may copy the key: "all" or a list of clerk user ids. */
  allow?: "all" | string[];
};

export type EigenweltHubBatchResult = {
  results: Array<{ ref?: string; id?: string; kind?: string; ok: boolean; error?: string; keyIncluded?: boolean }>;
};

export type EigenweltHubItemDetail = EigenweltHubItem & { payload: unknown };

/** Local record of an installed hub item — backs "update available" detection. */
export type EigenweltHubInstall = {
  version: number;
  kind: EigenweltHubKind;
  name: string;
  installedAt: number;
};

export type EigenweltHubInstallMap = Record<string, EigenweltHubInstall>;

// The shared WorkspaceWire contract now carries the opencode block; keep the
// historical name as an alias for the many existing imports.
export type LegalworkWorkspaceInfo = WorkspaceInfo;

export type LegalworkWorkspaceList = {
  items: LegalworkWorkspaceInfo[];
  workspaces?: WorkspaceInfo[];
  activeId?: string | null;
};

export type LegalworkRecorderLiveTranscriptStatus = {
  available: boolean;
  recordingActive: boolean;
  liveTranscriptActive: boolean;
  fileName: string | null;
  error: string | null;
};

export type LegalworkSessionMessage = {
  info: Message;
  parts: Part[];
};

export type LegalworkSessionSnapshot = {
  session: Session;
  messages: LegalworkSessionMessage[];
  todos: Todo[];
  status:
    | { type: "idle" }
    | { type: "busy" }
    | {
        type: "retry";
        attempt: number;
        message: string;
        next: number;
        // Mirrors the engine's `SessionStatus` retry action (the chat renders
        // it as a titled block with an optional external-link button).
        action?: {
          reason: string;
          provider: string;
          title: string;
          message: string;
          label: string;
          link?: string;
        };
      };
};

export type LegalworkPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
};

export type LegalworkSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
  kind?: "workflow";
  workflowType?: "tabular" | "assistant";
};

export type LegalworkSkillContent = {
  item: LegalworkSkillItem;
  content: string;
};

/** A file attached to a skill — lives in the skill's own resources/ folder. */
export type LegalworkSkillResourceItem = {
  name: string;
  path: string;
  size: number;
  updatedAt: number;
};

export type LegalworkSkillResourceContent = {
  item: LegalworkSkillResourceItem;
  content: string;
};

export type LegalworkHubSkillItem = {
  name: string;
  description: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
};

export type LegalworkHubRepo = {
  owner?: string;
  repo?: string;
  ref?: string;
};

export type LegalworkWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type LegalworkWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
  revision?: string;
};

export type LegalworkWorkspaceFileDeleteResult = {
  ok: boolean;
  path: string;
  code?: string;
};

export type LegalworkAuthorizedFoldersResponse = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot: string;
};

export type LegalworkAuthorizedFoldersUpdateResponse = {
  folders: string[];
  hiddenCount: number;
  updatedAt: number;
};

export type LegalworkRuntimeConfigMigrationResult = {
  migrated: boolean;
  keys: string[];
  legacyKeys: string[];
  userOpencodeKeys: string[];
  updatedAt: number | null;
  legacyError?: string | null;
};

export type LegalworkRuntimeConfigStatus = {
  runtime: Record<string, unknown>;
  runtimeKeys: string[];
  effectiveRuntime: Record<string, unknown>;
  sources?: {
    projectOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    globalOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    runtimeDatabase: { keys: string[]; config: Record<string, unknown> };
    injected: { keys: string[]; config: Record<string, unknown> };
  };
  legacyLegalwork: {
    path: string;
    keys: string[];
    error: string | null;
  };
  userOpencode: {
    path: string;
    exists: boolean;
    keys: string[];
    migratableKeys: string[];
  };
};

export type LegalworkCloudPluginInstallResult = {
  item: ImportedPlugin;
};

export type LegalworkCloudPluginsResult = {
  marketplaces: Record<string, ImportedMarketplace>;
  plugins: Record<string, ImportedPlugin>;
};

export type LegalworkClaudePluginComponent = {
  type: "mcp" | "skill" | "command" | "agent";
  name: string;
  description: string | null;
};

export type LegalworkClaudePluginPreview = {
  pluginId: string;
  name: string;
  description: string | null;
  version: string | null;
  source: { owner: string; repo: string; ref: string; dir: string | null };
  components: LegalworkClaudePluginComponent[];
  warnings: string[];
};

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export type LegalworkCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
};

export type LegalworkMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
};

export type LegalworkMcpEngineSync = {
  status: "ok" | "failed";
  at: number;
  failures: Array<{ name: string; status?: number; message?: string }>;
};

export type LegalworkWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  legalwork?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
  files?: Array<{ path: string; content: string }>;
};

export type LegalworkWorkspaceImportChange = {
  kind: "opencode" | "legalwork" | "skill" | "command" | "file";
  action: "create" | "update" | "replace" | "delete" | "unchanged";
  label: string;
  path: string;
};

export type LegalworkWorkspaceImportPreview = {
  fingerprint: string;
  summary: {
    total: number;
    create: number;
    update: number;
    replace: number;
    delete: number;
    unchanged: number;
  };
  changes: LegalworkWorkspaceImportChange[];
};

export type LegalworkWorkspaceExportSensitiveMode = "auto" | "include" | "exclude";

export type LegalworkWorkspaceExportWarning = {
  id: string;
  label: string;
  detail: string;
};

export type LegalworkBlueprintSessionsMaterializeResult = {
  ok: boolean;
  created: Array<{ templateId: string; sessionId: string; title: string }>;
  existing: Array<{ templateId: string; sessionId: string }>;
  openSessionId: string | null;
};

export type LegalworkArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type LegalworkArtifactList = {
  items: LegalworkArtifactItem[];
};

export type GoogleWorkspaceAccount = {
  accountId: string | null;
  email: string | null;
  name: string | null;
  picture: string | null;
  sub: string | null;
  scopes?: string[];
  connectedAt?: string | null;
};

export type GoogleWorkspaceAuthStatus = {
  configured: boolean;
  missing: string[];
  customClient: boolean;
  vault: "encrypted" | "plaintext-dev" | "unavailable";
  connected: boolean;
  account: GoogleWorkspaceAccount | null;
  accounts: GoogleWorkspaceAccount[];
  activeAccountId: string | null;
  scopes: string[];
  connectedAt: string | null;
  error: string | null;
  testStatus: string | null;
  smokeTest: {
    driveFileId: string | null;
    driveFileName: string | null;
    gmailDraftId: string | null;
  } | null;
};

export type GoogleWorkspaceConnectStart = {
  flowId: string;
  authUrl: string;
  expiresAt: number;
};

export type GoogleWorkspaceConnectStatus = {
  flowId: string;
  status: "pending" | "connected" | "failed" | "expired";
  expiresAt: number;
  error: string | null;
  googleWorkspace: GoogleWorkspaceAuthStatus | null;
};

export type LegalworkExtensionActionCall = {
  extensionId: string;
  action: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type LegalworkExtensionActionResult = {
  ok: boolean;
  extensionId: string;
  action: string;
  result: unknown;
  context?: Record<string, unknown>;
};

export type LegalworkResolvedArtifactTarget = {
  id: string;
  kind: "file" | "url";
  value: string;
  name: string;
  preview: "browser" | "markdown" | "sheet" | "slides" | "image" | "pdf" | "html" | "text" | "external";
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
  contentType?: string;
};

export type LegalworkWorkspaceFileStat = {
  ok: boolean;
  path: string;
  exists: boolean;
  kind?: "file" | "dir" | "other";
  size?: number;
  updatedAt?: number;
};

export type LegalworkWorkspaceDirectoryEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
  updatedAt?: number;
};

export type LegalworkWorkspaceDirectoryList = {
  path: string;
  entries: LegalworkWorkspaceDirectoryEntry[];
  truncated: boolean;
};

export type LegalworkInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
};

export type LegalworkInboxList = {
  items: LegalworkInboxItem[];
};

export type LegalworkInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

export type LegalworkUserEnvItem = {
  key: string;
  updatedAt: number;
  hasValue: boolean;
  value?: string;
};

export type LegalworkActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type LegalworkAuditEntry = {
  id: string;
  workspaceId: string;
  actor: LegalworkActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
};

export type LegalworkReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type LegalworkReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: LegalworkReloadTrigger;
  timestamp: number;
};

export type LegalworkSessionGroupDefinition = {
  id: string;
  label: string;
};

export type LegalworkSessionGroupState = {
  groups: LegalworkSessionGroupDefinition[];
  assignments: Record<string, string>;
};

export type LegalworkSessionGroupEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "session_groups.updated";
  action: "created" | "updated" | "deleted" | "assigned" | "reordered" | "imported";
  groupId?: string;
  sessionId?: string;
  timestamp: number;
};

// Fallback for explicit server-mode URL derivation. Desktop local workers replace this
// with the persisted runtime-discovered port once the host reports it.
export const DEFAULT_LEGALWORK_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "legalwork.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "legalwork.server.port";
const STORAGE_TOKEN = "legalwork.server.token";
const STORAGE_HOST_AUTH_KEY = "legalwork.server.hostToken";
const STORAGE_REMOTE_ACCESS = "legalwork.server.remoteAccessEnabled";

export function normalizeLegalworkServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function isLoopbackLegalworkServerUrl(input: string) {
  const normalized = normalizeLegalworkServerUrl(input) ?? "";
  if (!normalized) return false;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function parseLegalworkWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeLegalworkServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const legacyIndex = segments.indexOf("w");
    if (legacyIndex >= 0 && segments[legacyIndex + 1]) {
      return decodeURIComponent(segments[legacyIndex + 1]);
    }
    const workspaceIndex = segments.indexOf("workspace");
    if (workspaceIndex >= 0 && segments[workspaceIndex + 1]) {
      return decodeURIComponent(segments[workspaceIndex + 1]);
    }
    return null;
  } catch {
    const match = normalized.match(/\/(?:w|workspace)\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function buildLegalworkWorkspaceBaseUrl(hostUrl: string, workspaceId?: string | null) {
  const normalized = normalizeLegalworkServerUrl(hostUrl) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = `${prefix ? `/${prefix}` : ""}/workspace/${encodeURIComponent(
        decodeURIComponent(segments[mountIndex + 1]),
      )}`;
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/workspace/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/workspace/${encodeURIComponent(id)}`;
  }
}

const LEGALWORK_INVITE_PARAM_URL = "ow_url";
const LEGALWORK_INVITE_PARAM_TOKEN = "ow_token";
const LEGALWORK_INVITE_PARAM_STARTUP = "ow_startup";
const LEGALWORK_INVITE_PARAM_AUTO_CONNECT = "ow_auto_connect";

export type LegalworkOpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: Record<string, unknown>;
  channels: Record<string, unknown>;
  config: Record<string, unknown>;
  activity?: {
    inboundToday?: number;
    outboundToday?: number;
    lastMessageAt?: number | null;
    [key: string]: unknown;
  };
  agent?: {
    loaded?: boolean;
    selected?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type LegalworkOpenCodeRouterIdentityItem = {
  id: string;
  channel?: string;
  enabled?: boolean;
  peerId?: string;
  [key: string]: unknown;
};

export type LegalworkOpenCodeRouterSendResult = {
  ok: boolean;
  sent: number;
  attempted: number;
  failures?: Array<{ identityId: string; peerId: string; error: string }>;
  reason?: string;
  [key: string]: unknown;
};

export type LegalworkConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
  autoConnect?: boolean;
};

export function readLegalworkConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = search.get(LEGALWORK_INVITE_PARAM_URL)?.trim() ?? "";
  const url = normalizeLegalworkServerUrl(rawUrl);
  if (!url) return null;

  const token = search.get(LEGALWORK_INVITE_PARAM_TOKEN)?.trim() ?? "";
  const startupRaw = search.get(LEGALWORK_INVITE_PARAM_STARTUP)?.trim() ?? "";
  const startup = startupRaw === "server" ? "server" : undefined;
  const autoConnect = search.get(LEGALWORK_INVITE_PARAM_AUTO_CONNECT)?.trim() === "1";

  return {
    url,
    token: token || undefined,
    startup,
    autoConnect: autoConnect || undefined,
  } satisfies LegalworkConnectInvite;
}

export function stripLegalworkConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(LEGALWORK_INVITE_PARAM_URL);
    url.searchParams.delete(LEGALWORK_INVITE_PARAM_TOKEN);
    url.searchParams.delete(LEGALWORK_INVITE_PARAM_STARTUP);
    url.searchParams.delete(LEGALWORK_INVITE_PARAM_AUTO_CONNECT);
    return url.toString();
  } catch {
    return input;
  }
}

export function readLegalworkServerSettings(): LegalworkServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeLegalworkServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ?? "",
    );
    const portRaw = window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ?? "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token = window.localStorage.getItem(STORAGE_TOKEN) ?? undefined;
    const hostToken = window.localStorage.getItem(STORAGE_HOST_AUTH_KEY) ?? undefined;
    const remoteAccessRaw = window.localStorage.getItem(STORAGE_REMOTE_ACCESS) ?? "";
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
      hostToken: hostToken?.trim() || undefined,
      remoteAccessEnabled: remoteAccessRaw === "1",
    };
  } catch {
    return {};
  }
}

export function writeLegalworkServerSettings(next: LegalworkServerSettings): LegalworkServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeLegalworkServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;
    const hostToken = next.hostToken?.trim() || undefined;
    const remoteAccessEnabled = next.remoteAccessEnabled === true;

    if (urlOverride) {
      window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
    } else {
      window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    }

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }

    if (hostToken) {
      window.localStorage.setItem(STORAGE_HOST_AUTH_KEY, hostToken);
    } else {
      window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    }

    if (remoteAccessEnabled) {
      window.localStorage.setItem(STORAGE_REMOTE_ACCESS, "1");
    } else {
      window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
    }

    return readLegalworkServerSettings();
  } catch {
    return next;
  }
}

export function hydrateLegalworkServerSettingsFromEnv() {
  if (typeof window === "undefined") return;

  const envUrl = typeof import.meta.env?.VITE_LEGALWORK_URL === "string"
    ? import.meta.env.VITE_LEGALWORK_URL.trim()
    : "";
  const envPort = typeof import.meta.env?.VITE_LEGALWORK_PORT === "string"
    ? import.meta.env.VITE_LEGALWORK_PORT.trim()
    : "";
  const envToken = typeof import.meta.env?.VITE_LEGALWORK_TOKEN === "string"
    ? import.meta.env.VITE_LEGALWORK_TOKEN.trim()
    : "";
  const envHostToken = typeof import.meta.env?.VITE_LEGALWORK_HOST_TOKEN === "string"
    ? import.meta.env.VITE_LEGALWORK_HOST_TOKEN.trim()
    : "";

  if (!envUrl && !envPort && !envToken && !envHostToken) return;

  try {
    const current = readLegalworkServerSettings();
    const next: LegalworkServerSettings = { ...current };
    let changed = false;

    if (!current.urlOverride && envUrl) {
      next.urlOverride = normalizeLegalworkServerUrl(envUrl) ?? undefined;
      changed = true;
    }

    if (!current.portOverride && envPort) {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed) && parsed > 0) {
        next.portOverride = parsed;
        changed = true;
      }
    }

    if (!current.token && envToken) {
      next.token = envToken;
      changed = true;
    }

    if (!current.hostToken && envHostToken) {
      next.hostToken = envHostToken;
      changed = true;
    }

    if (changed) {
      writeLegalworkServerSettings(next);
    }
  } catch {
    // ignore
  }
}

export function clearLegalworkServerSettings() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(STORAGE_TOKEN);
    window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
  } catch {
    // ignore
  }
}

export class LegalworkServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-LegalWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-LegalWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// Use Tauri's fetch when running in the desktop app to avoid CORS issues.
// Stream URLs (SSE) bypass the plugin because its `fetch_read_body` IPC call
// blocks until the body closes — that freezes the webview for infinite bodies.
const LEGALWORK_STREAM_URL_RE = /\/events(\b|\?)|\/event-stream\b|\/stream\b/;

function isStreamUrl(url: string): boolean {
  return LEGALWORK_STREAM_URL_RE.test(url);
}

const resolveFetch = (url?: string) => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  if (url && isStreamUrl(url)) {
    return typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch;
  }
  return desktopFetch;
};

const DEFAULT_LEGALWORK_SERVER_TIMEOUT_MS = 10_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_LEGALWORK_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new LegalworkServerError(response.status, code, message, json?.details);
  }

  return json as T;
}

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_LEGALWORK_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null; updatedAt: number | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: options.body
        ? buildHeaders(options.token, options.hostToken)
        : buildAuthHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_LEGALWORK_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new LegalworkServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const updatedAtHeader = response.headers.get("x-legalwork-updated-at");
  const parsedUpdatedAt = updatedAtHeader === null ? null : Number(updatedAtHeader);
  const updatedAt = parsedUpdatedAt !== null && Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename, updatedAt };
}

export function createLegalworkServerClient(options: { baseUrl: string; token?: string; hostToken?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;

  const timeouts = {
    health: 3_000,
    capabilities: 6_000,
    listWorkspaces: 8_000,
    activateWorkspace: 10_000,
    deleteWorkspace: 10_000,
    deleteSession: 12_000,
    sessionRead: 12_000,
    status: 6_000,
    config: 10_000,
    workspaceExport: 30_000,
    workspaceImport: 30_000,
    binary: 60_000,
    benchmark: 15_000,
    benchmarkCatalog: 45_000,
  };

  return {
    baseUrl,
    token,
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    runtimeVersions: () =>
      requestJson<LegalworkRuntimeSnapshot>(baseUrl, "/runtime/versions", { token, hostToken, timeoutMs: timeouts.status }),
    status: () => requestJson<LegalworkServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    // Sync analytics consent; the server answers with the per-launch
    // distinct id (in-memory) for the caller to adopt.
    setAnalyticsIdentity: (payload: { analyticsEnabled: boolean }) =>
      requestJson<{ ok: boolean; distinctId?: string }>(baseUrl, "/analytics/identity", {
        token,
        hostToken,
        method: "PUT",
        body: payload,
        timeoutMs: timeouts.status,
      }),
    capabilities: () => requestJson<LegalworkServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    googleWorkspaceStatus: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/status", { token, hostToken, timeoutMs: timeouts.status }),
    googleWorkspaceConnectStart: (options?: { gmailRead?: boolean; features?: string[] }) => requestJson<GoogleWorkspaceConnectStart>(baseUrl, "/experimental/google-workspace/connect/start", { token, hostToken, method: "POST", body: { gmailRead: options?.gmailRead === true, features: options?.features ?? [] }, timeoutMs: timeouts.status }),
    googleWorkspaceConnectStatus: (flowId: string) => requestJson<GoogleWorkspaceConnectStatus>(baseUrl, `/experimental/google-workspace/connect/status/${encodeURIComponent(flowId)}`, { token, hostToken, timeoutMs: timeouts.status }),
    googleWorkspaceDisconnect: (accountId?: string | null) => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/disconnect", { token, hostToken, method: "POST", body: accountId ? { accountId } : {}, timeoutMs: timeouts.status }),
    googleWorkspaceSetActiveAccount: (accountId: string) => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/active-account", { token, hostToken, method: "POST", body: { accountId }, timeoutMs: timeouts.status }),
    googleWorkspaceTestConnection: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/test", { token, hostToken, method: "POST", timeoutMs: 60_000 }),
    googleWorkspaceRunScopeSmokeTest: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/smoke-test", { token, hostToken, method: "POST", timeoutMs: 120_000 }),
    callExtensionAction: (payload: LegalworkExtensionActionCall) =>
      requestJson<LegalworkExtensionActionResult>(baseUrl, "/experimental/extensions/call", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.binary,
      }),
    listWorkspaces: () => requestJson<LegalworkWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    getRecorderLiveTranscript: (workspaceId: string) =>
      requestJson<LegalworkRecorderLiveTranscriptStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/recorder/live-transcript`,
        { token, hostToken, timeoutMs: timeouts.status },
      ),
    setRecorderLiveTranscript: (workspaceId: string, enabled: boolean) =>
      requestJson<LegalworkRecorderLiveTranscriptStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/recorder/live-transcript`,
        { token, hostToken, method: "POST", body: { enabled }, timeoutMs: timeouts.status },
      ),
    createLocalWorkspace: (payload: { folderPath: string; name: string; preset: string }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/local", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    // Long timeout: the server shows a native dialog and waits for the human.
    pickWorkspaceFolder: (payload?: { title?: string; defaultPath?: string; returnFocusTo?: string }) =>
      requestJson<{ supported: boolean; path: string | null }>(baseUrl, "/workspaces/pick-folder", {
        token,
        hostToken,
        method: "POST",
        body: payload ?? {},
        timeoutMs: 300_000,
      }),
    createRemoteWorkspace: (payload: {
      baseUrl: string;
      legalworkHostUrl?: string | null;
      legalworkToken?: string | null;
      legalworkWorkspaceId?: string | null;
      legalworkWorkspaceName?: string | null;
      displayName?: string | null;
      directory?: string | null;
      remoteType?: "legalwork" | "opencode";
      sandboxBackend?: string | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/remote", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    updateWorkspaceDisplayName: (workspaceId: string, displayName: string | null) =>
      requestJson<WorkspaceList>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/display-name`, {
        token,
        hostToken,
        method: "PATCH",
        body: { displayName },
        timeoutMs: timeouts.activateWorkspace,
      }),
    activateWorkspace: (workspaceId: string, options?: { persist?: boolean }) => {
      const query = options?.persist ? "?persist=true" : "";
      return requestJson<{ activeId: string; workspace: LegalworkWorkspaceInfo; persisted: boolean }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate${query}`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      );
    },
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: LegalworkWorkspaceInfo[]; workspaces?: WorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    deleteSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteSession },
      ),
    listSessions: (
      workspaceId: string,
      options?: { roots?: boolean; start?: number; search?: string; limit?: number },
    ) => {
      const query = new URLSearchParams();
      if (typeof options?.roots === "boolean") query.set("roots", String(options.roots));
      if (typeof options?.start === "number") query.set("start", String(options.start));
      if (options?.search?.trim()) query.set("search", options.search.trim());
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ items: Session[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    benchmarkGetCatalog: (
      workspaceId: string,
      options?: { verticals?: string[]; workTypes?: BenchmarkWorkType[]; search?: string; refresh?: boolean },
    ) => {
      const query = new URLSearchParams();
      if (options?.verticals?.length) query.set("vertical", options.verticals.join(","));
      if (options?.workTypes?.length) query.set("workType", options.workTypes.join(","));
      if (options?.search?.trim()) query.set("search", options.search.trim());
      if (options?.refresh) query.set("refresh", "true");
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<BenchmarkCatalogResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/catalog${suffix}`,
        { token, hostToken, timeoutMs: timeouts.benchmarkCatalog },
      );
    },
    benchmarkGetCatalogTask: (workspaceId: string, key: string) =>
      requestJson<{ key: string; ref: string; task: BenchmarkTaskDefinition }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/catalog/task?key=${encodeURIComponent(key)}`,
        { token, hostToken, timeoutMs: timeouts.benchmarkCatalog },
      ),
    benchmarkListTasks: (workspaceId: string) =>
      requestJson<{ items: BenchmarkTaskItem[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks`,
        { token, hostToken, timeoutMs: timeouts.benchmark },
      ),
    benchmarkImportTasks: (workspaceId: string, keys: string[]) =>
      requestJson<BenchmarkImportResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks/import`,
        { token, hostToken, method: "POST", body: { keys }, timeoutMs: timeouts.benchmarkCatalog },
      ),
    benchmarkCreateTask: (workspaceId: string, payload: BenchmarkCustomTaskInput) =>
      requestJson<{ item: BenchmarkTaskItem }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.benchmark },
      ),
    benchmarkUpdateTask: (workspaceId: string, taskId: string, payload: BenchmarkCustomTaskInput) =>
      requestJson<{ item: BenchmarkTaskItem }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks/${encodeURIComponent(taskId)}`,
        { token, hostToken, method: "PUT", body: payload, timeoutMs: timeouts.benchmark },
      ),
    benchmarkDeleteTask: (workspaceId: string, taskId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks/${encodeURIComponent(taskId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.benchmark },
      ),
    benchmarkGetTaskDocuments: (workspaceId: string, taskId: string) =>
      requestJson<{ items: BenchmarkTaskDocument[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks/${encodeURIComponent(taskId)}/documents`,
        { token, hostToken, timeoutMs: timeouts.benchmarkCatalog },
      ),
    benchmarkGetAnalytics: (workspaceId: string, options?: { tags?: string[] }) => {
      const query = options?.tags?.length ? `?tags=${encodeURIComponent(options.tags.join(","))}` : "";
      return requestJson<BenchmarkAnalytics>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/analytics${query}`,
        { token, hostToken, timeoutMs: timeouts.benchmark },
      );
    },
    benchmarkExportTasks: (workspaceId: string, taskIds: string[]) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks/export`,
        { token, hostToken, method: "POST", body: { taskIds }, timeoutMs: timeouts.benchmarkCatalog },
      ),
    benchmarkImportZip: (workspaceId: string, zipBase64: string) =>
      requestJson<BenchmarkImportZipResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks/import-zip`,
        { token, hostToken, method: "POST", body: { zipBase64 }, timeoutMs: timeouts.benchmarkCatalog },
      ),
    benchmarkListRuns: (workspaceId: string, options?: { limit?: number; start?: number }) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      if (typeof options?.start === "number") query.set("start", String(options.start));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ items: BenchmarkRunSummary[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs${suffix}`,
        { token, hostToken, timeoutMs: timeouts.benchmark },
      );
    },
    benchmarkCreateRun: (workspaceId: string, payload: BenchmarkRunCreateInput) =>
      requestJson<{ run: BenchmarkRunSummary }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.benchmarkCatalog },
      ),
    benchmarkGetRun: (workspaceId: string, runId: string) =>
      requestJson<BenchmarkRunDetail>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs/${encodeURIComponent(runId)}`,
        { token, hostToken, timeoutMs: timeouts.benchmark },
      ),
    benchmarkGetRunProgress: (workspaceId: string, runId: string) =>
      requestJson<BenchmarkRunProgress>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs/${encodeURIComponent(runId)}/progress`,
        { token, hostToken, timeoutMs: timeouts.benchmark },
      ),
    benchmarkGetRunItem: (workspaceId: string, runId: string, itemId: string) =>
      requestJson<BenchmarkItemDetail>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}`,
        { token, hostToken, timeoutMs: timeouts.benchmark },
      ),
    benchmarkAbortRun: (workspaceId: string, runId: string) =>
      requestJson<{ run: BenchmarkRunSummary }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs/${encodeURIComponent(runId)}/abort`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.benchmark },
      ),
    benchmarkResumeRun: (workspaceId: string, runId: string) =>
      requestJson<{ run: BenchmarkRunSummary }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs/${encodeURIComponent(runId)}/resume`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.benchmark },
      ),
    benchmarkDeleteRun: (workspaceId: string, runId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/benchmarks/runs/${encodeURIComponent(runId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.benchmark },
      ),
    getSessionGroups: (workspaceId: string) =>
      requestJson<{ state: LegalworkSessionGroupState; updatedAt: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    putSessionGroups: (workspaceId: string, state: LegalworkSessionGroupState) =>
      requestJson<{ state: LegalworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "PUT", body: { state }, timeoutMs: timeouts.config },
      ),
    createSessionGroup: (workspaceId: string, input: { id?: string; label: string }) =>
      requestJson<{ state: LegalworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.config },
      ),
    reorderSessionGroups: (workspaceId: string, groupIds: string[]) =>
      requestJson<{ state: LegalworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/reorder`,
        { token, hostToken, method: "PATCH", body: { groupIds }, timeoutMs: timeouts.config },
      ),
    assignSessionGroup: (workspaceId: string, sessionId: string, groupId: string | null) =>
      requestJson<{ state: LegalworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/assignments/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "PATCH", body: { groupId }, timeoutMs: timeouts.config },
      ),
    renameSessionGroup: (workspaceId: string, groupId: string, label: string) =>
      requestJson<{ state: LegalworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`,
        { token, hostToken, method: "PATCH", body: { label }, timeoutMs: timeouts.config },
      ),
    removeSessionGroup: (workspaceId: string, groupId: string) =>
      requestJson<{ state: LegalworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.config },
      ),
    listSessionGroupEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: LegalworkSessionGroupEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/events${query}`,
        { token, hostToken },
      );
    },
    getSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ item: Session }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    getSessionMessages: (workspaceId: string, sessionId: string, options?: { limit?: number }) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ items: LegalworkSessionMessage[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    getSessionSnapshot: (workspaceId: string, sessionId: string, options?: { limit?: number }) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ item: LegalworkSessionSnapshot }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/snapshot${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    exportWorkspace: (
      workspaceId: string,
      options?: { sensitiveMode?: LegalworkWorkspaceExportSensitiveMode },
    ) => {
      const query = new URLSearchParams();
      if (options?.sensitiveMode) {
        query.set("sensitive", options.sensitiveMode);
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<LegalworkWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export${suffix}`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      });
    },
    importWorkspace: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean; preview?: LegalworkWorkspaceImportPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),
    previewWorkspaceImport: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<LegalworkWorkspaceImportPreview>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/import/preview`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    materializeBlueprintSessions: (workspaceId: string) =>
      requestJson<LegalworkBlueprintSessionsMaterializeResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/blueprint/sessions/materialize`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; legalwork: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    listAuthorizedFolders: (workspaceId: string) =>
      requestJson<LegalworkAuthorizedFoldersResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setAuthorizedFolders: (workspaceId: string, folders: string[]) =>
      requestJson<LegalworkAuthorizedFoldersUpdateResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        {
          token,
          hostToken,
          method: "PUT",
          body: { folders },
          timeoutMs: timeouts.config,
        },
      ),
    migrateRuntimeConfig: (workspaceId: string) =>
      requestJson<LegalworkRuntimeConfigMigrationResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config/migrate`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.config,
        },
      ),
    getRuntimeConfigStatus: (workspaceId: string) =>
      requestJson<LegalworkRuntimeConfigStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; legalwork?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    listCloudPlugins: (workspaceId: string) =>
      requestJson<LegalworkCloudPluginsResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    installCloudPlugin: (workspaceId: string, payload: { marketplaceId: string | null; marketplace?: Record<string, unknown> | null; resolved: Record<string, unknown> }) =>
      requestJson<LegalworkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    removeCloudPlugin: (workspaceId: string, pluginId: string) =>
      requestJson<LegalworkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins/${encodeURIComponent(pluginId)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),
    previewClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<{ preview: LegalworkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: { ...payload, dryRun: true },
        timeoutMs: timeouts.config,
      }),
    installClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<LegalworkCloudPluginInstallResult & { preview: LegalworkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    readOpencodeConfigFile: (workspaceId: string, scope: "project" | "global" = "project") => {
      const query = `?scope=${scope}`;
      return requestJson<OpencodeConfigFile>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config${query}`, {
        token,
        hostToken,
      });
    },
    writeOpencodeConfigFile: (workspaceId: string, scope: "project" | "global", content: string) =>
      requestJson<ExecResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config`, {
        token,
        hostToken,
        method: "POST",
        body: { scope, content },
      }),
    // Eigenwelt platform connect: the server owns the OAuth loopback + code
    // exchange; the app opens the authorize URL and long-polls for the payload.
    eigenweltOauthStart: () =>
      requestJson<{ sessionId: string; authorizeUrl: string }>(baseUrl, "/api/eigenwelt/oauth/start", {
        token,
        hostToken,
        method: "POST",
        timeoutMs: timeouts.config,
      }),
    eigenweltOauthWait: (sessionId: string) =>
      // Long poll: the server holds the request up to ~120s before answering
      // {pending:true}, so the HTTP timeout must comfortably exceed that.
      requestJson<EigenweltSignInWaitResult>(
        baseUrl,
        `/api/eigenwelt/oauth/wait/${encodeURIComponent(sessionId)}`,
        { token, hostToken, timeoutMs: 130_000 },
      ),
    eigenweltModels: () =>
      requestJson<EigenweltManifest>(baseUrl, "/api/eigenwelt/models", {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    // Persist the connected firm's entitlements + platformURL + the secret
    // access + refresh tokens (server-side only). Called right after a
    // successful sign-in; passing platformToken:null signs out (revoke + clear).
    eigenweltSaveConnection: (
      workspaceId: string,
      payload: {
        entitlements?: EigenweltEntitlements | null;
        account?: EigenweltAccountIdentity | null;
        platformURL?: string | null;
        platformToken?: string | null;
        refreshToken?: string | null;
        accessTokenExpiresAt?: number | null;
        // Sign-in only: the global gateway manifest. The server caches it and
        // injects the `eigenwelt` provider into every workspace.
        baseURL?: string;
        apiKey?: string;
        models?: EigenweltManifestModel[];
        // Sign-out: clears the connection + the global manifest.
        disconnect?: boolean;
      },
    ) =>
      requestJson<EigenweltEntitlementsView>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/eigenwelt/connection`, {
        token,
        hostToken,
        method: "PUT",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    // `refresh: true` forces the server to re-pull entitlements from the
    // platform NOW (bypassing the access-token skew short-circuit) — used by the
    // post-checkout "waiting for your subscription" poll so a fresh sub shows up
    // within seconds instead of on the next lazy token refresh.
    eigenweltEntitlements: (workspaceId: string, opts?: { refresh?: boolean }) =>
      requestJson<EigenweltEntitlementsView>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/eigenwelt/entitlements${opts?.refresh ? "?refresh=1" : ""}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    // Manual model refresh: re-pull the gateway manifest and rewrite the
    // eigenwelt provider's model list without re-authenticating.
    eigenweltRefreshModels: (workspaceId: string) =>
      requestJson<{ modelCount: number; changed: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/eigenwelt/refresh-models`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.config },
      ),
    // Firm Hub: the server proxies these to the platform with the stored token.
    hubList: (workspaceId: string, kind?: EigenweltHubKind) => {
      // No kind → every team category at once (with sharer identity + key flags).
      const query = kind ? `?kind=${encodeURIComponent(kind)}` : "?all=1";
      return requestJson<{ items: EigenweltHubItem[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub${query}`,
        { token, hostToken, timeoutMs: timeouts.config },
      );
    },
    hubShareBatch: (workspaceId: string, items: EigenweltHubShareItem[]) =>
      requestJson<EigenweltHubBatchResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/share/batch`,
        {
          token,
          hostToken,
          method: "POST",
          body: { items, acknowledgeSharingRisk: true },
          timeoutMs: timeouts.workspaceExport,
        },
      ),
    hubInstallBatch: (workspaceId: string, itemIds: string[], options: { allowOverwrite: boolean }) =>
      requestJson<EigenweltHubBatchResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/install/batch`,
        {
          token,
          hostToken,
          method: "POST",
          body: { itemIds, acknowledgeExecutableRisk: true, allowOverwrite: options.allowOverwrite },
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    hubGet: (workspaceId: string, itemId: string) =>
      requestJson<EigenweltHubItemDetail>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/${encodeURIComponent(itemId)}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    hubShareWorkflow: (workspaceId: string, payload: { skill: string; name?: string; description?: string }) =>
      requestJson<{ ok: boolean; id: string; version: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/share/workflow`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.workspaceExport },
      ),
    /** Fetch a cited LegalMemory original into the workspace and return where it
     * landed. Takes the document id, never a URL: the server pulls the bytes
     * over MCP itself, so no agent turn and no download endpoint are involved. */
    legalMemoryOpen: (workspaceId: string, payload: { document_id: string }) =>
      requestJson<{ ok: boolean; path: string; bytes: number; mimeType: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/legalmemory/open`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.workspaceExport },
      ),
    hubShareIntegration: (workspaceId: string, payload: { mcp: string; name?: string; description?: string }) =>
      requestJson<{ ok: boolean; id: string; version: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/share/integration`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.config },
      ),
    hubSharePreset: (workspaceId: string, payload: { name: string; description?: string; payload: unknown }) =>
      requestJson<{ ok: boolean; id: string; version: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/share/preset`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.config },
      ),
    hubInstall: (workspaceId: string, itemId: string, options: { allowOverwrite: boolean }) =>
      requestJson<{ ok: boolean; kind: EigenweltHubKind; name: string; version?: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/install/${encodeURIComponent(itemId)}`,
        {
          token,
          hostToken,
          method: "POST",
          body: { acknowledgeExecutableRisk: true, allowOverwrite: options.allowOverwrite },
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    // Local install records ({id: {version, kind, name}}) that back the
    // Firm Hub's "update available" comparison. Never carries platform secrets.
    hubInstalls: (workspaceId: string) =>
      requestJson<{ installs: EigenweltHubInstallMap }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/installs`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    hubRecordInstall: (
      workspaceId: string,
      payload: { id: string; version: number; kind: EigenweltHubKind; name?: string },
    ) =>
      requestJson<{ ok: boolean; installs: EigenweltHubInstallMap }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/installs`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.config },
      ),
    hubDelete: (workspaceId: string, itemId: string) =>
      requestJson<{ ok: boolean; id: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/hub/${encodeURIComponent(itemId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.config },
      ),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: LegalworkReloadEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${workspaceId}/events${query}`,
        { token, hostToken },
      );
    },
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${workspaceId}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
      }),
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: LegalworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: LegalworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: LegalworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: LegalworkSkillItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills${query}`,
        { token, hostToken },
      );
    },
    listHubSkills: (options?: { repo?: LegalworkHubRepo }) => {
      const params = new URLSearchParams();
      const owner = options?.repo?.owner?.trim();
      const repo = options?.repo?.repo?.trim();
      const ref = options?.repo?.ref?.trim();
      if (owner) params.set("owner", owner);
      if (repo) params.set("repo", repo);
      if (ref) params.set("ref", ref);
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ items: LegalworkHubSkillItem[] }>(baseUrl, `/hub/skills${query}`, {
        token,
        hostToken,
      });
    },
    installHubSkill: (
      workspaceId: string,
      name: string,
      options?: { overwrite?: boolean; repo?: { owner?: string; repo?: string; ref?: string } },
    ) =>
      requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated"; written: number; skipped: number }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(options?.overwrite ? { overwrite: true } : {}),
            ...(options?.repo ? { repo: options.repo } : {}),
          },
        },
      ),
    scanGithubSkills: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<{ ref: string; skills: Array<{ dir: string; name: string; description: string }> }>(
        baseUrl,
        `/workspace/${workspaceId}/github-skills/scan`,
        { token, hostToken, method: "POST", body: payload },
      ),
    installGithubSkills: (
      workspaceId: string,
      payload: { url: string; ref?: string; paths: string[]; asWorkflow?: boolean },
    ) =>
      requestJson<{
        skills: Array<{ name: string; files: Array<{ path: string; contentBase64: string; executable: boolean }> }>;
        failed: Array<{ path: string; error: string }>;
      }>(baseUrl, `/workspace/${workspaceId}/github-skills/install`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    promoteSkillToWorkflow: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean; name: string; path: string; alreadyWorkflow: boolean }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}/promote-workflow`,
        { token, hostToken, method: "POST" },
      ),
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<LegalworkSkillContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<LegalworkSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteSkill: (workspaceId: string, name: string) =>
      requestJson<{ path: string }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    listSkillResources: (workspaceId: string, skill: string) =>
      requestJson<{ items: LegalworkSkillResourceItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(skill)}/resources`,
        { token, hostToken },
      ),
    getSkillResource: (workspaceId: string, skill: string, name: string) =>
      requestJson<LegalworkSkillResourceContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(skill)}/resources/${encodeURIComponent(name)}`,
        { token, hostToken },
      ),
    upsertSkillResource: (
      workspaceId: string,
      skill: string,
      payload: { name: string; content?: string; contentBase64?: string },
    ) =>
      requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated" }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(skill)}/resources`,
        { token, hostToken, method: "POST", body: payload },
      ),
    deleteSkillResource: (workspaceId: string, skill: string, name: string) =>
      requestJson<{ ok: boolean; name: string; path: string }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(skill)}/resources/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listMcp: (workspaceId: string) =>
      requestJson<{ items: LegalworkMcpItem[]; engineSync?: LegalworkMcpEngineSync | null }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp`,
        { token, hostToken },
      ),
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: LegalworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: LegalworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    setMcpEnabled: (workspaceId: string, name: string, enabled: boolean) =>
      requestJson<{ items: LegalworkMcpItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled },
        },
      ),

    logoutMcpAuth: (workspaceId: string, name: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: LegalworkCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: LegalworkAuditEntry[] }>(
        baseUrl,
        `/workspace/${workspaceId}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: LegalworkCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const form = new FormData();
      form.append("file", file);
      if (options?.path?.trim()) {
        form.append("path", options.path.trim());
      }

      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/inbox`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: timeouts.binary,
      });

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new LegalworkServerError(
          result.status,
          "request_failed",
          message || "Shared folder upload failed",
        );
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<LegalworkInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies LegalworkInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies LegalworkInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<LegalworkInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<LegalworkWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    listWorkspaceDirectory: (workspaceId: string, path: string) =>
      requestJson<LegalworkWorkspaceDirectoryList>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/list?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    statWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<LegalworkWorkspaceFileStat>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/stat?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<LegalworkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    deleteWorkspaceFiles: async (
      workspaceId: string,
      files: Array<{ path: string; recursive?: boolean }>,
    ): Promise<LegalworkWorkspaceFileDeleteResult[]> => {
      if (files.length === 0) return [];
      const created = await requestJson<{ session: { id: string } }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`,
        { token, hostToken, method: "POST", body: { write: true } },
      );
      const sessionId = created.session.id;
      try {
        const result = await requestJson<{ items: Array<{ ok?: boolean; path?: string; code?: string }> }>(
          baseUrl,
          `/files/sessions/${encodeURIComponent(sessionId)}/ops`,
          {
            token,
            hostToken,
            method: "POST",
            body: {
              operations: files.map((file) => ({
                type: "delete",
                path: file.path,
                recursive: file.recursive === true,
              })),
            },
          },
        );
        return result.items.map((item, index) => ({
          ok: item.ok === true,
          path: typeof item.path === "string" ? item.path : files[index]?.path ?? "",
          ...(typeof item.code === "string" ? { code: item.code } : {}),
        }));
      } finally {
        await requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
          token,
          hostToken,
          method: "DELETE",
        }).catch(() => undefined);
      }
    },

    writeWorkspaceBinaryFile: (
      workspaceId: string,
      payload: { path: string; data: ArrayBuffer; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<LegalworkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            path: payload.path,
            dataBase64: arrayBufferToBase64(payload.data),
            baseUpdatedAt: payload.baseUpdatedAt,
            force: payload.force,
          },
        },
      ),

    downloadWorkspaceFile: (workspaceId: string, path: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw?path=${encodeURIComponent(path)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<LegalworkArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    resolveArtifacts: (
      workspaceId: string,
      targets: Array<{
        kind: "file" | "url";
        value: string;
        name?: string;
        preview?: string;
        confidence?: number;
        reason?: string;
      }>,
    ) =>
      requestJson<{ items: LegalworkResolvedArtifactTarget[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/resolve`,
        { token, hostToken, method: "POST", body: { targets } },
      ),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    // User-level env vars (host-auth only — desktop shell is the sole caller).
    // See apps/server/src/env-file.ts and apps/app/pr/environment-variables.md.
    listUserEnvKeys: () =>
      requestJson<{ keys: string[] }>(
        baseUrl,
        "/env/keys",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnvStatus: (runtimeKey?: string | null) => {
      const params = new URLSearchParams();
      if (runtimeKey?.trim()) params.set("runtimeKey", runtimeKey.trim());
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ runtimeKey: string; pendingChanges: boolean }>(
        baseUrl,
        `/env/status${query}`,
        { token, hostToken, timeoutMs: timeouts.config },
      );
    },

    setUserEnvPendingChanges: (pendingChanges: boolean, runtimeKey?: string | null) =>
      requestJson<{ runtimeKey: string; pendingChanges: boolean }>(baseUrl, "/env/status", {
        token,
        hostToken,
        method: "PUT",
        body: { pendingChanges, runtimeKey: runtimeKey?.trim() || undefined },
        timeoutMs: timeouts.config,
      }),

    listUserEnv: () =>
      requestJson<{ items: LegalworkUserEnvItem[] }>(
        baseUrl,
        "/env?includeValues=false",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnv: (key: string) =>
      requestJson<{ item: LegalworkUserEnvItem & { value: string } }>(
        baseUrl,
        `/env/${encodeURIComponent(key)}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    upsertUserEnv: (entries: Array<{ key: string; value: string }>) =>
      requestJson<{ ok: true; count: number }>(baseUrl, "/env", {
        token,
        hostToken,
        method: "PUT",
        body: { entries },
        timeoutMs: timeouts.config,
      }),

    deleteUserEnv: (key: string) =>
      requestJson<{ ok: true }>(baseUrl, `/env/${encodeURIComponent(key)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),

    createVoiceRealtimeSession: (payload?: { model?: string; sessionContext?: string }) =>
      requestJson<{
        ok: true;
        clientSecret: string;
        expiresAt: number | null;
        model: string;
        transcriptionModel: string;
        tools: string[];
        source?: string;
      }>(baseUrl, "/voice/realtime/session", {
        token,
        hostToken,
        method: "POST",
        body: payload ?? {},
        timeoutMs: timeouts.config,
      }),
  };
}

export type LegalworkServerClient = ReturnType<typeof createLegalworkServerClient>;
