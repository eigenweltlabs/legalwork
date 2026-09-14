import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:19876/mcp/oauth/callback";

/** Release listeners when React can no longer clean up its own attempt. */
export function watchMcpOAuthOwner(contents, broker) {
  const owner = contents.id;
  const cancel = () => broker.cancelOwner(owner);
  contents.on("destroyed", cancel);
  contents.on("render-process-gone", cancel);
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) cancel();
  });
}

function callbackAddress(value) {
  const url = new URL(value || MCP_OAUTH_REDIRECT_URI);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error("The OAuth callback must be an HTTP loopback URL without credentials, query, or fragment.");
  }
  return url;
}

function sameState(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function respond(response, status, message) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  // Only fixed application messages reach the browser; provider errors remain
  // plain strings delivered to the authenticated renderer through IPC.
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Legalwork sign-in</title><body style="font-family:system-ui;padding:3rem;max-width:38rem;margin:auto"><h1>Legalwork sign-in</h1><p>${message}</p></body></html>`);
}

/**
 * Own the loopback callback in the desktop process, including for remote
 * engines. OpenCode's auth/start only creates a URL; it does not register a
 * callback waiter. The renderer passes the received code to auth/callback.
 */
export function createMcpOAuthCallbackBroker({ timeoutMs = 300_000 } = {}) {
  const ownerGenerations = new Map();
  /** @type {Map<string, { owner: number, state: string | null, waiting: boolean, finish: (result: { code?: string, error?: string }) => void, result: Promise<{ code?: string, error?: string }> }>} */
  const listeners = new Map();

  /** @param {{redirectUri?: string}} options */
  async function listen(options = {}, owner = 0) {
    const generation = ownerGenerations.get(owner) ?? 0;
    const address = callbackAddress(options.redirectUri);
    const listenerId = randomUUID();
    /** @type {(result: { code?: string, error?: string }) => void} */
    let settle;
    /** @type {Promise<{ code?: string, error?: string }>} */
    const result = new Promise((resolve) => { settle = resolve; });
    let settled = false;
    let timer;
    const server = createServer((request, response) => {
      let url;
      try {
        url = new URL(request.url || "/", address);
      } catch {
        respond(response, 400, "This sign-in callback URL is invalid.");
        return;
      }
      if (request.method !== "GET" || url.pathname !== address.pathname) {
        respond(response, 404, "This page is only used to finish Legalwork sign-in.");
        return;
      }
      const pending = listeners.get(listenerId);
      if (!pending || !sameState(url.searchParams.get("state"), pending.state)) {
        respond(response, 400, "This sign-in link is invalid or expired. Return to Legalwork and try again.");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        respond(response, 200, "Sign-in was not completed. Return to Legalwork for details.");
        pending.finish({ error: url.searchParams.get("error_description") || error });
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        respond(response, 400, "The sign-in response did not contain an authorization code.");
        return;
      }
      respond(response, 200, "Authorization received. Return to Legalwork to finish connecting.");
      pending.finish({ code });
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listeners.delete(listenerId);
      server.close();
      settle(value);
    };

    await new Promise((resolve, reject) => {
      server.once("error", (error) => {
        const message = "code" in error && error.code === "EADDRINUSE"
          ? "MCP_OAUTH_CALLBACK_IN_USE: Another sign-in process is using the callback port. Restart the engine or finish sign-in by pasting the callback URL."
          : `Could not listen for the OAuth callback: ${error.message}`;
        reject(new Error(message));
      });
      const hostname = address.hostname === "[::1]" ? "::1" : address.hostname;
      server.listen(Number(address.port || 80), hostname, () => resolve(undefined));
    });
    if (generation !== (ownerGenerations.get(owner) ?? 0)) {
      server.close();
      throw new Error("Sign-in cancelled.");
    }
    listeners.set(listenerId, { owner, state: null, waiting: false, finish, result });
    timer = setTimeout(() => finish({ error: "Sign-in timed out. Start a new sign-in attempt." }), timeoutMs);
    timer.unref?.();
    return { listenerId, redirectUri: address.toString() };
  }

  async function wait({ listenerId, state }, owner = 0) {
    const pending = listeners.get(listenerId);
    if (!pending || pending.owner !== owner) throw new Error("This sign-in attempt is no longer active.");
    if (pending.waiting) throw new Error("This sign-in attempt is already waiting for a callback.");
    if (typeof state !== "string" || !state.trim()) throw new Error("The OAuth provider did not return a sign-in state.");
    pending.waiting = true;
    pending.state = state;
    const completed = await pending.result;
    if (completed.error) throw new Error(completed.error);
    if (!completed.code) throw new Error("The sign-in response did not contain an authorization code.");
    return { code: completed.code };
  }

  function cancel(listenerId, owner = 0) {
    const pending = listeners.get(listenerId);
    if (pending?.owner === owner) pending.finish({ error: "Sign-in cancelled." });
  }

  function cancelOwner(owner) {
    ownerGenerations.set(owner, (ownerGenerations.get(owner) ?? 0) + 1);
    for (const pending of listeners.values()) {
      if (pending.owner === owner) pending.finish({ error: "Sign-in cancelled." });
    }
  }

  function close() {
    for (const pending of listeners.values()) pending.finish({ error: "Sign-in cancelled." });
  }

  return { listen, wait, cancel, cancelOwner, close };
}
