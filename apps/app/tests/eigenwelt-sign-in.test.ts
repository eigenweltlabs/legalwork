import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { setLocale, t } from "../src/i18n";
import { EigenweltSignInTimeoutError } from "../src/app/lib/eigenwelt-sign-in";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  jest.useRealTimers();
  getReactQueryClient().clear();
  setLocale("en");
});

// Hold a real HTTP response while advancing the client timer past its former deadline.
function slowResponse() {
  jest.useFakeTimers();
  let received = () => {};
  const started = new Promise<void>(resolve => { received = resolve; });
  let respond = () => {};
  const held = new Promise<void>(resolve => { respond = resolve; });
  return {
    wait() {
      received();
      return held;
    },
    async advance() {
      await started;
      jest.advanceTimersByTime(10_250);
      respond();
    },
  };
}

function signInFixture(saveStatus: number, reloadStatus = 200, reloadDelay: (() => Promise<void>) | undefined = undefined, waitResponse?: () => Response, engineConnected = true, saveDelay?: () => Promise<void>) {
  const requests: string[] = [];
  let scheduledReloads = 0;
  const server = Bun.serve({
    port: 0,
    // This fixture intentionally answers after the former ten-second client
    // deadline; the HTTP server must not close the connection before then.
    idleTimeout: 30,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path.startsWith("/api/eigenwelt/oauth/wait/")) {
        if (waitResponse) return waitResponse();
        return Response.json({ apiKey: "test-key", baseURL: "https://example.test/v1", models: [], platformToken: "test-token" });
      }
      if (path.endsWith("/eigenwelt/connection")) {
        if (saveDelay) await saveDelay();
        return saveStatus === 200
          ? Response.json({})
          : Response.json({ code: "workspace_not_found", message: "Workspace not found" }, { status: saveStatus });
      }
      if (path.endsWith("/engine/reload")) {
        if (reloadDelay) await reloadDelay();
        if (reloadStatus === 404) return Response.json({ code: "workspace_not_found", message: "Workspace not found" }, { status: 404 });
        return reloadStatus === 200
          ? Response.json({ ok: true })
          : Response.json({ code: "opencode_unavailable", message: "Engine is still starting" }, { status: reloadStatus });
      }
      if (path === "/api/location/reload") return new Response(null, { status: 204 });
      if (path === "/api/info") return Response.json({ version: "2.1.4", pid: process.pid });
      if (path === "/api/config") return Response.json([]);
      if (path === "/api/model/default") return Response.json({ location: { directory: "/tmp/sign-in" }, data: null });
      if (["/api/provider", "/api/model", "/api/integration", "/api/mcp"].includes(path)) return Response.json({ location: { directory: "/tmp/sign-in" }, data: [] });
      return new Response("Unexpected route", { status: 500 });
    },
  });
  cleanups.push(() => server.stop(true));
  const client = OpenCode.make({ baseUrl: server.url.href });
  const legalworkClient = createLegalworkServerClient({ baseUrl: server.url.href });
  const store = createProviderAuthStore({
    client: () => engineConnected ? client : null,
    baseUrl: () => server.url.href,
    providers: () => [],
    providerDefaults: () => ({}),
    providerConnectedIds: () => [],
    disabledProviders: () => [],
    selectedWorkspaceDisplay: () => ({ id: "ws", name: "Workspace", path: "/tmp/sign-in", preset: "default", workspaceType: "local" }),
    selectedWorkspaceRoot: () => "/tmp/sign-in",
    runtimeWorkspaceId: () => "ws",
    legalworkServer: { getSnapshot: () => ({
      legalworkServerStatus: "connected",
      legalworkServerClient: legalworkClient,
      legalworkServerCapabilities: { config: { read: true, write: true } },
    }) },
    setProviders: () => undefined,
    setProviderDefaults: () => undefined,
    setProviderConnectedIds: () => undefined,
    setDisabledProviders: () => undefined,
    markOpencodeConfigReloadRequired: () => { scheduledReloads += 1; },
  });
  return { store, requests, scheduledReloads: () => scheduledReloads };
}

