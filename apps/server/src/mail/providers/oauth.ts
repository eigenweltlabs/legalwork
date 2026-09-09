import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { checkMailProviderReadiness, type MailProviderConfig } from "../provider-config.js";

type GmailSettings = Omit<Extract<MailProviderConfig, { provider: "gmail" }>, "redirectUri" | "clientSecretConfigured"> & { clientSecret: string };
type GraphSettings = Omit<Extract<MailProviderConfig, { provider: "graph" }>, "redirectUri">;
export type MailOAuthSettings = GmailSettings | GraphSettings;
export type OAuthFetch = (url: string, options: RequestInit) => Promise<Response>;
export type MailOAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: "Bearer";
  expiresAt: number;
  /** Null means absent from response; do not infer actual grants or account identity. */
  grantedScopes: string[] | null;
  /** Unverified transport only. Never use as authenticated account identity. */
  unverifiedIdToken: string | null;
};
export type MailOAuthErrorCode = "configuration_invalid" | "listener_unavailable" | "expired" | "cancelled" | "denied"
  | "exchange_failed" | "exchange_timeout" | "token_response_invalid";
export class MailOAuthError extends Error {
  constructor(readonly code: MailOAuthErrorCode) { super(`mail_oauth_${code}`); }
}
export type MailOAuthFlow = {
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: number;
  /** Graph's IPv6 binding may be unavailable on an IPv4-only OS; redirect still uses localhost. */
  loopbackFamilies: readonly ("ipv4" | "ipv6")[];
  result: Promise<MailOAuthTokens>;
  cancel(): Promise<void>;
};
export type MailOAuthOptions = {
  lifetimeMs?: number;
  exchangeTimeoutMs?: number;
  signal?: AbortSignal;
  fetch?: OAuthFetch;
  /** Test seam only; production must use the default loopback-only binder. */
  listen?: typeof listenMailOAuthLoopback;
};
const MAX_CALLBACK_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PAGE = "Legalwork Mail authorization received. Return to Legalwork to see the connection result.";
const INVALID_PAGE = "Legalwork Mail could not accept this request. Return to Legalwork.";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new MailOAuthError("configuration_invalid");
  return result;
}
function hasCode(error: unknown, code: string): boolean { return record(error) && error.code === code; }
function safeToken(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value); }
function configured(settings: MailOAuthSettings, redirectUri: string): boolean {
  const config: MailProviderConfig = settings.provider === "gmail"
    ? { ...settings, redirectUri, clientSecretConfigured: safeToken(settings.clientSecret) }
    : { ...settings, redirectUri };
  return checkMailProviderReadiness(config).configurationReady && settings.scopes.length <= 32
    && settings.scopes.every((scope) => typeof scope === "string" && /^[\x21-\x7e]{1,512}$/.test(scope));
}
export function listenMailOAuthLoopback(server: Server, host: "127.0.0.1" | "::1", port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const error = (cause: Error) => reject(cause);
    server.once("error", error);
    server.listen({ host, port, ipv6Only: host === "::1" }, () => {
      server.off("error", error);
      const address = server.address();
      if (!address || typeof address === "string") { reject(new MailOAuthError("listener_unavailable")); return; }
      resolve(address.port);
    });
  });
}
async function closeListeners(servers: Server[], sockets: Set<Socket>): Promise<void> {
  // Give fixed browser responses a short flush window; never wait on idle/hostile clients indefinitely.
  const kill = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 250);
  try { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); }
  finally { clearTimeout(kill); for (const socket of sockets) socket.destroy(); }
}
function reply(response: ServerResponse, status: number, accepted = false): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Connection": "close",
  });
  response.end(accepted ? PAGE : INVALID_PAGE);
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new MailOAuthError("token_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new MailOAuthError("exchange_failed");
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunks.length >= MAX_RESPONSE_BYTES || chunk.value.byteLength === 0) throw new MailOAuthError("token_response_invalid");
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new MailOAuthError("token_response_invalid");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new MailOAuthError("token_response_invalid"); }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

