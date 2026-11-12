import { t } from "@/i18n";
import { connectorDefinitions } from "@legalwork/types/connectors";
// Owned here: reload vocabulary is part of the extension manifest contract.
// types.ts re-exports it for the rest of the app.
export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type LegalWorkExtensionSourceFormat =
  | "legalwork-builtin"
  | "legalwork-extension-manifest"
  | "claude-plugin"
  | "opencode-plugin"
  | "mcp-directory"
  | "manual";

export type LegalWorkExtensionSource = {
  format: LegalWorkExtensionSourceFormat;
  trusted: boolean;
  origin?: "builtin" | "den" | "workspace" | "local";
  reference?: string;
};

export type LegalWorkExtensionResourceType =
  | "skill"
  | "agent"
  | "command"
  | "tool"
  | "mcp"
  | "opencode-plugin"
  | "provider"
  | "hook"
  | "context"
  | "secret"
  | "file"
  | "local-service"
  | "native-binary";

export type LegalWorkExtensionResource = {
  type: LegalWorkExtensionResourceType;
  id: string;
  label?: string;
  description?: string;
  path?: string;
  command?: string[];
  envKey?: string;
  packageName?: string;
  providerId?: string;
  mcpServerName?: string;
  localCommandRef?: "legalwork.openComputerUseMcp" | "legalwork.uiMcp" | "legalwork.actaportMcp";
  required?: boolean;
};

export type LegalWorkExtensionContributionType =
  | "settings-panel"
  | "setup-instructions"
  | "composer-prompt"
  | "session-side-panel"
  | "session-rail-item"
  | "control-actions"
  | "server-route"
  | "native-capability"
  | "test-action";

export type LegalWorkExtensionContribution = {
  type: LegalWorkExtensionContributionType;
  ref?: string;
  label?: string;
  description?: string;
  prompt?: string;
  location?: "settings-detail" | "composer" | "session-right-pane" | "session-rail" | "server" | "native";
};

export type LegalWorkExtensionSetup = {
  instructions?: string;
  primaryCta?: string;
  secondaryCta?: string;
  requiredEnv?: string[];
  testActionRef?: string;
};

export type LegalWorkExtensionLifecycle = {
  reload?: ReloadReason[];
  detection?: string[];
};

// ---------------------------------------------------------------------------
// Enablement — declarative conditions for extension "active" state
// ---------------------------------------------------------------------------

export type EnablementConditionType =
  | "mcp-connected"
  | "plugin-loaded"
  | "provider-connected"
  | "env-set"
  | "permission-granted"
  | "toggle-enabled";

export type EnablementCondition = {
  type: EnablementConditionType;
  /** What to check — MCP server name, plugin id, env key, etc. */
  ref: string;
  /** Human-readable label shown in the UI. */
  label: string;
};

/** Result of evaluating a single enablement condition at runtime. */
export type EnablementResult = {
  condition: EnablementCondition;
  met: boolean;
};

export type LegalWorkExtensionManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  preview?: boolean;
  source: LegalWorkExtensionSource;
  icon?: {
    src?: string;
    simpleIconSlug?: string;
  };
  composer?: {
    prompt: string;
  };
  setup?: LegalWorkExtensionSetup;
  resources: LegalWorkExtensionResource[];
  contributions?: LegalWorkExtensionContribution[];
  lifecycle?: LegalWorkExtensionLifecycle;
  /** Declarative conditions that must ALL be true for the extension to be "active". */
  enablement?: EnablementCondition[];
  defaultEnabled?: boolean;
  defaultHidden?: boolean;
  platform?: Array<"darwin" | "linux" | "windows" | "web">;
};

export function extensionContribution(
  manifest: LegalWorkExtensionManifest | undefined,
  type: LegalWorkExtensionContributionType,
): LegalWorkExtensionContribution | undefined {
  return manifest?.contributions?.find((contribution) => contribution.type === type);
}

export function extensionResource(
  manifest: LegalWorkExtensionManifest | undefined,
  type: LegalWorkExtensionResourceType,
): LegalWorkExtensionResource | undefined {
  return manifest?.resources.find((resource) => resource.type === type);
}

export function isTrustedBuiltInExtension(manifest: LegalWorkExtensionManifest | undefined): boolean {
  return manifest?.source.origin === "builtin" && manifest.source.trusted;
}