test("a failed account save fails sign-in before attempting any engine reload", async () => {
  const fixture = signInFixture(404);
  await expect(fixture.store.completeEigenweltSignIn("test-session")).rejects.toThrow("Workspace not found");
  expect(fixture.store.getSnapshot().providerAuthError).toContain("Workspace not found");
  expect(fixture.requests).toEqual([
    "GET /api/eigenwelt/oauth/wait/test-session",
    "PUT /workspace/ws/eigenwelt/connection",
  ]);
  expect(fixture.scheduledReloads()).toBe(0);
});

test("account sign-in saves before the project's agent is connected or approved", async () => {
  const fixture = signInFixture(200, 200, undefined, undefined, false);
  await expect(fixture.store.completeEigenweltSignIn("test-session")).resolves.toMatchObject({ connected: true });
  expect(fixture.requests).toEqual([
    "GET /api/eigenwelt/oauth/wait/test-session",
    "PUT /workspace/ws/eigenwelt/connection",
  ]);
  expect(fixture.store.getSnapshot().providerAuthError).toBeNull();
  expect(fixture.scheduledReloads()).toBe(0);
});

test("account save errors still surface when the project's agent is disconnected", async () => {
  const fixture = signInFixture(404, 200, undefined, undefined, false);
  await expect(fixture.store.completeEigenweltSignIn("test-session")).rejects.toThrow("Workspace not found");
  expect(fixture.requests).toEqual([
    "GET /api/eigenwelt/oauth/wait/test-session",
    "PUT /workspace/ws/eigenwelt/connection",
  ]);
  expect(fixture.store.getSnapshot().providerAuthError).toContain("Workspace not found");
});

test("a slow account commit completes sign-in without timing out or replaying the save", async () => {
  const delay = slowResponse();
  const fixture = signInFixture(200, 200, undefined, undefined, false, delay.wait);
  const result = fixture.store.completeEigenweltSignIn("slow-commit");
  await delay.advance();
  expect(await result).toMatchObject({ connected: true });
  expect(fixture.requests).toEqual(["GET /api/eigenwelt/oauth/wait/slow-commit", "PUT /workspace/ws/eigenwelt/connection"]);
}, 15_000);

test("sign-out waits for the server's cleanup instead of declaring failure at ten seconds", async () => {
  let calls = 0;
  const delay = slowResponse();
  const server = Bun.serve({ port: 0, idleTimeout: 30, async fetch() { calls++; await delay.wait(); return Response.json({ connected: false }); } });
  cleanups.push(() => server.stop(true));
  const client = createLegalworkServerClient({ baseUrl: server.url.href });
  const result = client.eigenweltSaveConnection("ws", { disconnect: true });
  await delay.advance();
  expect(await result).toMatchObject({ connected: false });
  expect(calls).toBe(1);
}, 15_000);

test("the account refresh after login can finish token and model publication beyond ten seconds", async () => {
  const delay = slowResponse();
  const server = Bun.serve({ port: 0, idleTimeout: 30, async fetch() { await delay.wait(); return Response.json({ connected: true }); } });
  cleanups.push(() => server.stop(true));
  const client = createLegalworkServerClient({ baseUrl: server.url.href });
  const result = client.eigenweltEntitlements("ws", { refresh: true });
  await delay.advance();
  expect(await result).toMatchObject({ connected: true });
}, 15_000);

test("checkout can continue past ten minutes and still connect", async () => {
  const startedAt = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(startedAt);
  cleanups.push(() => clock.mockRestore());
  let polls = 0;
  const fixture = signInFixture(200, 200, undefined, () => {
    if (++polls === 1) {
      clock.mockReturnValue(startedAt + 11 * 60 * 1000);
      return Response.json({ pending: true });
    }
    return Response.json({ apiKey: "test-key", baseURL: "https://example.test/v1", models: [] });
  });
  await expect(fixture.store.completeEigenweltSignIn("long-checkout")).resolves.toMatchObject({ connected: true });
  expect(polls).toBe(2);
});

