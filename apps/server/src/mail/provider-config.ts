/** Configuration checks only: no environment, network, credentials, or account access. */
export const GMAIL_MAIL_SCOPES: readonly string[] = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"];
export const GRAPH_MAIL_SCOPES: readonly string[] = ["openid", "profile", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];

type InstalledAppSettings = {
  applicationType: "desktop";
  clientId: string;
  redirectUri: string;
  pkceMethod: "S256";
  scopes: readonly string[];
};

export type MailProviderConfig = InstalledAppSettings & (
  | { provider: "gmail"; clientSecretConfigured: boolean }
  | { provider: "graph"; tenantId: string; registeredRedirectUri: string }
);

export type MailProviderConfigIssue =
  | "desktop_app_required" | "invalid_client_id" | "s256_required"
  | "unsafe_redirect" | "missing_required_scopes" | "google_client_secret_missing"
  | "explicit_tenant_required" | "registered_redirect_mismatch";

export type MailProviderReadiness = {
  provider: "gmail" | "graph";
  configurationReady: boolean;
  authorization: "not_checked";
  issues: MailProviderConfigIssue[];
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loopbackUri(value: string, provider: "gmail" | "graph"): URL | undefined {
  // Reject URL parser normalization of alternate IP forms, backslashes and whitespace.
  const hostPattern = provider === "gmail" ? "(?:127\\.0\\.0\\.1|\\[::1\\])" : "(?:127\\.0\\.0\\.1|localhost)";
  if (!new RegExp(`^http://${hostPattern}(?::[1-9][0-9]{0,4})?(?:/[^?#\\\\\\s]*)?$`).test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return;
    return url;
  } catch {
    return;
  }
}

/** Graph accepts a configured organizational tenant or the explicit personal-account authority. */
export function checkMailProviderReadiness(config: MailProviderConfig): MailProviderReadiness {
  const issues: MailProviderConfigIssue[] = [];
  if (config.applicationType !== "desktop") issues.push("desktop_app_required");
  if (config.pkceMethod !== "S256") issues.push("s256_required");
  const clientIdValid = config.provider === "gmail"
    ? /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.clientId)
    : GUID.test(config.clientId);
  if (!clientIdValid) issues.push("invalid_client_id");
  const redirect = loopbackUri(config.redirectUri, config.provider);
  if (!redirect) issues.push("unsafe_redirect");
  const requiredScopes = config.provider === "gmail" ? GMAIL_MAIL_SCOPES : GRAPH_MAIL_SCOPES;
  if (!requiredScopes.every((scope) => config.scopes.includes(scope))) issues.push("missing_required_scopes");
  if (config.provider === "gmail") {
    if (!config.clientSecretConfigured) issues.push("google_client_secret_missing");
  } else {
    if (config.tenantId !== "consumers" && !GUID.test(config.tenantId)) issues.push("explicit_tenant_required");
    const registered = loopbackUri(config.registeredRedirectUri, "graph");
    const matches = redirect && registered && redirect.hostname === registered.hostname
      && redirect.pathname === registered.pathname
      && (redirect.hostname === "localhost" || redirect.port === registered.port);
    if (!matches) issues.push("registered_redirect_mismatch");
  }
  return { provider: config.provider, configurationReady: issues.length === 0, authorization: "not_checked", issues };
}