/** Fixed-endpoint code exchange; no persistence, logging, browser identity or redirect following. */
export async function exchangeMailOAuthCode(input: {
  settings: MailOAuthSettings; code: string; verifier: string; redirectUri: string;
  fetch?: OAuthFetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<MailOAuthTokens> {
  if (!configured(input.settings, input.redirectUri) || !safeToken(input.code)
    || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)) throw new MailOAuthError("configuration_invalid");
  const timeoutMs = bounded(input.timeoutMs, 30_000, 10, 60_000);
  if (input.signal?.aborted) throw new MailOAuthError("cancelled");
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline: (error: MailOAuthError) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const cancel = () => { controller.abort(); rejectDeadline(new MailOAuthError("cancelled")); };
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectDeadline(new MailOAuthError("exchange_timeout")); }, timeoutMs);
  const endpoint = input.settings.provider === "gmail" ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${input.settings.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: input.settings.clientId,
    redirect_uri: input.redirectUri, code: input.code, code_verifier: input.verifier });
  if (input.settings.provider === "gmail") body.set("client_secret", input.settings.clientSecret);
  const requestedAt = Date.now();
  const work = (async () => {
    const response = await (input.fetch ?? fetch)(endpoint, {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: body.toString(), signal: controller.signal,
    });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new MailOAuthError("exchange_failed"); }
    if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new MailOAuthError("exchange_failed"); }
    const data = await boundedJson(response, controller.signal);
    if (!record(data) || !safeToken(data.access_token) || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"
      || typeof data.expires_in !== "number" || !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 604800
      || (data.refresh_token !== undefined && !safeToken(data.refresh_token)) || (data.id_token !== undefined && !safeToken(data.id_token))
      || (data.scope !== undefined && (typeof data.scope !== "string" || data.scope.length > 16384 || !/^[\x20-\x7e]*$/.test(data.scope)))) throw new MailOAuthError("token_response_invalid");
    const expiresAt = requestedAt + data.expires_in * 1000;
    if (expiresAt <= Date.now()) throw new MailOAuthError("token_response_invalid");
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, tokenType: "Bearer",
      expiresAt, grantedScopes: typeof data.scope === "string" ? [...new Set(data.scope.split(" ").filter(Boolean))] : null,
      unverifiedIdToken: data.id_token ?? null } satisfies MailOAuthTokens;
  })();
  try { return await Promise.race([work, deadline]); }
  catch (error) {
    if (timedOut) throw new MailOAuthError("exchange_timeout");
    if (input.signal?.aborted) throw new MailOAuthError("cancelled");
    if (error instanceof MailOAuthError) throw error;
    throw new MailOAuthError("exchange_failed");
  } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
}

