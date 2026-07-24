import type { ModelRef, SuggestedPlugin } from "./types";
import { t } from "../i18n";
import {
  BUILT_IN_LEGALWORK_EXTENSION_MANIFESTS,
  extensionContribution,
  extensionResource,
  isTrustedBuiltInExtension,
  type LegalWorkExtensionManifest,
} from "./extensions";

export const MODEL_PREF_KEY = "legalwork.defaultModel";
export const SESSION_MODEL_PREF_KEY = "legalwork.sessionModels";
export const THINKING_PREF_KEY = "legalwork.showThinking";
export const VARIANT_PREF_KEY = "legalwork.modelVariant";
export { LANGUAGE_PREF_KEY } from "../i18n";
export const HIDE_TITLEBAR_PREF_KEY = "legalwork.hideTitlebar";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [];

export type ExtensionKind = "mcp" | "plugin" | "skill" | "ui-control" | "extension";

export type McpDirectoryInfo = {
  id?: string;
  /** Display name shown in the UI. */
  name: string;
  /** Safe server name for opencode.jsonc (alphanumeric, - and _ only). Auto-derived from name if omitted. */
  serverName?: string;
  description: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  /** Static auth headers for a remote MCP (e.g. { Authorization: "Bearer …" }).
   * When set, the server connects via these headers and skips OAuth — the way to
   * connect token-authed servers like iManage that reject the engine's OAuth redirect. */
  headers?: Record<string, string>;
  oauth: boolean;
  oauthConfig?: {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
  };
  /** Extension category for UI grouping. Defaults to "mcp". */
  kind?: ExtensionKind;
  /** Simple Icons slug for brand icon (e.g. "notion", "stripe", "figma"). */
  iconSlug?: string;
  /** Direct icon URL (e.g. local SVG). Takes priority over iconSlug. */
  iconSrc?: string;
  /** Prompt inserted from the composer extension picker. */
  composerPrompt?: string;
  /** Whether LegalWork should show this extension as enabled before user setup. */
  defaultEnabled?: boolean;
  /** Whether LegalWork should hide this extension from the default catalog view. */
  defaultHidden?: boolean;
  /** Whether this extension is still in preview. */
  preview?: boolean;
  /**
   * Vendor partner/program URL for connectors that are gated to named AI
   * clients and cannot be self-connected from here yet. When set, the catalog
   * shows a "Request access" link instead of an OAuth connect flow.
   */
  requestAccessUrl?: string;
  /**
   * Connector whose vendor has no OAuth dynamic client registration: the firm
   * supplies its own OAuth app clientId/secret. When set, Connect opens a setup
   * form to collect them (written into the MCP config's `oauth`). A url with
   * {placeholder} segments also triggers that form (to fill in instance/tenant).
   */
  requiresOauthClient?: boolean;
  /**
   * Connector that authenticates as a public OAuth client (PKCE): only a client
   * ID is collected, never a secret. Pairs with `requiresOauthClient` so the
   * setup form drops the secret field (e.g. RelativityOne issues a Client ID
   * but no secret).
   */
  oauthClientIdOnly?: boolean;
  /**
   * Connector whose OAuth the local engine can't complete (e.g. iManage rejects the
   * engine's http-loopback redirect URI). Connect opens a setup form that collects an
   * access token and connects via Authorization: Bearer instead of OAuth.
   */
  requiresToken?: boolean;
  /** Normalized extension manifest backing this catalog entry. */
  extensionManifest?: LegalWorkExtensionManifest;
};

function extensionManifestToDirectoryInfo(manifest: LegalWorkExtensionManifest): McpDirectoryInfo {
  const mcpResource = extensionResource(manifest, "mcp");
  return {
    id: manifest.id,
    name: manifest.name,
    serverName: mcpResource?.mcpServerName ?? manifest.id,
    description: manifest.description,
    type: mcpResource?.command ? "local" : undefined,
    command: mcpResource?.command,
    oauth: false,
    kind: "extension",
    iconSlug: manifest.icon?.simpleIconSlug,
    iconSrc: manifest.icon?.src,
    composerPrompt: extensionContribution(manifest, "composer-prompt")?.prompt ?? manifest.composer?.prompt,
    defaultEnabled: manifest.defaultEnabled,
    defaultHidden: manifest.defaultHidden,
    preview: manifest.preview,
    extensionManifest: manifest,
  };
}

