import type { ConnectorImportCheck } from "@legalwork/types/plugin-import";
import { connectorConfigVariables } from "./connector-config.js";

export function importRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Claude pins a string under oauth.scopes; Codex pins a top-level list.
 * null means an explicit declaration cannot be ported without changing it. */
export function importedConnectorScope(source: Record<string, unknown>): string | null | undefined {
  const oauth = importRecord(source.oauth) ? source.oauth : {};
  const values: string[] = [];
  for (const field of ["scope", "scopes"]) {
    const value = oauth[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) return null;
    values.push(value);
  }
  if (source.scopes !== undefined) {
    if (!Array.isArray(source.scopes) || !source.scopes.length || source.scopes.some(value => typeof value !== "string" || !value || /\s/.test(value))) return null;
    values.push(source.scopes.join(" "));
  }
  const identity = (value: string) => JSON.stringify([...new Set(value.trim().split(/\s+/))].sort());
  if (values.some(value => identity(value) !== identity(values[0]))) return null;
  return values[0];
}

/** Assess source semantics before normalization can discard unsupported settings. */
export function assessImportedConnector(name: string, installedName: string, source: Record<string, unknown>, config: Record<string, unknown>): ConnectorImportCheck {
  const base = { name, installedName };
  const block = (code: string, message: string): ConnectorImportCheck => ({ ...base, status: "blocked", code, message });
  const transport = source.type ?? source.transport;
  if (transport !== undefined && !["http", "sse", "streamable-http", "stdio", "remote", "local"].includes(String(transport))) {
    return block("transport", `This connector uses ${String(transport)} transport, which LegalWork cannot run. Ask for an HTTP, SSE or local program configuration.`);
  }
  if (["http", "sse", "streamable-http", "remote"].includes(String(transport)) && typeof source.url !== "string" || ["stdio", "local"].includes(String(transport)) && (!source.command || source.url)) return block("configuration", "The declared transport does not match this connector's address or program. Obtain a corrected configuration from the provider.");
  for (const field of ["env", "environment", "headers", "http_headers"]) if (source[field] !== undefined && (!importRecord(source[field]) || Object.values(source[field]).some(value => typeof value !== "string"))) return block("configuration", "The connector contains invalid environment or header values. Obtain a corrected configuration from the provider.");
  if (source.headersHelper || source.http_headers_helper) return block("credential_helper", "This connector depends on a credential script from its original app. LegalWork cannot run that script. Use a connector configuration with a supported sign-in method or a credential you can enter directly.");
  if (source.auth === "chatgpt") return block("platform_session", "This connector uses your ChatGPT session. That session cannot be used by LegalWork. Obtain a separate connector configuration from the provider.");
  if (Array.isArray(source.env_vars) && source.env_vars.some(entry => importRecord(entry) && entry.source === "remote")) return block("remote_execution", "This program depends on an environment provided by Codex's remote executor. LegalWork cannot supply that environment.");
  const forwarded = Array.isArray(source.env_vars) ? source.env_vars.filter((value): value is string => typeof value === "string") : [];
  const environment = { ...(importRecord(source.env) ? source.env : {}), ...(importRecord(source.environment) ? source.environment : {}) };
  const hostBindings = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_ELECTRON_RESOURCES_PATH", "CODEX_MANAGED_PACKAGE_ROOT", "NODE_REPL_TRUSTED_SERVICES", "CUA_REPL_NODE_REPL_PATH"];
  if (hostBindings.some(key => forwarded.includes(key) || Object.hasOwn(environment, key))) return block("source_runtime", "This connector depends on the original ChatGPT/Codex desktop runtime or its private communication channel. Those services do not transfer to LegalWork. Obtain a standalone connector configuration instead.");
  if (["enabled_tools", "disabled_tools", "default_tools_approval_mode", "omit_tools_from"].some(key => source[key] !== undefined) || importRecord(source.tools) && Object.values(source.tools).some(value => importRecord(value) && value.approval_mode !== undefined)) return block("tool_policy", "This connector declares tool access or approval rules that LegalWork cannot preserve. Adapt those rules to LegalWork before importing so the connector does not gain different permissions.");
  const oauth = importRecord(source.oauth) ? source.oauth : {};
  if (importedConnectorScope(source) === null) return block("pinned_scopes", "This connector declares empty, invalid or conflicting sign-in permissions that LegalWork cannot preserve. Obtain a configuration approved for LegalWork before importing.");
  const auth = importRecord(source.extensions) && importRecord(source.extensions["com.openai"]) && importRecord(source.extensions["com.openai"].auth) ? source.extensions["com.openai"].auth : {};
  if (auth.type !== undefined && !["none", "api_key", "oauth", "mixed"].includes(String(auth.type))) return block("authentication", "The source declares an authentication method LegalWork does not support.");
  const fixedDefaultScopes = Array.isArray(auth.defaultScopes) && auth.defaultScopes.length > 0
    && (auth.baseScopes === undefined || Array.isArray(auth.baseScopes) && auth.baseScopes.length === 0);
  if ((auth.baseScopes !== undefined || auth.defaultScopes !== undefined) && !fixedDefaultScopes) return block("pinned_scopes", "This connector uses default or required sign-in permission rules that LegalWork cannot preserve. Obtain a configuration approved for LegalWork before importing.");
  const overrides = ["authServerMetadataUrl", "authorizationUrl", "tokenUrl", "registrationUrl", "authorizationServerBase", "resource", "oidcConfigurationUrl", "oidcUserinfoEndpoint", "oidcScopesSupported"];
  if (overrides.some(key => oauth[key] !== undefined || auth[key] !== undefined) || auth.oidcEnabled !== undefined) return block("oauth_override", "This connector requires custom sign-in discovery, endpoints or identity settings that LegalWork cannot preserve. Ask the provider for a standard MCP OAuth configuration.");
  const client = importRecord(auth.client) ? auth.client : {};
  const method = client.tokenEndpointAuthMethod ?? oauth.tokenEndpointAuthMethod;
  if (method !== undefined && !["none", "client_secret_post"].includes(String(method))) return block("client_authentication", `This connector requires ${String(method)} client authentication. LegalWork currently supports public clients and client_secret_post.`);
  if (client.mode !== undefined && !["provided", "dcr", "cimd"].includes(String(client.mode))) return block("registration_mode", "The source declares an unsupported client registration method.");
  const configuredOAuth = importRecord(config.oauth) ? config.oauth : {};
  if (typeof configuredOAuth.clientId === "string" && /^https?:\/\//i.test(configuredOAuth.clientId)) return block("client_metadata_identity", "This connector uses a client metadata identity from its original app. LegalWork needs its own OAuth registration and cannot reuse that identity.");
  if (typeof configuredOAuth.redirectUri === "string" && !connectorConfigVariables(configuredOAuth.redirectUri).length) {
    try {
      const callback = new URL(configuredOAuth.redirectUri);
      if (callback.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callback.hostname) || callback.username || callback.password || callback.search || callback.hash) return block("callback", "This connector requires an external or unsupported sign-in callback. LegalWork needs a local HTTP callback registered with the provider.");
    } catch { return block("callback", "This connector has an invalid sign-in callback address."); }
  }
  if (configuredOAuth.callbackPort !== undefined && (typeof configuredOAuth.callbackPort !== "number" || !Number.isInteger(configuredOAuth.callbackPort) || configuredOAuth.callbackPort < 1 || configuredOAuth.callbackPort > 65535)) return block("callback", "This connector has an invalid sign-in callback port.");
  if (method === "none" && configuredOAuth.clientSecret) return block("client_authentication", "This export includes a client secret for a public OAuth client. Obtain a configuration with the correct client authentication method.");
  if (client.mode === "provided" && !configuredOAuth.clientId) return block("missing_registration", "The provider requires a registered OAuth application, but this export does not include its client ID. Ask your administrator for a LegalWork-compatible registration.");
  if (auth.type === "api_key" && auth.headerName !== undefined && auth.headerScheme !== "custom_header") return block("credential_header", "An API key header name is only valid with custom-header authentication. Obtain a corrected configuration from the provider.");
  if (auth.type === "api_key" && (!auth.headerScheme || !["bearer", "basic", "custom_header"].includes(String(auth.headerScheme)) || auth.headerScheme === "custom_header" && (typeof auth.headerName !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(auth.headerName) || /^host$/i.test(auth.headerName)))) return block("credential_header", "This export does not define a valid API key header. Ask the provider for a corrected configuration.");
  if (connectorConfigVariables(config).some(input => /^(?:CLAUDE_(?:PLUGIN_DATA|PROJECT_DIR|SESSION_ID)|CODEX_(?:THREAD_ID|PROJECT_DIR|SESSION_ID))$/.test(input))) return block("platform_configuration", "This connector depends on runtime values supplied by its original app. LegalWork cannot reproduce that runtime.");
  const url = typeof config.url === "string" ? config.url : undefined;
  if (config.command !== undefined && !(typeof config.command === "string" && config.command.trim() || Array.isArray(config.command) && config.command.length && config.command.every(part => typeof part === "string") && typeof config.command[0] === "string" && config.command[0].trim())) return block("configuration", "This export has an invalid program command. Obtain a corrected configuration from the provider.");
  if (url && config.command) return block("configuration", "This export declares both a remote address and a local program. Obtain a configuration with one supported transport.");
  if (!url && !config.command) return block("configuration", "This export has no connector address or program to run.");
  if (url && !connectorConfigVariables(url).length) {
    try {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return block("address", "Use an HTTP or HTTPS connector address without credentials embedded in it.");
      if (parsed.hostname === "mcp.figma.com" && config.oauth !== false && !configuredOAuth.clientId) return { ...block("provider_approval", "Figma's hosted connector accepts approved applications. LegalWork is not currently an approved application, so this connection cannot be imported. Figma's desktop connector is a separate supported option."), documentationUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/" };
    } catch { return block("address", "The connector address is invalid. Correct it in the source and review again."); }
  }
  const inputs = connectorConfigVariables(config);
  if (auth.type === "api_key") return { ...base, status: "setup", code: "api_key", message: "Enter this provider's API key in connector setup after importing. Credentials saved in the original app are not transferred.", inputs };
  if (inputs.length) return { ...base, status: "setup", code: "inputs", message: "Enter the required values in connector setup after importing. Credentials saved in the original app are not transferred.", inputs };
  if (!url) return { ...base, status: "setup", code: "local_program", message: "This connector runs a program on the LegalWork server. Its dependencies must be installed there. Import checks do not execute the program." };
  return { ...base, status: "unchecked", code: "remote_check", message: "Check this provider's connection and sign-in requirements before importing." };
}