export const BUILT_IN_LEGALWORK_EXTENSION_MANIFESTS: LegalWorkExtensionManifest[] = [
  {
    schemaVersion: 1, id: "ris", get name() { return t("ris.name"); },
    get description() { return t("ris.description"); },
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true,
      reference: "https://www.ris.bka.gv.at/" },
    icon: { src: "/ext-ris.svg" },
    composer: { get prompt() { return t("ris.prompt"); } },
    resources: [{ type: "local-service", id: "ris-api", label: "RIS", required: true }],
    contributions: [{ type: "settings-panel", ref: "ris", location: "settings-detail" }],
    lifecycle: { detection: ["provider:ris"] },
  },
  ...connectorDefinitions.map(({ id, name, icon, descriptionKey, promptKey }): LegalWorkExtensionManifest => ({
    schemaVersion: 1, id, name,
    get description() { return t(descriptionKey); },
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    icon: { simpleIconSlug: icon },
    composer: { get prompt() { return t(promptKey, { name, id }); } },
    resources: [ { type: "provider", id, label: name, providerId: id, required: true } ],
    contributions: [ { type: "settings-panel", ref: id, location: "settings-detail" } ],
    lifecycle: { detection: [`provider:${id}`] },
  })),
  {
    schemaVersion: 1,
    id: "actaport",
    name: "Actaport",
    get description() { return t("actaport.description"); },
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/ext-actaport.svg" },
    composer: { get prompt() { return t("actaport.prompt"); } },
    resources: [{ type: "mcp", id: "actaport-mcp", mcpServerName: "actaport", command: ["legalwork-actaport-mcp"], localCommandRef: "legalwork.actaportMcp", required: true }],
    contributions: [{ type: "settings-panel", ref: "actaport", location: "settings-detail" }],
    enablement: [{ type: "mcp-connected", ref: "actaport", label: "Actaport" }],
    lifecycle: { reload: ["mcp"], detection: ["mcp:actaport"] },
    platform: ["darwin", "linux", "windows"],
  },
  {
    schemaVersion: 1,
    id: "legalwork-voice",
    name: "Voice Mode",
    get description() { return t("ext.voice_desc"); },
    preview: true,
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/legalwork-mark.svg" },
    resources: [
      {
        type: "provider",
        id: "openai-realtime",
        get label() { return t("ext.voice_provider_label"); },
        providerId: "openai",
        required: true,
      },
    ],
    contributions: [
      { type: "native-capability", ref: "legalwork.voice.realtime", get label() { return t("ext.voice_realtime_label"); } },
      { type: "control-actions", ref: "legalwork.voice.controls", location: "native" },
    ],
    enablement: [
      { type: "provider-connected", ref: "openai", get label() { return t("ext.voice_provider_connected"); } },
    ],
    defaultEnabled: true,
    defaultHidden: true,
    lifecycle: { detection: ["provider:openai"] },
    platform: ["darwin", "linux", "windows"],
  },
  {
    schemaVersion: 1,
    id: "open-computer-use",
    name: "Open Computer Use",
    get description() { return t("open_computer_use.description"); },
    preview: true,
    source: {
      format: "legalwork-builtin", origin: "builtin", trusted: true,
      reference: "https://github.com/iFurySt/open-codex-computer-use",
    },
    icon: { src: "/ext-open-computer-use.svg" },
    composer: { prompt: t("ext.composer_computer_use") },
    setup: { get instructions() { return t("open_computer_use.instructions"); } },
    resources: [
      {
        type: "mcp", id: "open-computer-use-mcp", mcpServerName: "open-computer-use",
        command: ["open-computer-use", "mcp"], localCommandRef: "legalwork.openComputerUseMcp", required: true,
        get label() { return t("open_computer_use.tools_label"); },
      },
      {
        type: "native-binary", id: "open-computer-use-runtime", packageName: "open-computer-use@1.1.0", required: true,
        get label() { return t("open_computer_use.runtime_label"); },
      },
    ],
    contributions: [
      { type: "settings-panel", ref: "legalwork.openComputerUse.settings", location: "settings-detail" },
      { type: "composer-prompt", prompt: t("ext.composer_computer_use"), location: "composer" },
    ],
    enablement: [
      { type: "mcp-connected", ref: "open-computer-use", get label() { return t("ext.cu_mcp_connected"); } },
    ],
    lifecycle: { reload: ["mcp"], detection: ["mcp:open-computer-use"] },
    platform: ["darwin", "windows"],
  },
  {
    schemaVersion: 1,
    id: "google-workspace",
    name: "Google Workspace",
    get description() { return t("ext.gw_desc"); },
    preview: true,
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    icon: { simpleIconSlug: "google" },
    composer: { prompt: t("ext.composer_google_workspace") },
    setup: {
      get instructions() { return t("ext.gw_instructions"); },
      get primaryCta() { return t("ext.gw_primary_cta"); },
      get secondaryCta() { return t("ext.gw_secondary_cta"); },
      testActionRef: "legalwork.googleWorkspace.testConnection",
    },
    resources: [
      { type: "provider", id: "google-oauth", get label() { return t("ext.gw_account_label"); }, providerId: "google-workspace", required: true },
      { type: "local-service", id: "google-workspace-connector", get label() { return t("ext.gw_local_service_label"); }, required: true },
      { type: "tool", id: "google-calendar-read", get label() { return t("ext.gw_calendar_read"); }, required: true },
      { type: "tool", id: "google-drive-selected-files", get label() { return t("ext.gw_drive_read"); }, required: true },
      { type: "tool", id: "google-drive-full", get label() { return t("ext.gw_drive_full"); }, required: false },
      { type: "tool", id: "google-calendar-events", get label() { return t("ext.gw_calendar_events"); }, required: false },
      { type: "tool", id: "google-chat", get label() { return t("ext.gw_chat"); }, required: false },
    ],
    contributions: [
      { type: "settings-panel", ref: "legalwork.googleWorkspace.settings", location: "settings-detail" },
      { type: "test-action", ref: "legalwork.googleWorkspace.testConnection", get label() { return t("ext.gw_test_label"); } },
      { type: "composer-prompt", prompt: t("ext.composer_google_workspace"), location: "composer" },
    ],
    lifecycle: { reload: ["config"], detection: ["provider:google-workspace"] },
  },
];