/** Starts private loopback listeners only. Caller explicitly launches the system browser. */
export async function startMailOAuth(settingsInput: MailOAuthSettings, options: MailOAuthOptions = {}): Promise<MailOAuthFlow> {
  // Snapshot config so caller mutation cannot change provider, tenant or scopes mid-flow.
  const settings: MailOAuthSettings = { ...settingsInput, scopes: [...settingsInput.scopes] };
  const lifetime = bounded(options.lifetimeMs, 5 * 60_000, 10, 10 * 60_000);
  bounded(options.exchangeTimeoutMs, 30_000, 10, 60_000);
  if (options.signal?.aborted) throw new MailOAuthError("cancelled");
  const callbackPath = settings.provider === "gmail" ? "/" : "/mail/callback";
  const callbackHost = settings.provider === "gmail" ? "127.0.0.1" : "localhost";
  if (!configured(settings, `http://${callbackHost}:43123${callbackPath}`)
    || (settings.provider === "graph" && settings.registeredRedirectUri !== "http://localhost/mail/callback")) throw new MailOAuthError("configuration_invalid");
  const state = randomBytes(32).toString("base64url");
  let verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const stateHash = createHash("sha256").update(state).digest();
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const families: ("ipv4" | "ipv6")[] = ["ipv4"];
  const abortExchange = new AbortController();
  let redirectUri = "";
  let expectedHost = "";
  let phase: "pending" | "exchanging" | "settled" = "pending";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let resolveResult: (tokens: MailOAuthTokens) => void = () => {};
  let rejectResult: (error: MailOAuthError) => void = () => {};
  const result = new Promise<MailOAuthTokens>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  void result.catch(() => {});
  const close = () => { closing ??= closeListeners(servers, sockets); return closing; };
  const finish = (error?: MailOAuthError, tokens?: MailOAuthTokens) => {
    if (phase === "settled") return;
    phase = "settled";
    verifier = "";
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancelled);
    if (error) { abortExchange.abort(); rejectResult(error); }
    else if (tokens) resolveResult(tokens);
    void close();
  };
  const cancelled = () => finish(new MailOAuthError("cancelled"));
  function callback(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "GET" || request.headers.host !== expectedHost || !request.url || Buffer.byteLength(request.url) > MAX_CALLBACK_BYTES || request.url.includes("#")
      || request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "host").length !== 1
      || request.url.split("?")[0] !== callbackPath || request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0")) { reply(response, 400); return; }
    if (phase !== "pending") { reply(response, 409); return; }
    const url = new URL(request.url, redirectUri);
    const returnedState = url.searchParams.get("state");
    if (!returnedState || url.searchParams.getAll("state").length !== 1 || returnedState.length > 256
      || !timingSafeEqual(createHash("sha256").update(returnedState).digest(), stateHash)) { reply(response, 400); return; }
    if (["access_token", "refresh_token", "id_token"].some((key) => url.searchParams.has(key))) { reply(response, 400); return; }
    const errors = url.searchParams.getAll("error");
    const codes = url.searchParams.getAll("code");
    if ((errors.length !== 1 && codes.length !== 1) || (errors.length && codes.length)
      || errors.length > 1 || codes.length > 1 || (errors.length === 1 && (!errors[0] || errors[0].length > 256)) || (codes.length === 1 && !safeToken(codes[0]))) { reply(response, 400); return; }
    // State becomes one-use only after a valid callback, including provider denial.
    phase = "exchanging";
    reply(response, 200, true);
    if (errors.length) { finish(new MailOAuthError("denied")); return; }
    const code = codes[0];
    void close();
    void exchangeMailOAuthCode({ settings, code, verifier, redirectUri, fetch: options.fetch,
      signal: abortExchange.signal, timeoutMs: options.exchangeTimeoutMs }).then((tokens) => finish(undefined, tokens),
      (error: unknown) => finish(error instanceof MailOAuthError ? error : new MailOAuthError("exchange_failed")));
  }
  function makeServer(): Server {
    const server = createServer({ maxHeaderSize: MAX_CALLBACK_BYTES }, callback);
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1; server.maxConnections = 8;
    server.on("error", () => { if (redirectUri) finish(new MailOAuthError("listener_unavailable")); });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy()); });
    server.on("clientError", (_, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
    return server;
  }
  const listen = options.listen ?? listenMailOAuthLoopback;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ipv4 = makeServer(); servers.push(ipv4);
      const port = await listen(ipv4, "127.0.0.1", 0);
      if (settings.provider === "graph") {
        const ipv6 = makeServer(); servers.push(ipv6);
        try { await listen(ipv6, "::1", port); families.push("ipv6"); }
        catch (error) {
          if (hasCode(error, "EADDRINUSE") && attempt < 2) { await closeListeners(servers.splice(0), sockets); continue; }
          if (!hasCode(error, "EAFNOSUPPORT") && !hasCode(error, "EPROTONOSUPPORT") && !hasCode(error, "EADDRNOTAVAIL")) throw error;
          // IPv6-disabled OS: retain the actual IPv4 loopback listener and localhost redirect.
        }
      }
      redirectUri = `http://${callbackHost}:${port}${callbackPath}`;
      expectedHost = `${callbackHost}:${port}`;
      break;
    }
    if (!redirectUri || !configured(settings, redirectUri)) throw new MailOAuthError("configuration_invalid");
  } catch {
    await close();
    throw new MailOAuthError("listener_unavailable");
  }
  const expiresAt = Date.now() + lifetime;
  timer = setTimeout(() => finish(new MailOAuthError("expired")), lifetime);
  options.signal?.addEventListener("abort", cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const authorizationUrl = new URL(settings.provider === "gmail" ? "https://accounts.google.com/o/oauth2/v2/auth"
    : `https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/authorize`);
  for (const [key, value] of Object.entries({ client_id: settings.clientId, redirect_uri: redirectUri, response_type: "code",
    scope: settings.scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256" })) authorizationUrl.searchParams.set(key, value);
  if (settings.provider === "gmail") { authorizationUrl.searchParams.set("access_type", "offline"); authorizationUrl.searchParams.set("prompt", "consent"); }
  else authorizationUrl.searchParams.set("response_mode", "query");
  return { authorizationUrl: authorizationUrl.toString(), redirectUri, expiresAt, loopbackFamilies: families, result,
    async cancel() { cancelled(); await close(); } };
}
