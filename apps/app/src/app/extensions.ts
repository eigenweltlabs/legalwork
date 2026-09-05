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
  localCommandRef?: "legalwork.computerUseMcp" | "legalwork.uiMcp";
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
    schemaVersion: 1,
    id: "legalwork-voice",
    name: "Voice Mode",
    description: "Realtime voice control backed by the current session's authoritative OpenCode worker.",
    preview: true,
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/legalwork-mark.svg" },
    resources: [
      {
        type: "provider",
        id: "openai-realtime",
        label: "Connected OpenAI provider",
        providerId: "openai",
        required: true,
      },
    ],
    contributions: [
      { type: "native-capability", ref: "legalwork.voice.realtime", label: "Realtime voice" },
      { type: "control-actions", ref: "legalwork.voice.controls", location: "native" },
    ],
    enablement: [
      { type: "provider-connected", ref: "openai", label: "OpenAI provider connected" },
    ],
    defaultEnabled: true,
    defaultHidden: true,
    lifecycle: { detection: ["provider:openai"] },
    platform: ["darwin", "linux", "windows"],
  },
  {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Mac only: control Mac apps through semantic accessibility refs, screenshots, background-safe clicks, keyboard input, and strict mode.",
    preview: true,
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    icon: { src: "/legalwork-mark.svg" },
    composer: { prompt: "Use Computer Use to " },
    setup: {
      instructions: "Computer Use is Mac only. It runs as a local MCP server backed by the macOS accessibility runtime. Grant Accessibility and Screen Recording permissions when macOS asks, then connect the MCP server in this workspace.",
      primaryCta: "Connect Computer Use MCP",
      secondaryCta: "Check macOS permissions",
      testActionRef: "legalwork.computerUse.healthCheck",
    },
    resources: [
      {
        type: "mcp",
        id: "computer-use-mcp",
        label: "Computer Use MCP",
        mcpServerName: "computer-use",
        command: ["npx", "-y", "@legalwork/handsfree", "mcp"],
        localCommandRef: "legalwork.computerUseMcp",
        required: true,
      },
      {
        type: "native-binary",
        id: "computer-use-native",
        label: "macOS accessibility runtime",
        packageName: "@legalwork/handsfree",
        required: true,
      },
    ],
    contributions: [
      { type: "setup-instructions", ref: "legalwork.computerUse.setup", location: "settings-detail" },
      { type: "native-capability", ref: "legalwork.computerUse.axPermissions", label: "Accessibility and Screen Recording" },
      { type: "test-action", ref: "legalwork.computerUse.healthCheck", label: "Verify Computer Use MCP" },
      { type: "composer-prompt", prompt: "Use Computer Use to ", location: "composer" },
    ],
    enablement: [
      { type: "mcp-connected", ref: "computer-use", label: "MCP server connected" },
      { type: "permission-granted", ref: "accessibility", label: "Accessibility permission" },
      { type: "permission-granted", ref: "screenRecording", label: "Screen Recording permission" },
    ],
    lifecycle: { reload: ["mcp"], detection: ["mcp:computer-use"] },
    platform: ["darwin"],
  },
  {
    schemaVersion: 1,
    id: "google-workspace",
    name: "Google Workspace",
    description: "Let LegalWork read your Google Calendar and Google Drive (read-only).",
    preview: true,
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    icon: { simpleIconSlug: "google" },
    composer: { prompt: "Use Google Workspace to " },
    setup: {
      instructions: "Connect your Google account to read your Calendar and Drive in LegalWork.",
      primaryCta: "Connect Google Workspace",
      secondaryCta: "Test connection",
      testActionRef: "legalwork.googleWorkspace.testConnection",
    },
    resources: [
      { type: "provider", id: "google-oauth", label: "Google account", providerId: "google-workspace", required: true },
      { type: "local-service", id: "google-workspace-connector", label: "Secure local connection", required: true },
      { type: "tool", id: "google-calendar-read", label: "Calendar (read)", required: true },
      { type: "tool", id: "google-drive-selected-files", label: "Drive (read-only)", required: true },
      { type: "tool", id: "google-drive-full", label: "Drive write access (opt-in)", required: false },
      { type: "tool", id: "google-calendar-events", label: "Calendar events (opt-in)", required: false },
      { type: "tool", id: "google-chat", label: "Google Chat (opt-in)", required: false },
    ],
    contributions: [
      { type: "settings-panel", ref: "legalwork.googleWorkspace.settings", location: "settings-detail" },
      { type: "test-action", ref: "legalwork.googleWorkspace.testConnection", label: "Test Google Workspace" },
      { type: "composer-prompt", prompt: "Use Google Workspace to ", location: "composer" },
    ],
    lifecycle: { reload: ["config"], detection: ["provider:google-workspace"] },
  },
];
