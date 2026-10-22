export type PluginImportProvider = "chatgpt" | "claude";
export type PluginImportScope = "global" | "project";
export type PluginImportConnector = { name: string; project?: string; pluginRoot?: string };
export type PluginImportSource = { provider: PluginImportProvider; path: string; marketplace?: string; connector?: PluginImportConnector } | { provider: PluginImportProvider; zipBase64: string; filename?: string } | { provider: PluginImportProvider; url: string; ref?: string; directory?: string };
export type PluginImportCandidate = { path: string; marketplace?: string; name: string; version: string | null; displayName?: string; description?: string | null; kind?: "plugin" | "skill" | "connector"; connector?: PluginImportConnector; bundledIn?: { name: string; displayName?: string }; state?: "installed" | "disabled" | "available" | "synced" };
export type PluginImportReadiness = "ready" | "setup" | "partial" | "unsupported";
export type PluginImportRequirement = { kind: "dependency" | "app" | "runtime" | "permission"; name: string; code: string; message: string; required: boolean; status: "setup" | "blocked" | "changed" | "satisfied"; version?: string; marketplace?: string };
export type PluginImportProvenance = { provider: PluginImportProvider; kind: "folder" | "archive" | "github" | "configuration"; location: string; root: string; ref?: string; directory?: string; marketplace?: string; revision?: string; asWorkflow?: boolean; digest: string; version: string | null };
export type PluginImportHistory = { at: number; action: "installed" | "updated" | "rolled_back"; digest: string; version: string | null; revision?: string };
/** Public assessment only. Authentication secrets never belong in an import preview. */
export type ConnectorImportCheck = {
  name: string;
  installedName: string;
  status: "compatible" | "setup" | "unchecked" | "blocked";
  code: string;
  message: string;
  retryable?: boolean;
  inputs?: string[];
  documentationUrl?: string;
  declaredTransport?: "streamable-http";
};
export type PluginImportPreview = {
  id: string;
  digest: string;
  name: string;
  displayName?: string;
  description: string | null;
  version: string | null;
  format: "codex" | "claude" | "portable" | "skills" | "connectors";
  root: string;
  fileCount: number;
  bytes: number;
  components: Array<{ type: "skill" | "agent" | "command" | "mcp"; name: string; installedName: string }>;
  /** Import-time losses or behavior changes, not routine post-import setup. */
  warnings: string[];
  connectors?: ConnectorImportCheck[];
  requirements?: PluginImportRequirement[];
  readiness?: PluginImportReadiness;
  provenance?: PluginImportProvenance;
  /** Short-lived, server-owned preparation bound to this source, scope and workspace. */
  validationId?: string;
};
export type PluginImportRequest = { source: PluginImportSource; root?: string; scope: PluginImportScope; detectFormat?: boolean; digest?: string; validationId?: string; recheck?: boolean; acknowledgePartial?: boolean; asWorkflow?: boolean; workflowSkillsOnly?: boolean };

/** A new MCP connection, optionally bundled with existing skills and connectors. */
export type PluginCreateConnector =
  | { type: "remote"; url: string; headers?: Record<string, string>; oauth: false | { clientId?: string; clientSecret?: string; scope?: string } }
  | { type: "local"; command: string[]; environment?: Record<string, string> };

/** A personal bundle with optional new MCP configuration. */
export type PluginCreateRequest = { name: string; description?: string; skills: string[]; connectors: string[]; newConnector?: PluginCreateConnector };
export type PluginCreateOptions = { skills: Array<{ name: string; path: string; description: string }>; connectors: Array<{ name: string }> };
