import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { desktopFetch, desktopStreamFetch } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";
import { t } from "@/i18n";

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  hostToken?: string;
  mode?: "basic" | "legalwork";
};

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const ENGINE_BOOTSTRAP_TIMEOUT_MS = 90_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS = 90_000;
const SESSION_LONG_RUNNING_URL_RE = /\/session\/[^/?#]+\/(?:command|prompt|synthetic|shell|compact|wait)(?:[?#]|$)/;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

export function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number): number {
  const url = getRequestUrl(input);
  // The first metadata read initializes plugins and their dependencies. On a
  // fresh Windows profile this took over a minute. Avoid timing out and
  // queueing retries behind the same initialization work.
  if (!(input instanceof Request && input.method !== "GET") && /\/api\/(?:model|provider|integration|agent|skill|command|plugin|mcp|session|experimental\/config)(?:[?#]|$)/.test(url)) {
    return Math.max(fallbackMs, ENGINE_BOOTSTRAP_TIMEOUT_MS);
  }
  if (SESSION_LONG_RUNNING_URL_RE.test(url)) {
    return 0;
  }
  // Reloading a location may wait for OneDrive-backed files. Give the
  // explicit recovery path the same window as the server-managed reload.
  if (/\/location\/reload(?:[?#]|$)/.test(url)) {
    return Math.max(fallbackMs, 90_000);
  }
  // Native connection admission/completion may exchange credentials or run
  // an external command. Preserve the existing sign-in request window. The
  // modal polls native attempt status and uses the engine's expiry.
  if (/\/api\/integration\/[^/]+\/connect\/(?:oauth|command|key|external)(?:[/?#]|$)/.test(url)) {
    return Math.max(fallbackMs, OAUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  // Remote connector discovery and the first handshake can be slow.
  if (/\/api\/experimental\/mcp\/[^/]+\/(?:connect|auth)(?:[/?#]|$)/.test(url)) {
    return Math.max(fallbackMs, MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  return fallbackMs;
}


export function resolveLegalworkWorkspaceMount(baseUrl: string): { baseUrl: string; workspaceId: string } | null {
  try {
    const url = new URL(baseUrl);
    const match = url.pathname
      .replace(/\/+$/, "")
      .match(/^(.*)\/(?:w|workspace)\/([^/]+)\/opencode$/);
    if (!match || match[1] === undefined || !match[2]) return null;
    url.pathname = match[1] || "/";
    url.search = "";
    return {
      baseUrl: url.toString().replace(/\/+$/, ""),
      workspaceId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
) {
  const effectiveTimeoutMs = resolveRequestTimeoutMs(input, timeoutMs);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const controller = new AbortController();
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  const initWithSignal = { ...init, signal };

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error(t("app.request_timed_out")));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(input, initWithSignal), timeoutPromise]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(t("app.request_timed_out"));
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const encodeBasicAuth = (auth?: OpencodeAuth) => {
  if (!auth?.username || !auth?.password) return null;
  const token = `${auth.username}:${auth.password}`;
  if (typeof btoa === "function") return btoa(token);
  const buffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } })
    .Buffer;
  return buffer ? buffer.from(token, "utf8").toString("base64") : null;
};

const resolveAuthHeader = (auth?: OpencodeAuth) => {
  if (auth?.mode === "legalwork" && auth.token) {
    return `Bearer ${auth.token}`;
  }
  const encoded = encodeBasicAuth(auth);
  return encoded ? `Basic ${encoded}` : null;
};

/**
 * URLs whose response body we must stream chunk-by-chunk (SSE, long-running
 * message streams, event subscriptions). These need the pull-based stream
 * bridge; the ordinary text fetch helper waits for the complete body.
 */
const STREAM_URL_RE = /\/(event|stream)(\b|\/|$|\?)/;

function requestIsStreaming(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = getRequestUrl(input);
  if (STREAM_URL_RE.test(url)) return true;
  const accept =
    input instanceof Request
      ? input.headers.get("accept") ?? input.headers.get("Accept")
      : new Headers(init?.headers).get("accept") ?? new Headers(init?.headers).get("Accept");
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

const createDesktopFetch = (auth?: OpencodeAuth) => {
  const authHeader = resolveAuthHeader(auth);
  const addAuth = (headers: Headers) => {
    if (authHeader && !headers.has("Authorization")) headers.set("Authorization", authHeader);
    if (auth?.mode === "legalwork" && auth.hostToken && !headers.has("X-LegalWork-Host-Token")) {
      headers.set("X-LegalWork-Host-Token", auth.hostToken);
    }
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    // Pull stream chunks through Electron instead of occupying Chromium's
    // shared HTTP pool for the lifetime of every open app window.
    const shouldStream = requestIsStreaming(input, init);
    const underlyingFetch = shouldStream
      ? desktopStreamFetch
      : desktopFetch;
    // Streams should never be timed out at the transport layer; the caller
    // aborts via AbortSignal when the subscription unmounts.
    const timeoutMs = shouldStream ? 0 : DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;

    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      addAuth(headers);
      const request = new Request(input, { headers });
      return fetchWithTimeout(underlyingFetch, request, undefined, timeoutMs);
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      underlyingFetch,
      input,
      {
        ...init,
        headers,
      },
      timeoutMs,
    );
  };
};


/** Native client calls return their value directly and throw typed errors. */
export function unwrap<T>(value:T):T { return value; }
const clientContexts=new WeakMap<OpenCodeClient,{baseUrl:string;directory?:string;auth?:OpencodeAuth}>();
// Native event sharing belongs to the client. Reuse it across chat tabs so
// their catalog subscriptions cannot fill Office's six HTTP/1 connections.
// Weak references avoid keeping unused clients alive after unmount.
const clients = new Map<string, WeakRef<OpenCodeClient>>();
export function getClientContext(client:OpenCodeClient) {return clientContexts.get(client);}
export function createClient(baseUrl:string, directory?:string, auth?:OpencodeAuth) {
  for (const [key, reference] of clients) if (!reference.deref()) clients.delete(key);
  const key = JSON.stringify([baseUrl, directory, auth?.mode, auth?.username, auth?.password, auth?.token, auth?.hostToken]);
  const existing = clients.get(key)?.deref();
  if (existing) return existing;
  const headers:Record<string,string>={};
  const authHeader=resolveAuthHeader(auth);
  if(authHeader) headers.Authorization=authHeader;
  if(auth?.mode==="legalwork" && auth.hostToken) headers["X-LegalWork-Host-Token"]=auth.hostToken;
  const fetch=isDesktopRuntime() ? createDesktopFetch(auth) : (input:RequestInfo|URL,init?:RequestInit)=>fetchWithTimeout(globalThis.fetch,input,init,DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS);
  const client=OpenCode.make({baseUrl,headers,fetch});
  clientContexts.set(client,{baseUrl,directory,auth});
  clients.set(key, new WeakRef(client));
  return client;
}
export async function waitForHealthy(client:ReturnType<typeof createClient>,options?:{timeoutMs?:number;pollMs?:number}) {
  const start=Date.now();let lastError:unknown;
  while(Date.now()-start<(options?.timeoutMs ?? 10_000)) {
    try { return await client.server.info(); } catch(error) {lastError=error;}
    await new Promise(resolve=>setTimeout(resolve,options?.pollMs ?? 250));
  }
  throw lastError ?? new Error(t("server.health_timeout"));
}
