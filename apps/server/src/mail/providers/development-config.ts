import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from "../provider-config.js";
import type { MailOAuthSettings } from "./oauth.js";

export class MailDevelopmentConfigError extends Error {
  constructor() { super("mail_development_config_unavailable"); }
}
const googleClient = z.object({ installed: z.object({
  client_id: z.string().max(256).regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),
  project_id: z.string().min(1).max(256),
  client_secret: z.string().regex(/^[\x21-\x7e]{1,16384}$/),
  auth_uri: z.enum(["https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"]),
  token_uri: z.literal("https://oauth2.googleapis.com/token"),
  auth_provider_x509_cert_url: z.literal("https://www.googleapis.com/oauth2/v1/certs").optional(),
  redirect_uris: z.array(z.string().regex(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])\/?$/)).min(1).max(3).optional(),
}).strict() }).strict();
const graphClient = z.object({ clientId: z.uuid(), tenantId: z.union([z.uuid(), z.literal("consumers")]) }).strict();

/** Trusted local configuration only; never call with an HTTP-supplied object or path. */
export function parseGoogleInstalledMailClient(value: unknown): Extract<MailOAuthSettings, { provider: "gmail" }> {
  const parsed = googleClient.safeParse(value);
  if (!parsed.success) throw new MailDevelopmentConfigError();
  return { provider: "gmail", applicationType: "desktop", pkceMethod: "S256", scopes: [...GMAIL_MAIL_SCOPES],
    clientId: parsed.data.installed.client_id, clientSecret: parsed.data.installed.client_secret };
}
export function parseGraphMailRegistration(value: unknown): Extract<MailOAuthSettings, { provider: "graph" }> {
  const parsed = graphClient.safeParse(value);
  if (!parsed.success) throw new MailDevelopmentConfigError();
  return { provider: "graph", applicationType: "desktop", pkceMethod: "S256", scopes: [...GRAPH_MAIL_SCOPES],
    clientId: parsed.data.clientId.toLowerCase(), tenantId: parsed.data.tenantId.toLowerCase(),
    registeredRedirectUri: "http://localhost/mail/callback" };
}

/** Read a private standard installed-client JSON without returning paths/bytes in failures.
 * This development loader does not provision Windows ACLs or store mailbox tokens.
 * Runtime authorization/token URLs are fixed by oauth.ts, never copied from the file.
 */
export async function loadGoogleInstalledMailClient(path: string): Promise<Extract<MailOAuthSettings, { provider: "gmail" }>> {
  const bytes = Buffer.alloc(65537);
  try {
    if (!isAbsolute(path) || path.includes("\0")) throw new MailDevelopmentConfigError();
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()))) throw new MailDevelopmentConfigError();
    // A FIFO must reach fstat without waiting indefinitely for a writer.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 65536
        || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new MailDevelopmentConfigError();
      let used = 0;
      while (used < bytes.length) {
        const read = await handle.read(bytes, used, bytes.length - used, used);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      const after = await handle.stat();
      if (used !== info.size || used > 65536 || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new MailDevelopmentConfigError();
      const value: unknown = JSON.parse(bytes.subarray(0, used).toString("utf8"));
      return parseGoogleInstalledMailClient(value);
    } finally { await handle.close(); }
  } catch { throw new MailDevelopmentConfigError(); }
  finally { bytes.fill(0); }
}
