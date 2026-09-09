import { checkMailProviderReadiness, type MailProviderConfig } from "../provider-config.js";
import type { MailOAuthSettings, OAuthFetch } from "./oauth.js";

/** Email is mutable metadata, never a canonical identity key. */
export type MailProviderIdentity = {
  providerSubject: string; email: string; displayName: string | null;
} & ({ provider: "gmail"; authority: "https://accounts.google.com"; tenantId: null }
  | { provider: "graph"; authority: string; tenantId: string });
export type MailIdentityErrorCode = "configuration_invalid" | "scope_unverified" | "cancelled" | "timeout"
  | "unauthorized" | "forbidden" | "transient" | "response_invalid" | "identity_mismatch";
export class MailIdentityError extends Error {
  constructor(readonly code: MailIdentityErrorCode) { super(`mail_identity_${code}`); }
}
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
const GRAPH_ORGANIZATION = "https://graph.microsoft.com/v1.0/organization?$select=id";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function email(value: unknown): value is string {
  // Conservative unquoted ASCII mailbox subset. Do not normalize aliases, dots or plus addressing.
  return typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
    && !value.includes("..");
}
function name(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new MailIdentityError("response_invalid");
  return value || null;
}
function valid(settings: MailOAuthSettings): boolean {
  const config: MailProviderConfig = settings.provider === "gmail"
    ? { ...settings, redirectUri: "http://127.0.0.1:43123/", clientSecretConfigured: typeof settings.clientSecret === "string" && /^[\x21-\x7e]{1,16384}$/.test(settings.clientSecret) }
    : { ...settings, redirectUri: "http://localhost:43123/mail/callback" };
  return checkMailProviderReadiness(config).configurationReady;
}
function grants(settings: MailOAuthSettings, scopes: readonly string[] | null): boolean {
  if (!scopes || scopes.length > 128 || !scopes.every((scope) => typeof scope === "string" && /^[\x21-\x7e]{1,512}$/.test(scope))) return false;
  return settings.provider === "gmail" ? scopes.includes("openid")
    && (scopes.includes("email") || scopes.includes("https://www.googleapis.com/auth/userinfo.email"))
    && scopes.includes("https://www.googleapis.com/auth/gmail.modify")
    : scopes.includes("User.Read") || scopes.includes("https://graph.microsoft.com/User.Read");
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {}); throw new MailIdentityError("response_invalid");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new MailIdentityError("cancelled");
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (!chunk.value.byteLength || bytes > 65536 || chunks.length >= 65536) throw new MailIdentityError("response_invalid");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new MailIdentityError("response_invalid"); }
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); }
}

/** Authenticated API discovery only; caller supplies same owned access token and actual granted scopes. */
export async function discoverMailIdentity(input: {
  settings: MailOAuthSettings; accessToken: string; grantedScopes: readonly string[] | null;
  fetch?: OAuthFetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<MailProviderIdentity> {
  const settings: MailOAuthSettings = { ...input.settings, scopes: [...input.settings.scopes] };
  const accessToken = input.accessToken;
  const timeoutMs = input.timeoutMs ?? 30000;
  if (!valid(settings) || typeof accessToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(accessToken)
    || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) throw new MailIdentityError("configuration_invalid");
  if (!grants(settings, input.grantedScopes)) throw new MailIdentityError("scope_unverified");
  if (input.signal?.aborted) throw new MailIdentityError("cancelled");
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline: (error: MailIdentityError) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const cancel = () => { controller.abort(); rejectDeadline(new MailIdentityError("cancelled")); };
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectDeadline(new MailIdentityError("timeout")); }, timeoutMs);
  async function get(url: string): Promise<unknown> {
    if (controller.signal.aborted) throw new MailIdentityError("cancelled");
    const response = await (input.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new MailIdentityError("cancelled"); }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new MailIdentityError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden"
        : response.status === 429 || response.status === 408 || response.status >= 500 ? "transient" : "response_invalid");
    }
    const data = await json(response, controller.signal);
    if (!record(data) || data.error !== undefined) throw new MailIdentityError("response_invalid");
    return data;
  }
  const work = (async (): Promise<MailProviderIdentity> => {
    if (settings.provider === "gmail") {
      const user = await get(USERINFO);
      if (!record(user) || typeof user.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(user.sub)
        || !email(user.email) || user.email_verified !== true) throw new MailIdentityError("response_invalid");
      const profile = await get(GMAIL_PROFILE);
      if (!record(profile) || !email(profile.emailAddress)) throw new MailIdentityError("response_invalid");
      if (user.email.toLowerCase() !== profile.emailAddress.toLowerCase()) throw new MailIdentityError("identity_mismatch");
      return { provider: "gmail", authority: "https://accounts.google.com", providerSubject: user.sub,
        tenantId: null, email: profile.emailAddress, displayName: name(user.name) };
    }
    const organization = await get(GRAPH_ORGANIZATION);
    if (!record(organization) || organization["@odata.nextLink"] !== undefined || !Array.isArray(organization.value) || organization.value.length !== 1
      || !record(organization.value[0]) || typeof organization.value[0].id !== "string" || !GUID.test(organization.value[0].id)) throw new MailIdentityError("response_invalid");
    const tenantId = organization.value[0].id.toLowerCase();
    if (tenantId !== settings.tenantId.toLowerCase()) throw new MailIdentityError("identity_mismatch");
    const user = await get(GRAPH_ME);
    if (!record(user) || typeof user.id !== "string" || !GUID.test(user.id) || !email(user.mail)) throw new MailIdentityError("response_invalid");
    return { provider: "graph", authority: `https://login.microsoftonline.com/${tenantId}/v2.0`, providerSubject: user.id.toLowerCase(),
      tenantId, email: user.mail, displayName: name(user.displayName) };
  })();
  try { return await Promise.race([work, deadline]); }
  catch (error) {
    if (timedOut) throw new MailIdentityError("timeout");
    if (input.signal?.aborted) throw new MailIdentityError("cancelled");
    if (error instanceof MailIdentityError) throw error;
    throw new MailIdentityError("transient");
  } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
}
