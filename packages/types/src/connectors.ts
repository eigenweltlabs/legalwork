import { z } from "zod";

// Authentication is shared; each connector still implements its native API locally.
type ConnectorDefinition = {
  id: string; name: string; icon: string; kind: "mail" | "calendar" | "files";
  apiOrigin: string; contentOrigin?: string; connectionConnectorId?: string;
  descriptionKey: string; promptKey: string;
};
export const connectorDefinitions: ConnectorDefinition[] = [
  { id: "gmail", name: "Gmail", icon: "gmail", kind: "mail", apiOrigin: "https://gmail.googleapis.com", descriptionKey: "connectors.description", promptKey: "connectors.prompt" },
  { id: "outlook", name: "Outlook Email", icon: "microsoftoutlook", kind: "mail", apiOrigin: "https://graph.microsoft.com", descriptionKey: "connectors.description", promptKey: "connectors.prompt" },
  { id: "google-calendar", name: "Google Calendar", icon: "googlecalendar", kind: "calendar", apiOrigin: "https://www.googleapis.com", descriptionKey: "connectors.calendar_description", promptKey: "connectors.calendar_prompt" },
  { id: "outlook-calendar", name: "Outlook Calendar", icon: "microsoftoutlook", kind: "calendar", connectionConnectorId: "outlook", apiOrigin: "https://graph.microsoft.com", descriptionKey: "connectors.calendar_description", promptKey: "connectors.calendar_prompt" },
  { id: "google-drive", name: "Google Drive", icon: "googledrive", kind: "files", apiOrigin: "https://www.googleapis.com", descriptionKey: "connectors.files_description", promptKey: "connectors.files_prompt" },
  { id: "onedrive", name: "OneDrive for work or school", icon: "microsoftonedrive", kind: "files", apiOrigin: "https://graph.microsoft.com", descriptionKey: "connectors.files_description", promptKey: "connectors.files_prompt" },
  { id: "onedrive-personal", name: "OneDrive Personal", icon: "microsoftonedrive", kind: "files", apiOrigin: "https://api.onedrive.com", descriptionKey: "connectors.files_description", promptKey: "connectors.files_prompt" },
  { id: "sharepoint-files", name: "SharePoint", icon: "microsoftsharepoint", kind: "files", apiOrigin: "https://graph.microsoft.com", descriptionKey: "connectors.files_description", promptKey: "connectors.files_prompt" },
];

export const connectorConnectionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().nullable(),
  needsReconnect: z.boolean(),
  source: z.enum(["nango", "custom"]).optional(),
});
export type ConnectorConnection = z.infer<typeof connectorConnectionSchema>;

export const connectorStatusSchema = z.object({
  configured: z.boolean(),
  requiresSignIn: z.boolean(),
  connectors: z.array(z.object({
    id: z.string(),
    name: z.string(),
    configured: z.boolean(),
    active: z.boolean().optional(),
    customConfigured: z.boolean().optional(),
    connections: z.array(connectorConnectionSchema),
  })),
});
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;
export function connectorIsConnected(connector: ConnectorStatus["connectors"][number]) {
  const active = connector.active ?? (connector.id !== "outlook" && connector.id !== "outlook-calendar");
  return active && connector.connections.length === 1 && !connector.connections[0].needsReconnect;
}

export const connectorConnectSchema = z.object({
  flowId: z.string(),
  connectUrl: z.url(),
  expiresAt: z.number(),
});
export type ConnectorConnect = z.infer<typeof connectorConnectSchema>;

export const connectorFlowSchema = z.object({
  status: z.enum(["pending", "connected", "expired"]),
  connection: connectorConnectionSchema.nullable(),
});
export type ConnectorFlow = z.infer<typeof connectorFlowSchema>;

export const connectorOAuthClientInputSchema = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(4000).optional(),
  tenantId: z.string().trim().max(253).regex(/^(?:|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/).default(""),
}).strict();
export type ConnectorOAuthClientInput = z.input<typeof connectorOAuthClientInputSchema>;

export const connectorOAuthClientSchema = z.object({
  configured: z.boolean(),
  builtIn: z.boolean().default(false),
  clientId: z.string(),
  tenantId: z.string(),
  hasClientSecret: z.boolean(),
  supportsClientSecret: z.boolean(),
  family: z.enum(["google", "microsoft"]),
  redirectUri: z.string(),
  scopes: z.array(z.string()),
});
export type ConnectorOAuthClient = z.infer<typeof connectorOAuthClientSchema>;

// Consumed only by the LegalWork server. Never expose this response to the UI or agent.
export const connectorTokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().nullable(),
});

export const connectorWriteAccessSchema = z.object({
  gmail: z.boolean().default(false), outlook: z.boolean().default(false),
  "google-calendar": z.boolean().default(false), "outlook-calendar": z.boolean().default(false),
  "google-drive": z.boolean().default(false), onedrive: z.boolean().default(false),
  "onedrive-personal": z.boolean().default(false), "sharepoint-files": z.boolean().default(false),
}).strict();
export const connectorSettingsSchema = z.object({
  writeAccess: connectorWriteAccessSchema,
  // Public local account handles bind activation to the selected shared account.
  activeAccounts: z.object({ outlook: z.string().min(1).max(500).optional(), "outlook-calendar": z.string().min(1).max(500).optional() }).strict().default({}),
}).strict();
export const connectorWriteSettingSchema = z.object({ writeAccess: z.boolean(), readOnly: z.boolean() });
export type ConnectorWriteSetting = z.infer<typeof connectorWriteSettingSchema>;
export type ConnectorSettings = z.infer<typeof connectorSettingsSchema>;

export const connectorMailDraftTargetSchema = z.object({ connectorId: z.enum(["gmail", "outlook"]), connectionId: z.string().min(1).max(500) }).strict();
export const connectorCalendarDraftTargetSchema = z.object({ connectorId: z.enum(["google-calendar", "outlook-calendar"]), connectionId: z.string().min(1).max(500), calendarId: z.string().min(1).max(1000) }).strict();
export const connectorDraftDeliverySchema = z.object({
  state: z.enum(["saving", "sending", "saved", "sent", "uncertain"]),
  id: z.string().optional(), messageId: z.string().optional(), version: z.string().optional(),
  webUrl: z.url({ protocol: /^https$/ }).optional(),
}).strict();
