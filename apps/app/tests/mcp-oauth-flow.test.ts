import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  createMcpOAuthFlow,
  parseMcpOAuthCallback,
  type McpOAuthDriver,
  type McpOAuthState,
} from "../src/app/mcp-oauth-flow";

const redirectUri = "http://127.0.0.1:19876/mcp/oauth/callback";
const authorizationUrl = `https://provider.test/authorize?${new URLSearchParams({ state: "current-state", redirect_uri: redirectUri })}`;

function callbackUrl(code = "authorization-code", state = "current-state") {
  return `${redirectUri}?${new URLSearchParams({ code, state })}`;
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function makeDriver(overrides: Partial<McpOAuthDriver> = {}) {
  return {
    start: mock(async () => ({ authorizationUrl })),
    complete: mock(async (_code: string) => ({ status: "connected" })),
    dispose: mock(() => {}),
    ...overrides,
  };
}

const cancellations: Array<() => void> = [];

function harness(options: {
  driver?: McpOAuthDriver;
  prepare?: (signal: AbortSignal) => Promise<McpOAuthDriver>;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
} = {}) {
  const driver = options.driver ?? makeDriver();
  const states: McpOAuthState[] = [];
  const phaseWaiters: Array<{ phase: McpOAuthState["phase"]; resolve: (state: McpOAuthState) => void }> = [];
  const prepare = mock(options.prepare ?? (async (_signal: AbortSignal) => driver));
  const openBrowser = mock(options.openBrowser ?? (async (_url: string) => {}));
  const flow = createMcpOAuthFlow({
    prepare,
    openBrowser,
    timeoutMs: options.timeoutMs ?? 2_000,
    onChange: (state) => {
      states.push(state);
      for (const waiter of phaseWaiters) {
        if (waiter.phase === state.phase) waiter.resolve(state);
      }
    },
  });
  cancellations.push(flow.cancel);
  const nextPhase = (phase: McpOAuthState["phase"]) => new Promise<McpOAuthState>((resolve) => {
    phaseWaiters.push({ phase, resolve });
  });
  return { flow, driver, states, prepare, openBrowser, nextPhase };
}

afterEach(() => {
  for (const cancel of cancellations.splice(0)) cancel();
});

describe("MCP OAuth attempt ownership", () => {
  test("duplicate starts share the current preparation and never request a second authorization link", async () => {
    const prepared = deferred<McpOAuthDriver>();
    const driver = makeDriver();
    const { flow, prepare, openBrowser } = harness({ prepare: () => prepared.promise });
    const first = flow.start();
    await flow.start();
    expect(prepare).toHaveBeenCalledTimes(1);
    prepared.resolve(driver);
    await first;
    await flow.start();
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(flow.getState().phase).toBe("waiting");
  });

  test("reopening uses the same authorization URL and callback listener", async () => {
    const callback = deferred<{ code: string }>();
    const receiveCode = mock((_state: string) => callback.promise);
    const driver = makeDriver({ receiveCode });
    const { flow, openBrowser } = harness({ driver });
    await flow.start();
    await flow.reopen();
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(receiveCode).toHaveBeenCalledTimes(1);
    expect(openBrowser.mock.calls).toEqual([[authorizationUrl], [authorizationUrl]]);
  });

  test("a preparation finishing after cancel is disposed without opening a browser", async () => {
    const prepared = deferred<McpOAuthDriver>();
    const enteredPrepare = deferred<AbortSignal>();
    const driver = makeDriver();
    const { flow, openBrowser, states } = harness({
      prepare: (signal) => { enteredPrepare.resolve(signal); return prepared.promise; },
    });
    const first = flow.start();
    const signal = await enteredPrepare.promise;
    flow.cancel();
    prepared.resolve(driver);
    await first;
    expect(signal.aborted).toBe(true);
    expect(driver.dispose).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(states.map((state) => state.phase)).toEqual(["preparing", "idle"]);
  });

  test("a stale preparation is disposed before a newer attempt can acquire its resources", async () => {
    const prepared = deferred<McpOAuthDriver>();
    const enteredPrepare = deferred<void>();
    const oldDriver = makeDriver();
    const newDriver = makeDriver();
    let preparations = 0;
    const { flow, openBrowser } = harness({
      prepare: async () => {
        if (++preparations === 1) { enteredPrepare.resolve(); return prepared.promise; }
        return newDriver;
      },
    });
    const first = flow.start();
    await enteredPrepare.promise;
    flow.cancel();
    const retry = flow.start();
    await Promise.resolve();
    expect(preparations).toBe(1);
    prepared.resolve(oldDriver);
    await Promise.all([first, retry]);
    expect(oldDriver.start).not.toHaveBeenCalled();
    expect(oldDriver.dispose).toHaveBeenCalledTimes(1);
    expect(newDriver.dispose).not.toHaveBeenCalled();
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(flow.getState().phase).toBe("waiting");
  });

  test("quick retry waits for asynchronous callback-port disposal before binding again", async () => {
    const cleanup = deferred<void>();
    const disposed = mock(() => cleanup.promise);
    const oldDriver = makeDriver({ dispose: disposed });
    const newDriver = makeDriver();
    let preparations = 0;
    const { flow, openBrowser } = harness({ prepare: async () => ++preparations === 1 ? oldDriver : newDriver });
    await flow.start();
    flow.cancel();
    const retry = flow.start();
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(preparations).toBe(1);
    expect(newDriver.start).not.toHaveBeenCalled();
    expect(openBrowser).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await retry;
    expect(preparations).toBe(2);
    expect(newDriver.start).toHaveBeenCalledTimes(1);
    expect(flow.getState().phase).toBe("waiting");
  });

  test("cancelled preparation waits for its late listener cleanup before preparing a retry", async () => {
    const prepared = deferred<McpOAuthDriver>();
    const enteredPrepare = deferred<void>();
    const cleanup = deferred<void>();
    const enteredCleanup = deferred<void>();
    const oldDriver = makeDriver({ dispose: () => { enteredCleanup.resolve(); return cleanup.promise; } });
    const newDriver = makeDriver();
    let preparations = 0;
    const { flow } = harness({
      prepare: async () => {
        if (++preparations === 1) { enteredPrepare.resolve(); return prepared.promise; }
        return newDriver;
      },
    });
    const first = flow.start();
    await enteredPrepare.promise;
    flow.cancel();
    const retry = flow.start();
    prepared.resolve(oldDriver);
    await enteredCleanup.promise;
    expect(preparations).toBe(1);
    expect(newDriver.start).not.toHaveBeenCalled();
    cleanup.resolve();
    await Promise.all([first, retry]);
    expect(preparations).toBe(2);
    expect(oldDriver.start).not.toHaveBeenCalled();
    expect(flow.getState().phase).toBe("waiting");
  });

  test("cancellation at the preparation handoff still waits for callback-port cleanup", async () => {
    const cleanup = deferred<void>();
    const enteredCleanup = deferred<void>();
    const oldDriver = makeDriver({ dispose: () => { enteredCleanup.resolve(); return cleanup.promise; } });
    const newDriver = makeDriver();
    let preparations = 0;
    let retry: Promise<void> | undefined;
    const { flow } = harness({
      prepare: async () => {
        if (++preparations === 1) {
          // Cancel after prepare's own continuation, before start receives its
          // result: the old port must still be owned by the serialized attempt.
          queueMicrotask(() => queueMicrotask(() => { flow.cancel(); retry = flow.start(); }));
          return oldDriver;
        }
        return newDriver;
      },
    });
    const first = flow.start();
    await enteredCleanup.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const preparationsBeforeCleanup = preparations;
    cleanup.resolve();
    await first;
    await retry;
    expect(preparationsBeforeCleanup).toBe(1);
    expect(preparations).toBe(2);
    expect(flow.getState().phase).toBe("waiting");
  });

  test("retry waits for an abandoned engine start and ignores its late authorization URL", async () => {
    const started = deferred<void>();
    const oldStart = deferred<{ authorizationUrl: string }>();
    const oldDriver = makeDriver({ start: () => { started.resolve(); return oldStart.promise; } });
    const newDriver = makeDriver();
    let preparations = 0;
    const { flow, prepare, openBrowser } = harness({ prepare: async () => ++preparations === 1 ? oldDriver : newDriver });
    const first = flow.start();
    await started.promise;
    flow.cancel();
    const retry = flow.start();
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(newDriver.start).not.toHaveBeenCalled();
    oldStart.resolve({ authorizationUrl: "https://provider.test/stale?state=old" });
    await Promise.all([first, retry]);
    expect(oldDriver.dispose).toHaveBeenCalledTimes(1);
    expect(openBrowser.mock.calls).toEqual([[authorizationUrl]]);
  });

  test("retry also waits for an abandoned code exchange and ignores its late success", async () => {
    const completing = deferred<void>();
    const oldCompletion = deferred<{ status: string }>();
    const oldDriver = makeDriver({ complete: (_code) => { completing.resolve(); return oldCompletion.promise; } });
    const newDriver = makeDriver();
    let preparations = 0;
    const { flow, prepare, states } = harness({ prepare: async () => ++preparations === 1 ? oldDriver : newDriver });
    await flow.start();
    const submitted = flow.submit("old-code");
    await completing.promise;
    flow.cancel();
    const retry = flow.start();
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
    oldCompletion.resolve({ status: "connected" });
    await Promise.all([submitted, retry]);
    expect(states.some((state) => state.phase === "success")).toBe(false);
    expect(flow.getState().phase).toBe("waiting");
  });

  test("timed-out starts cannot open their late browser link", async () => {
    const result = deferred<{ authorizationUrl: string }>();
    const driver = makeDriver({ start: () => result.promise });
    const { flow, nextPhase, openBrowser } = harness({ driver, timeoutMs: 20 });
    const timedOut = nextPhase("error");
    const started = flow.start();
    expect((await timedOut).error).toContain("timed out");
    result.resolve({ authorizationUrl });
    await started;
    expect(flow.getState().phase).toBe("error");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(driver.dispose).toHaveBeenCalledTimes(1);
  });

  test("timed-out exchanges cannot publish a late success", async () => {
    const result = deferred<{ status: string }>();
    const driver = makeDriver({ complete: () => result.promise });
    const { flow, nextPhase, states } = harness({ driver, timeoutMs: 20 });
    await flow.start();
    const timedOut = nextPhase("error");
    const submitted = flow.submit("code");
    await timedOut;
    result.resolve({ status: "connected" });
    await submitted;
    expect(flow.getState().phase).toBe("error");
    expect(states.some((state) => state.phase === "success")).toBe(false);
  });
});

describe("MCP OAuth browser and callback completion", () => {
  test("registers the callback before opening the browser and succeeds only after code exchange", async () => {
    const callback = deferred<{ code: string }>();
    const order: string[] = [];
    const driver = makeDriver({ receiveCode: (state) => { order.push(`callback:${state}`); return callback.promise; } });
    const { flow, nextPhase } = harness({ driver, openBrowser: async () => { order.push("browser"); } });
    await flow.start();
    expect(order).toEqual(["callback:current-state", "browser"]);
    expect(flow.getState().phase).toBe("waiting");
    const success = nextPhase("success");
    callback.resolve({ code: "automatic-code" });
    await success;
    expect(driver.complete).toHaveBeenCalledWith("automatic-code");
    expect(driver.dispose).toHaveBeenCalledTimes(1);
  });

  test("missing or unsafe authorization links never count as authentication", async () => {
    for (const response of [{}, { authorizationUrl: "javascript:alert(1)" }, { authorizationUrl: "https://provider.test/authorize" }]) {
      const driver = makeDriver({ start: async () => response });
      const { flow, openBrowser, states } = harness({ driver });
      await flow.start();
      expect(flow.getState().phase).toBe("error");
      expect(openBrowser).not.toHaveBeenCalled();
      expect(states.some((state) => state.phase === "success")).toBe(false);
    }
  });

  test("browser-launch failure retains the link and permits reopening without restarting OAuth", async () => {
    let launches = 0;
    const driver = makeDriver();
    const { flow, openBrowser } = harness({ driver, openBrowser: async () => { if (++launches === 1) throw new Error("Popup blocked"); } });
    await flow.start();
    expect(flow.getState().phase).toBe("waiting");
    expect(flow.getState().notice).toContain("could not be opened");
    expect(flow.getState().authorizationUrl).toBe(authorizationUrl);
    await flow.reopen();
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledTimes(2);
    await flow.submit("manual-code");
    expect(flow.getState().phase).toBe("success");
  });

  test("a mismatched callback is rejected without losing the current attempt", async () => {
    const driver = makeDriver();
    const { flow } = harness({ driver });
    await flow.start();
    await flow.submit(callbackUrl("old-code", "old-state"));
    expect(flow.getState().phase).toBe("waiting");
    expect(flow.getState().error).toContain("different sign-in attempt");
    expect(driver.complete).not.toHaveBeenCalled();
    await flow.submit(callbackUrl());
    expect(driver.complete).toHaveBeenCalledWith("authorization-code");
    expect(flow.getState().phase).toBe("success");
  });

  test("manual and automatic completion racing exchange the code once", async () => {
    const callback = deferred<{ code: string }>();
    const completed = deferred<{ status: string }>();
    const complete = mock((_code: string) => completed.promise);
    const driver = makeDriver({ receiveCode: () => callback.promise, complete });
    const { flow } = harness({ driver });
    await flow.start();
    const submitted = flow.submit("manual-code");
    callback.resolve({ code: "automatic-code" });
    await Promise.resolve();
    completed.resolve({ status: "connected" });
    await submitted;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith("manual-code");
  });

  test("denied automatic authorization terminates the attempt with an actionable error", async () => {
    const callback = deferred<{ code: string }>();
    const driver = makeDriver({ receiveCode: () => callback.promise });
    const { flow, nextPhase } = harness({ driver });
    await flow.start();
    const error = nextPhase("error");
    callback.reject(new Error("Authorization was declined."));
    expect((await error).error).toBe("Authorization was declined.");
    expect(driver.complete).not.toHaveBeenCalled();
    expect(driver.dispose).toHaveBeenCalledTimes(1);
  });

  test("an abandoned callback cannot fail a newer attempt", async () => {
    const callback = deferred<{ code: string }>();
    const oldDriver = makeDriver({ receiveCode: () => callback.promise });
    const newDriver = makeDriver();
    let preparations = 0;
    const { flow } = harness({ prepare: async () => ++preparations === 1 ? oldDriver : newDriver });
    await flow.start();
    flow.cancel();
    await flow.start();
    callback.reject(new Error("Old callback listener was cancelled"));
    await Promise.resolve();
    expect(flow.getState().phase).toBe("waiting");
    expect(newDriver.dispose).not.toHaveBeenCalled();
  });

  test("failed code exchange preserves the provider error without claiming success", async () => {
    const driver = makeDriver({ complete: async () => ({ status: "needs_client_registration", error: "invalid_client: check app credentials" }) });
    const { flow, states } = harness({ driver });
    await flow.start();
    await flow.submit("code");
    expect(flow.getState()).toEqual({ phase: "error", error: "invalid_client: check app credentials" });
    expect(states.some((state) => state.phase === "success")).toBe(false);
    expect(driver.dispose).toHaveBeenCalledTimes(1);
  });

  test("a rejected callback exchange retains nested SDK errors", async () => {
    const driver = makeDriver({ complete: async () => { throw { _tag: "UnknownError", data: { message: "The authorization code has expired" } }; } });
    const { flow } = harness({ driver });
    await flow.start();
    await flow.submit("code");
    expect(flow.getState().error).toBe("The authorization code has expired");
    expect(flow.getState().phase).toBe("error");
  });
});

describe("MCP OAuth manual callback validation", () => {
  test("accepts an opaque code and a matching callback URL", () => {
    expect(parseMcpOAuthCallback("  opaque-code_123  ", authorizationUrl)).toBe("opaque-code_123");
    expect(parseMcpOAuthCallback(callbackUrl(), authorizationUrl)).toBe("authorization-code");
  });

  test("rejects wrong or missing state, callback origin, and callback path", () => {
    for (const url of [
      callbackUrl("code", "old-state"),
      `${redirectUri}?code=code`,
      callbackUrl().replace("127.0.0.1:19876", "unexpected.test"),
      callbackUrl().replace("/mcp/oauth/callback", "/unrelated"),
    ]) expect(() => parseMcpOAuthCallback(url, authorizationUrl)).toThrow();
  });

  test("denial and malformed input cannot become authorization codes", () => {
    expect(() => parseMcpOAuthCallback(`${redirectUri}?state=current-state&error=access_denied`, authorizationUrl)).toThrow("declined");
    for (const input of ["", "not a code", "code=one&state=two", `${redirectUri}?state=current-state`]) {
      expect(() => parseMcpOAuthCallback(input, authorizationUrl)).toThrow();
    }
  });
});
