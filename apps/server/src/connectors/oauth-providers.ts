import type { ConnectorOAuthClientInput } from "./schema.js";
import type { OAuthApplication } from "../file-storage/oauth/providers.js";
import { ApiError } from "../errors.js";
import { connectionProvider } from "./definition.js";

export const connectorOAuthPort = 53683;

// Public desktop application ID. Microsoft native clients use PKCE, not a secret.
export const legalworkMicrosoftClientId = "d3a9a5d6-889f-4ee2-a0f0-781ddf14d0b7";

export function defaultConnectorOAuthClient(id: string): ConnectorOAuthClientInput | undefined {
  const provider = connectionProvider(id);
  if (!["outlook", "onedrive", "onedrive-personal", "sharepoint-files"].includes(provider)) return;
  return { clientId: legalworkMicrosoftClientId,
    tenantId: provider === "onedrive-personal" ? "consumers" : provider === "outlook" ? "common" : "organizations" };
}

export function connectorOAuthProvider(id: string, client: ConnectorOAuthClientInput, writeIds: string[]) {
  const provider = connectionProvider(id);
  const readOnly = !writeIds.includes(provider);
  const googleScopes: Record<string, string[]> = {
    gmail: ["https://www.googleapis.com/auth/gmail.readonly", ...readOnly ? [] : ["https://www.googleapis.com/auth/gmail.compose"]],
    "google-calendar": ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", `https://www.googleapis.com/auth/calendar.events${readOnly ? ".readonly" : ""}`],
    "google-drive": [`https://www.googleapis.com/auth/drive${readOnly ? ".readonly" : ""}`],
  };
  const scopes = googleScopes[provider];
  if (scopes) {
    const application: OAuthApplication = {
      clientId: client.clientId, clientSecret: client.clientSecret,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
      authorizeParams: { access_type: "offline", prompt: "consent" }, scopes: () => scopes,
      port: connectorOAuthPort, redirectHost: "127.0.0.1",
    };
    return { application, family: "google", supportsClientSecret: true, redirectUri: `http://127.0.0.1:${connectorOAuthPort}/callback` };
  }
  if (client.clientSecret) throw new ApiError(400, "connector_oauth_public_client", "Use a Microsoft desktop app registration. It does not require a client secret.");
  const tenant = client.tenantId || (provider === "onedrive-personal" ? "consumers" : "common");
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  const microsoftScopes: Record<string, string[]> = {
    outlook: ["User.Read", `Mail.Read${readOnly ? "" : "Write"}`, ...readOnly ? [] : ["Mail.Send"], `Calendars.Read${writeIds.includes("outlook-calendar") ? "Write" : ""}`],
    onedrive: [`Files.Read${readOnly ? "" : "Write"}.All`], "onedrive-personal": [`Files.Read${readOnly ? "" : "Write"}.All`], "sharepoint-files": ["Sites.Read.All", `Files.Read${readOnly ? "" : "Write"}.All`],
  };
  const permissions = microsoftScopes[provider];
  if (!permissions) throw new ApiError(409, "connector_oauth_unavailable", "Own-app sign-in is not available for this connector.");
  const application: OAuthApplication = {
    clientId: client.clientId, authorizeUrl: `${endpoint}/authorize`, tokenUrl: `${endpoint}/token`,
    scopes: () => ["offline_access", ...permissions.map((scope) => `https://graph.microsoft.com/${scope}`)],
    authorizeParams: { prompt: "select_account" },
    port: connectorOAuthPort,
  };
  return { application, family: "microsoft", supportsClientSecret: false, redirectUri: `http://localhost:${connectorOAuthPort}/callback` };
}
