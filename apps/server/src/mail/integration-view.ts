import { z } from "zod";

export const mailIntegrationAccountSchema = z.object({
  accountId: z.string().regex(/^mail_[a-f0-9]{64}$/),
  handle: z.string().regex(/^[a-f0-9]{64}$/),
  connectorId: z.enum(["gmail", "outlook"]),
  connectionId: z.string().min(1).max(500),
  identity: z.string().min(1).max(500),
  email: z.email().max(320),
  displayName: z.string().max(1024),
  scopes: z.array(z.string().min(1).max(512)).max(32),
}).strict();
export type MailIntegrationAccount = z.infer<typeof mailIntegrationAccountSchema>;

export const mailIntegrationConfigurationSchema = z.object({
  origin: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/).refine(value => Number(value.slice(value.lastIndexOf(":") + 1)) <= 65535),
  capability: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type MailIntegrationConfiguration = z.infer<typeof mailIntegrationConfigurationSchema>;

export const mailIntegrationSnapshotSchema = z.object({
  configuration: mailIntegrationConfigurationSchema,
  handles: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
  accounts: z.array(mailIntegrationAccountSchema).max(100),
}).strict();
export type MailIntegrationSnapshot = z.infer<typeof mailIntegrationSnapshotSchema>;

// This is a routing reference, never a provider credential. It is useless
// without the ephemeral private host capability supplied to the worker.
export const mailIntegrationReference = (accountId: string) => `legalwork-mail:${accountId}`;
export const mailIntegrationAuthority = "legalwork-integrations";
