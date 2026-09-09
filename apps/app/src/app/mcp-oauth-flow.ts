import { getMcpOAuthErrorMessage } from "./mcp-oauth-errors";

export type McpOAuthPhase = "idle" | "preparing" | "waiting" | "completing" | "success" | "error";
export type McpOAuthState = {
  phase: McpOAuthPhase;
  authorizationUrl?: string;
  error?: string;
  notice?: string;
};

export type McpOAuthDriver = {
  start: () => Promise<{ authorizationUrl?: string }>;
  complete: (code: string) => Promise<{ status: string; error?: string }>;
  receiveCode?: (state: string) => Promise<{ code: string }>;
  dispose: () => void | Promise<void>;
  notice?: string;
};

/** A callback from another attempt must never be submitted to this one's PKCE exchange. */
export function parseMcpOAuthCallback(input: string, authorizationUrl: string): string {
  const value = input.trim();
  if (!value) throw new Error("Paste the callback URL or authorization code.");
  if (!/^https?:\/\//i.test(value)) {
    if (/[\s/?&#]/.test(value)) throw new Error("Paste the complete callback URL or just the authorization code.");
    return value;
  }
  const callback = new URL(value);
  const authorization = new URL(authorizationUrl);
  const state = authorization.searchParams.get("state");
  if (!state || callback.searchParams.get("state") !== state) {
    throw new Error("This callback belongs to a different sign-in attempt. Use the current browser link.");
  }
  const redirect = authorization.searchParams.get("redirect_uri");
  if (redirect) {
    const expected = new URL(redirect);
    if (expected.origin !== callback.origin || expected.pathname !== callback.pathname) {
      throw new Error("This is not the callback URL for this connection.");
    }
  }
  if (callback.searchParams.has("error")) throw new Error("Authorization was declined. Retry when you are ready to sign in.");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("The callback URL does not contain an authorization code.");
  return code;
}

/**
 * One attempt owns the browser link, callback listener and deadline. Transport
 * `connected` is deliberately absent: only a successful code exchange proves
 * sign-in. Engine calls are serialized because its pending OAuth state is keyed
 * by server name; aborting a fetch alone does not cancel work on that engine.
 */
export function createMcpOAuthFlow(options: {
  prepare: (signal: AbortSignal) => Promise<McpOAuthDriver>;
  openBrowser: (url: string) => Promise<void>;
  onChange: (state: McpOAuthState) => void;
  timeoutMs?: number;
}) {
  type Attempt = { controller: AbortController; driver?: McpOAuthDriver; cleanup?: Promise<void>; timer?: ReturnType<typeof setTimeout> };
  let current: Attempt | undefined;
  let state: McpOAuthState = { phase: "idle" };
  let pending = Promise.resolve();

  const publish = (next: McpOAuthState) => {
    state = next;
    options.onChange(next);
  };
  const dispose = (attempt: Attempt) => {
    const driver = attempt.driver;
    if (!driver) return Promise.resolve();
    if (!attempt.cleanup) attempt.cleanup = (async () => { await driver.dispose(); })().catch(() => {});
    return attempt.cleanup;
  };
  const release = (attempt: Attempt) => {
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    // Close the callback port immediately, but wait for that close before the
    // next attempt binds it. Cancellation must not cause a spurious reload.
    const cleanup = dispose(attempt);
    pending = Promise.all([pending, cleanup]).then(() => {});
    if (current === attempt) current = undefined;
  };
  const fail = (attempt: Attempt, error: unknown) => {
    if (current !== attempt) return;
    release(attempt);
    publish({ phase: "error", error: getMcpOAuthErrorMessage(error, "Could not finish signing in.") });
  };
  const enqueue = <T>(attempt: Attempt, task: () => Promise<T>): Promise<T> => {
    const result = pending.then(() => {
      attempt.controller.signal.throwIfAborted();
      return task();
    });
    pending = result.then(() => {}, () => {});
    return result;
  };
  const complete = async (attempt: Attempt, code: string) => {
    if (current !== attempt || state.phase !== "waiting" || !attempt.driver) return;
    const driver = attempt.driver;
    publish({ ...state, phase: "completing", error: undefined });
    try {
      const result = await enqueue(attempt, () => driver.complete(code));
      if (current !== attempt) return;
      if (result.status !== "connected") {
        throw new Error(result.error || "The provider did not finish authorizing this connection. Retry to sign in again.");
      }
      release(attempt);
      publish({ phase: "success" });
    } catch (error) {
      fail(attempt, error);
    }
  };

  return {
    getState: () => state,
    async start() {
      if (current) return;
      const attempt: Attempt = { controller: new AbortController() };
      current = attempt;
      publish({ phase: "preparing" });
      attempt.timer = setTimeout(() => fail(attempt, new Error("Sign-in timed out. Retry to get a new authorization link.")), options.timeoutMs ?? 5 * 60_000);
      try {
        // Wait for an abandoned engine request before preparing another attempt.
        const driver = await enqueue(attempt, async () => {
          const prepared = await options.prepare(attempt.controller.signal);
          attempt.driver = prepared;
          if (current !== attempt) {
            await dispose(attempt);
            attempt.controller.signal.throwIfAborted();
          }
          return prepared;
        });
        if (current !== attempt) {
          await dispose(attempt);
          return;
        }
        const auth = await enqueue(attempt, driver.start);
        if (current !== attempt) return;
        if (!auth.authorizationUrl) throw new Error("The server did not provide an authorization link. Sign-in has not completed. Check this connector's authentication setup.");
        const url = new URL(auth.authorizationUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The server returned an invalid authorization link.");
        const oauthState = url.searchParams.get("state");
        if (!oauthState) throw new Error("The server's authorization link is missing OAuth state. Sign-in cannot continue.");
        publish({ phase: "waiting", authorizationUrl: url.href, notice: driver.notice });
        // Register the callback before opening the browser (fast SSO can return immediately).
        if (driver.receiveCode) {
          void driver.receiveCode(oauthState).then(
            ({ code }) => complete(attempt, code),
            (error: unknown) => fail(attempt, error),
          );
        }
        try {
          await options.openBrowser(url.href);
        } catch {
          if (current === attempt && state.phase === "waiting") {
            publish({ ...state, notice: "Your browser could not be opened automatically. Open or copy the authorization link below." });
          }
        }
      } catch (error) {
        fail(attempt, error);
      }
    },
    async reopen() {
      if (!current || state.phase !== "waiting" || !state.authorizationUrl) return;
      const attempt = current;
      try {
        await options.openBrowser(state.authorizationUrl);
      } catch {
        if (current === attempt) publish({ ...state, notice: "Could not open your browser. Copy the authorization link and open it in your browser." });
      }
    },
    async submit(input: string) {
      if (!current || state.phase !== "waiting" || !state.authorizationUrl) return;
      const attempt = current;
      try {
        const code = parseMcpOAuthCallback(input, state.authorizationUrl);
        await complete(attempt, code);
      } catch (error) {
        if (current === attempt) publish({ ...state, error: getMcpOAuthErrorMessage(error) });
      }
    },
    cancel() {
      if (current) release(current);
      publish({ phase: "idle" });
    },
  };
}
