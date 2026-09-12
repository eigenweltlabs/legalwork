import { checkMailProviderReadiness, type MailProviderConfig } from "../provider-config.js";
import type { MailOAuthSettings, MailOAuthTokens, OAuthFetch } from "./oauth.js";

/** Preserve means retain the credential supplied by the caller; never replace it with null. */
export type MailRefreshResult = Omit<MailOAuthTokens, "refreshToken"> & {
  refreshToken: { action: "preserve" } | { action: "replace"; value: string };
};
export type MailRefreshErrorCode = "configuration_invalid" | "cancelled" | "timeout" | "reconsent_required"
  | "rate_limited" | "transient" | "client_rejected" | "request_rejected" | "response_invalid";
export class MailRefreshError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: MailRefreshErrorCode, readonly retryAfterMs: number | null = null) {
    super(`mail_refresh_${code}`);
    this.retryable = code === "timeout" || code === "rate_limited" || code === "transient";
  }
}
const MAX_BYTES = 65536;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function token(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value); }
function valid(settings: MailOAuthSettings): boolean {
  const config: MailProviderConfig = settings.provider === "gmail"
    ? { ...settings, redirectUri: "http://127.0.0.1:43123/", clientSecretConfigured: token(settings.clientSecret) }
    : { ...settings, redirectUri: "http://localhost:43123/mail/callback" };
  return checkMailProviderReadiness(config).configurationReady && settings.scopes.length <= 32
    && settings.scopes.every((scope) => typeof scope === "string" && /^[\x21-\x7e]{1,512}$/.test(scope));
}
function retryAfter(value: string | null): number | null {
  if (!value || value.length > 128) return null;
  const milliseconds = /^[0-9]+$/.test(value) ? Number(value) * 1000
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Math.max(0, Date.parse(value) - Date.now()) : NaN;
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {});
    throw new MailRefreshError("response_invalid");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new MailRefreshError("cancelled");
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (!chunk.value.byteLength || length > MAX_BYTES || chunks.length >= MAX_BYTES) throw new MailRefreshError("response_invalid");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new MailRefreshError("response_invalid"); }
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); }
}

/** One attempt only. Caller owns serialization, durable replacement and retry scheduling. */
export async function refreshMailOAuth(input: {
  settings: MailOAuthSettings; refreshToken: string; fetch?: OAuthFetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<MailRefreshResult> {
  const settings: MailOAuthSettings = { ...input.settings, scopes: [...input.settings.scopes] };
  const timeoutMs = input.timeoutMs ?? 30000;
  if (!valid(settings) || !token(input.refreshToken) || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) throw new MailRefreshError("configuration_invalid");
  if (input.signal?.aborted) throw new MailRefreshError("cancelled");
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline: (error: MailRefreshError) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const cancel = () => { controller.abort(); rejectDeadline(new MailRefreshError("cancelled")); };
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectDeadline(new MailRefreshError("timeout")); }, timeoutMs);
  const endpoint = settings.provider === "gmail" ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/token`;
  // Omit scope: refresh retains the original grant; configured scopes are not proof of consent.
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: settings.clientId, refresh_token: input.refreshToken });
  if (settings.provider === "gmail") body.set("client_secret", settings.clientSecret);
  const requestedAt = Date.now();
  const work = (async (): Promise<MailRefreshResult> => {
    const response = await (input.fetch ?? fetch)(endpoint, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body: body.toString() });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new MailRefreshError("cancelled"); }
    if (response.status === 429 || response.status >= 500 || response.status === 408) {
      void response.body?.cancel().catch(() => {});
      throw new MailRefreshError(response.status === 429 ? "rate_limited" : "transient", retryAfter(response.headers.get("retry-after")));
    }
    if (response.status !== 200 && response.status !== 400 && response.status !== 401) {
      void response.body?.cancel().catch(() => {}); throw new MailRefreshError("request_rejected");
    }
    const data = await json(response, controller.signal);
    if (response.status !== 200) {
      const code = record(data) ? data.error : undefined;
      if (code === "invalid_grant" || code === "interaction_required" || code === "consent_required" || code === "login_required") throw new MailRefreshError("reconsent_required");
      if (code === "temporarily_unavailable" || code === "server_error") throw new MailRefreshError("transient", retryAfter(response.headers.get("retry-after")));
      if (code === "invalid_client" || code === "unauthorized_client") throw new MailRefreshError("client_rejected");
      throw new MailRefreshError("request_rejected");
    }
    if (!record(data) || data.error !== undefined || !token(data.access_token) || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"
      || typeof data.expires_in !== "number" || !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 604800
      || (data.refresh_token !== undefined && !token(data.refresh_token)) || (data.id_token !== undefined && !token(data.id_token))
      || (data.scope !== undefined && (typeof data.scope !== "string" || data.scope.length > 16384 || !/^[\x20-\x7e]*$/.test(data.scope)))) throw new MailRefreshError("response_invalid");
    const expiresAt = requestedAt + data.expires_in * 1000;
    if (expiresAt <= Date.now()) throw new MailRefreshError("response_invalid");
    return { accessToken: data.access_token, tokenType: "Bearer", expiresAt,
      refreshToken: data.refresh_token === undefined ? { action: "preserve" } : { action: "replace", value: data.refresh_token },
      grantedScopes: typeof data.scope === "string" ? [...new Set(data.scope.split(" ").filter(Boolean))] : null,
      unverifiedIdToken: data.id_token ?? null };
  })();
  try { return await Promise.race([work, deadline]); }
  catch (error) {
    if (timedOut) throw new MailRefreshError("timeout");
    if (input.signal?.aborted) throw new MailRefreshError("cancelled");
    if (error instanceof MailRefreshError) throw error;
    throw new MailRefreshError("transient");
  } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
}