export function isBuiltInLegalWorkExtension(entry: Pick<McpDirectoryInfo, "kind" | "extensionManifest">): boolean {
  return entry.kind === "extension" && isTrustedBuiltInExtension(entry.extensionManifest);
}

/** Derive a safe MCP server name from a display name or explicit serverName. */
export function getMcpServerName(entry: McpDirectoryInfo): string {
  if (entry.serverName) return entry.serverName;
  return entry.name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "mcp";
}

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    get name() { return t("mcp.quick_connect_notion_title"); },
    serverName: "notion",
    get description() { return t("mcp.quick_connect_notion_desc"); },
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "notion",
    iconSrc: "/ext-notion.svg",
  },
  // Law-firm document, eDiscovery, contract, and legal-research connectors.
  // Endpoints verified against live vendor docs (mid-2026). Entries marked
  // `preview` need a firm admin to enable the server vendor-side and/or the
  // firm to substitute an instance/tenant segment in the URL before Connect
  // works (no dynamic client registration). See the connector catalog notes.
  {
    get name() { return t("mcp.quick_connect_imanage_title"); },
    serverName: "imanage",
    get description() { return t("mcp.quick_connect_imanage_desc"); },
    // Cloud-only, per-service path (/mcp/work; also /mcp/tracker, /mcp/insightplus).
    // iManage's OAuth requires an HTTPS redirect URI, but the local engine only offers an
    // http loopback, which iManage rejects ("redirect_uris must be absolute URLs with
    // allowed protocols") — so connect via an access token instead of OAuth.
    url: "https://cloudimanage.com/mcp/work",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "CB Insights",
    serverName: "cbinsights",
    description: "Company, funding, market, and industry intelligence from CB Insights.",
    // Bearer-token protected resource (bearer_methods_supported: ["header"]). Connect
    // with an access token rather than the engine's OAuth.
    url: "https://mcp.cbinsights.com",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Courtroom5",
    serverName: "courtroom5",
    description: "Litigation research and case-prep tools from Courtroom5.",
    // Bearer-token protected: connecting without auth fails and the server shows
    // as offline. Connect with an access token (Authorization: Bearer) rather
    // than the engine's OAuth.
    url: "https://mcp.courtroom5.com/v1",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  // --- Token-authed legal/research MCP connectors (Bearer in the Authorization header;
  // the engine's OAuth isn't used — paste an access token in the setup form). ---
  {
    name: "Ironclad",
    serverName: "ironclad",
    description: "Contract lifecycle management — search and analyze contracts in Ironclad.",
    url: "https://mcp.na1.ironcladapp.com/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Lawve",
    serverName: "lawve",
    description: "AI legal research and drafting tools from Lawve.",
    url: "https://mcp.lawve.ai/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Legal Data Hunter",
    serverName: "legaldatahunter",
    description: "Legal data search and research.",
    url: "https://legaldatahunter.com/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Midpage",
    serverName: "midpage",
    description: "Case-law research and citations from Midpage.",
    url: "https://app.midpage.ai/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Quartr",
    serverName: "quartr",
    description: "Earnings calls, investor documents, and company data from Quartr.",
    url: "https://mcp.quartr.com/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Solve Intelligence",
    serverName: "solveintelligence",
    description: "Patent drafting and IP tooling from Solve Intelligence.",
    url: "https://api.solveintelligence.com/mcp/",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "TechGC (TopCounsel)",
    serverName: "techgc",
    description: "Legal ops and general-counsel tools from TechGC.",
    url: "https://api.techgc.co/api/mcp/topcounsel",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Verisk",
    serverName: "verisk",
    description: "Underwriting and risk intelligence from Verisk.",
    url: "https://gatewaymcp.verisk.com/underwriting/intelligencemcp/v1",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "CourtListener",
    serverName: "courtlistener",
    description: "Federal and state case law, dockets, and opinions from CourtListener.",
    url: "https://mcp.courtlistener.com/",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Daloopa",
    serverName: "daloopa",
    description: "Financial fundamentals and data from Daloopa.",
    url: "https://mcp.daloopa.com/server/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Dun & Bradstreet Risk Analytics",
    serverName: "dnb-risk",
    description: "Company risk and credit analytics from Dun & Bradstreet.",
    url: "https://agents.riskanalytics.dnb.com/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Datasite",
    serverName: "datasite",
    description: "M&A and due-diligence data-room tools from Datasite.",
    url: "https://mcp.global.datasite.com/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Everlaw",
    serverName: "everlaw",
    description: "Ediscovery and litigation document review from Everlaw.",
    url: "https://api.everlaw.com/v1/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "IBISWorld",
    serverName: "ibisworld",
    description: "Industry research and market reports from IBISWorld.",
    url: "https://mcp.ibisworld.com",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    name: "Descrybe",
    serverName: "descrybe",
    description: "Legal research and case summaries from Descrybe.",
    // Bearer-token protected: the server returns unauthorized without an access
    // token. Connect with a token (Authorization: Bearer) rather than OAuth.
    url: "https://mcp.descrybe.com/mcp",
    type: "remote",
    oauth: false,
    requiresToken: true,
    kind: "mcp",
    preview: true,
  },
  {
    get name() { return t("mcp.quick_connect_sharepoint_title"); },
    serverName: "sharepoint",
    get description() { return t("mcp.quick_connect_sharepoint_desc"); },
    // Official ODSP/Work IQ remote server. {tenant_id} is per-firm; tenant
    // admin must consent in the M365 admin center before connecting.
    url: "https://agent365.svc.cloud.microsoft/agents/tenants/{tenant_id}/servers/mcp_SharePointRemoteServer",
    type: "remote",
    oauth: true,
    kind: "mcp",
    preview: true,
    requiresOauthClient: true,
  },
  {
    get name() { return t("mcp.quick_connect_box_title"); },
    serverName: "box",
    get description() { return t("mcp.quick_connect_box_desc"); },
    url: "https://mcp.box.com",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "box",
    requiresOauthClient: true,
  },
  {
    get name() { return t("mcp.quick_connect_egnyte_title"); },
    serverName: "egnyte",
    get description() { return t("mcp.quick_connect_egnyte_desc"); },
    // Single managed multi-tenant endpoint; tenant resolved via OAuth. The
    // Egnyte admin must allow external LLM clients before users can connect.
    url: "https://mcp-server.egnyte.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "egnyte",
    preview: true,
  },
  {
    get name() { return t("mcp.quick_connect_google_cloud_storage_title"); },
    serverName: "google-cloud-storage",
    get description() { return t("mcp.quick_connect_google_cloud_storage_desc"); },
    // Global endpoint; a project admin enables the Cloud Storage API and
    // provisions the OAuth client (8 MiB/object cap, IAM-governed).
    url: "https://storage.googleapis.com/storage/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "googlecloud",
    preview: true,
    requiresOauthClient: true,
  },
  {
    get name() { return t("mcp.quick_connect_ironclad_title"); },
    serverName: "ironclad",
    get description() { return t("mcp.quick_connect_ironclad_desc"); },
    // Region-specific host (na1 = North America, eu1 = EU). Swap the region
    // and have an Ironclad admin register the OAuth app before connecting.
    url: "https://mcp.na1.ironcladapp.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    preview: true,
    requiresOauthClient: true,
  },
  {
    get name() { return t("mcp.quick_connect_everlaw_title"); },
    serverName: "everlaw",
    get description() { return t("mcp.quick_connect_everlaw_desc"); },
    // Regional API host (api.everlaw.com US, api.everlaw.co.uk UK). Real path is
    // /v1/mcp (bare /mcp redirects to docs). An org admin enables the OAuth2
    // setting and pre-registers an OAuth app (no dynamic client registration).
    url: "https://api.everlaw.com/v1/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    preview: true,
    requiresOauthClient: true,
  },
  {
    get name() { return t("mcp.quick_connect_highq_title"); },
    serverName: "highq",
    get description() { return t("mcp.quick_connect_highq_desc"); },
    // Instance + site templated; the HighQ Primary Owner/Owner configures the
    // MCP connector at the Enterprise level. Replace {instance} and {site}.
    url: "https://{instance}.highq.com/{site}/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    preview: true,
  },
  {
    get name() { return t("mcp.quick_connect_courtlistener_title"); },
    serverName: "courtlistener",
    get description() { return t("mcp.quick_connect_courtlistener_desc"); },
    // Free, first-party Free Law Project server. Standard OAuth with dynamic
    // client registration — genuine one-click, no firm-admin step.
    url: "https://mcp.courtlistener.com/",
    type: "remote",
    oauth: true,
    kind: "mcp",
  },
  {
    get name() { return t("mcp.quick_connect_dingduff_title"); },
    serverName: "dingduff",
    get description() { return t("mcp.quick_connect_dingduff_desc"); },
    // Attorney-built legal research server (github.com/DingDuff/dingduff-public):
    // court opinions, federal/state statutes and rules, and PACER dockets via
    // plain-English search. One-click: standard MCP OAuth — a sign-in window
    // opens on dingduff.com and returns automatically. Each user needs their
    // own DingDuff account (free while in beta; licensed attorneys per ToS).
    url: "https://app.dingduff.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
  },
  {
    get name() { return t("mcp.quick_connect_ruly_title"); },
    serverName: "ruly",
    get description() { return t("mcp.quick_connect_ruly_desc"); },
    // Jurisdiction-specific court rules, local rules, and procedural statutes.
    // One-click: OAuth 2.1 + PKCE with dynamic client registration; the desktop
    // loopback redirect is permitted on any port, so no firm-admin step. Each
    // user needs their own Ruly account with an MCP-enabled subscription (the
    // server returns 403 not_entitled until it's activated).
    url: "https://mcp.askruly.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
  },
  {
    get name() { return t("mcp.quick_connect_taxgraph_title"); },
    serverName: "taxgraph",
    get description() { return t("mcp.quick_connect_taxgraph_desc"); },
    // DE/EU-hosted German tax-law graph. One-click: OAuth with dynamic client
    // registration via Clerk. Real endpoint is the mcp. subdomain — the bare
    // tax-graph.com/mcp is the marketing site and 405s (this was err_be730ea2).
    url: "https://mcp.tax-graph.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
  },
  {
    get name() { return t("mcp.quick_connect_dropbox_title"); },
    serverName: "dropbox",
    get description() { return t("mcp.quick_connect_dropbox_desc"); },
    // One-click: OAuth with dynamic client registration. Dropbox forces
    // loopback, port-less redirect URIs — the host's OAuth helper must use one.
    url: "https://mcp.dropbox.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "dropbox",
  },
  {
    get name() { return t("mcp.quick_connect_netdocuments_title"); },
    serverName: "netdocuments",
    get description() { return t("mcp.quick_connect_netdocuments_desc"); },
    // US pod (swap us->de for EU). OAuth with dynamic client registration works;
    // the firm must be ndMAX Enterprise with MCP enabled or tools come back empty.
    url: "https://web-api.us.netdocuments.app/connect/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    preview: true,
  },
  {
    get name() { return t("mcp.quick_connect_relativity_title"); },
    serverName: "relativity",
    get description() { return t("mcp.quick_connect_relativity_desc"); },
    // RelativityOne instance MCP server. {tenantHostname} is the first segment
    // of the firm's RelativityOne URL (e.g. kcura.relativity.one → "kcura").
    // Relativity Support enables the server and issues the OAuth Client ID; it
    // is a public client (PKCE), so no client secret. The signed-in user must
    // be a RelativityOne System Administrator and acts as themselves.
    url: "https://{tenantHostname}.relativity.one/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    preview: true,
    requiresOauthClient: true,
    oauthClientIdOnly: true,
  },
  {
    get name() { return t("mcp.quick_connect_legalwork_ui_title"); },
    serverName: "legalwork-ui",
    get description() { return t("mcp.quick_connect_legalwork_ui_desc"); },
    type: "local",
    // Dev builds replace this with the local checkout path before writing config.
    command: ["npx", "-y", "legalwork-ui-mcp"],
    oauth: false,
    kind: "ui-control",
    iconSrc: "/legalwork-mark.svg",
  },
  ...BUILT_IN_LEGALWORK_EXTENSION_MANIFESTS.map(extensionManifestToDirectoryInfo),
];

export const LEGALWORK_EXTENSION_CATALOG = MCP_QUICK_CONNECT.filter((entry) => entry.kind === "extension");