test("the app explains how to restart when its hour-long wait expires", async () => {
  const startedAt = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(startedAt);
  cleanups.push(() => clock.mockRestore());
  const fixture = signInFixture(200, 200, undefined, () => {
    clock.mockReturnValue(startedAt + 60 * 60 * 1000 + 1);
    return Response.json({ pending: true });
  });
  const expired = fixture.store.completeEigenweltSignIn("expired-checkout");
  await expect(expired).rejects.toBeInstanceOf(EigenweltSignInTimeoutError);
  await expect(expired).rejects.toThrow(t("providers.eigenwelt_signin_timeout"));
  expect(fixture.store.getSnapshot().providerAuthError).toContain("restart");
  expect(fixture.requests).toEqual(["GET /api/eigenwelt/oauth/wait/expired-checkout"]);
});

const languages: Array<"en" | "de"> = ["en", "de"];
test.each(languages)("server expiry displays the customer restart instructions in %s", async language => {
  setLocale(language);
  const fixture = signInFixture(200, 200, undefined, () => Response.json({
    code: "eigenwelt_signin_timeout", message: "Raw server timeout",
  }, { status: 410 }));
  const message = t("providers.eigenwelt_signin_timeout");
  const expired = fixture.store.completeEigenweltSignIn("expired-checkout");
  await expect(expired).rejects.toBeInstanceOf(EigenweltSignInTimeoutError);
  await expect(expired).rejects.toThrow(message);
  expect(fixture.store.getSnapshot().providerAuthError).toBe(message);
  expect(message).toContain("LegalWork");
  expect(message).not.toContain("Provider");
});

test("a successful account save reloads once without scheduling a second reload", async () => {
  const fixture = signInFixture(200);
  await expect(fixture.store.completeEigenweltSignIn("test-session")).resolves.toMatchObject({ connected: true });
  expect(fixture.requests.filter((path) => path.endsWith("/engine/reload"))).toHaveLength(1);
  expect(fixture.requests.some((path) => path.endsWith("/api/location/reload"))).toBe(false);
  expect(fixture.scheduledReloads()).toBe(0);
});

test("a removed workspace cannot be recovered by disposing the instance", async () => {
  const fixture = signInFixture(200, 404);
  await expect(fixture.store.completeEigenweltSignIn("test-session")).rejects.toThrow("Workspace not found");
  expect(fixture.requests).toEqual([
    "GET /api/eigenwelt/oauth/wait/test-session",
    "PUT /workspace/ws/eigenwelt/connection",
    "POST /workspace/ws/engine/reload",
  ]);
  expect(fixture.scheduledReloads()).toBe(0);
});

test("cold engine readiness may exceed the ordinary API timeout without a second dispose", async () => {
  const delay = slowResponse();
  const fixture = signInFixture(200, 200, delay.wait);
  const result = fixture.store.completeEigenweltSignIn("test-session");
  await delay.advance();
  expect(await result).toMatchObject({ connected: true });
  expect(fixture.requests.filter((path) => path.endsWith("/engine/reload"))).toHaveLength(1);
  expect(fixture.requests.some((path) => path.endsWith("/api/location/reload"))).toBe(false);
}, 15_000);

test("a transient managed refresh failure is surfaced without globally reloading projects", async () => {
  const fixture = signInFixture(200, 503);
  await expect(fixture.store.completeEigenweltSignIn("test-session")).rejects.toThrow();
  expect(fixture.requests.filter((path) => path.endsWith("/engine/reload"))).toHaveLength(1);
  expect(fixture.requests.filter((path) => path.endsWith("/api/location/reload"))).toHaveLength(0);
  expect(fixture.scheduledReloads()).toBe(0);
});
