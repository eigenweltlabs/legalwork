import { connectorConfigVariables, connectorUsesOAuth, resolveConnectorConfig } from "@legalwork/types/connector-config";
import type { McpServerConfig, McpServerEntry } from "./types";
import type { McpDirectoryInfo } from "./constants";
import { mcpAuthEntryFromServer } from "./mcp-connect-state";

export function editableConnectorConfig(config: McpServerConfig): McpServerConfig {
  return { ...config, ...(!connectorUsesOAuth(config) ? { oauth: false } : {}), ...(config.url?.includes("configure-before-connecting.invalid") ? { url: "${SERVER_URL}" } : {}) };
}
export function connectorNeedsSetup(config: McpServerConfig, configured?: McpServerEntry["configured"]): boolean {
  return (configured?.variables ?? connectorConfigVariables(editableConnectorConfig(config))).length > 0;
}
export function usesBasicCredentialTemplate(config: McpServerConfig): boolean {
  return Object.entries(config.headers ?? {}).some(([name, value]) => /^authorization$/i.test(name) && value === "Basic ${BASIC_AUTH_CREDENTIALS}");
}

/** Blank fields in a saved-value form preserve the private server value. */
export function savedConnectorEditConfig(entry: McpServerEntry, config: McpServerConfig): McpServerConfig {
  if (!entry.configured) return config;
  const next = { ...config };
  if (!next.url?.trim()) delete next.url;
  if (!next.command?.[0]?.trim()) delete next.command;
  if (!next.cwd?.trim()) delete next.cwd;
  for (const field of ["headers", "environment"] satisfies Array<"headers" | "environment">) {
    if (next[field]) next[field] = Object.fromEntries(Object.entries(next[field]).filter(([, value]) => value.trim()));
  }
  if (next.oauth) next.oauth = Object.fromEntries(Object.entries(next.oauth).filter(([, value]) => value !== "" && value !== undefined));
  return next;
}
export function configuredConnectorEntry(entry: McpServerEntry, config: McpServerConfig, values: Record<string, string>): McpDirectoryInfo {
  if (entry.editable === false) throw new Error("Edit this connector in its authored OpenCode configuration.");
  const answers = { ...values };
  if (usesBasicCredentialTemplate(config) && answers.BASIC_AUTH_CREDENTIALS) answers.BASIC_AUTH_CREDENTIALS = btoa(String.fromCharCode(...new TextEncoder().encode(answers.BASIC_AUTH_CREDENTIALS)));
  const resolved = resolveConnectorConfig(config, answers);
  if (resolved.type === "remote" && (resolved.url || !entry.configured?.url)) {
    const url = new URL(resolved.url ?? "");
    if (!/^https?:$/.test(url.protocol) || /[{}]/.test(resolved.url ?? "")) throw new Error("Enter a complete server URL.");
  }
  return {
    ...mcpAuthEntryFromServer({ ...entry, config: resolved }),
    type: resolved.type,
    url: resolved.url,
    command: resolved.command,
    cwd: resolved.cwd,
    timeout: resolved.timeout,
    environment: resolved.environment,
    headers: resolved.headers,
    oauth: connectorUsesOAuth(resolved) ? resolved.oauth ? true : undefined : false,
    oauthConfig: resolved.oauth || undefined,
    existingConfig: resolved,
    ...(entry.configured ? { configured: entry.configured, editable: entry.editable, configEdit: { variables: values } } : {}),
  };
}
