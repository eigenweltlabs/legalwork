import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { mcpAuthEntryFromServer, mcpConnectOutcome } from "../src/app/mcp-connect-state";
import type { McpDirectoryInfo } from "../src/app/constants";
import type { McpStatusMap, ReloadReason, ReloadTrigger } from "../src/app/types";
import { createClient } from "../src/app/lib/opencode";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import * as analytics from "../src/app/lib/analytics";
import { createConnectionsStore } from "../src/react-app/domains/connections/store";
import { createLegalworkServerStore } from "../src/react-app/domains/connections/legalwork-server-store";

const entry: McpDirectoryInfo = { name: "test-server", type: "remote", description: "", url: "https://example.com/mcp" };

describe("MCP connection outcomes", () => {
  test("explicit OAuth cannot complete from an anonymous transport handshake", () => {
    expect(mcpConnectOutcome({ ...entry, oauth: true }, { status: "connected" }, false)).toBe("auth");
    expect(mcpConnectOutcome({ ...entry, oauthConfig: { clientId: "app-id" } }, { status: "connected" }, false)).toBe("auth");
  });

  test("custom MCPs detect OAuth and client registration requirements", () => {
    expect(mcpConnectOutcome(entry, { status: "needs_auth" }, false)).toBe("auth");
    expect(mcpConnectOutcome(entry, { status: "needs_client_registration", error: "Client required" }, false)).toBe("auth");
    expect(mcpConnectOutcome(entry, { status: "failed", error: "Dynamic client registration is not supported. Only pre-registered MCP trusted partners are allowed." }, false)).toBe("auth");
  });

  test("token connections and explicitly disabled OAuth never launch authorization", () => {
    expect(mcpConnectOutcome({ ...entry, oauth: true }, { status: "connected" }, true)).toBe("connected");
    expect(mcpConnectOutcome({ ...entry, oauth: false }, { status: "needs_auth" }, false)).toBe("failed");
  });

  test("failed, disabled and missing engine entries do not report success", () => {
    expect(mcpConnectOutcome(entry, { status: "failed", error: "Network unavailable" }, false)).toBe("failed");
    expect(mcpConnectOutcome(entry, { status: "disabled" }, false)).toBe("failed");
    expect(mcpConnectOutcome(entry, undefined, false)).toBe("pending");
  });

  test("manual sign-in retains the saved server identity, endpoint and complete OAuth configuration", () => {
    const configured = mcpAuthEntryFromServer({
      name: "dropbox",
      config: {
        type: "remote",
        url: "https://custom.example.com/mcp",
        oauth: { clientId: "registered-id", clientSecret: "registered-secret", scope: "files.metadata.read", callbackPort: 1234, redirectUri: "http://localhost:1234/callback" },
      },
    });
    expect(configured.id).toBe("dropbox");
    expect(configured.serverName).toBe("dropbox");
    expect(configured.url).toBe("https://custom.example.com/mcp");
    expect(configured.oauthConfig).toEqual({ clientId: "registered-id", clientSecret: "registered-secret", scope: "files.metadata.read", callbackPort: 1234, redirectUri: "http://localhost:1234/callback" });
  });
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
const browserWindow = new EventTarget();
let config = "{}";
let status: McpStatusMap = {};
let saveError = "";
let serverAdds: unknown[] = [];
let analyticsEvents: string[] = [];
let reloads: Array<{ reason: ReloadReason; trigger?: ReloadTrigger }> = [];
let restoreAnalytics = () => {};
let selectedWorkspaceId = "local";
let remoteSaveWait: Promise<void> | undefined;
let remoteSaveStarted: (() => void) | undefined;

Object.assign(browserWindow, {
  __LEGALWORK_ELECTRON__: {
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      if (command === "readOpencodeConfig") return { path: "/tmp/opencode.json", exists: true, content: config };
      if (command === "writeOpencodeConfig") {
        config = String(args[2]);
        return { ok: true };
      }
      throw new Error(`Unexpected desktop command: ${command}`);
    },
  },
});

function makeStore(remote = false) {
  const legalworkServer = createLegalworkServerStore({
    startupPreference: () => "local",
    documentVisible: () => true,
    developerMode: () => false,
    runtimeWorkspaceId: () => null,
    activeClient: () => null,
    selectedWorkspaceDisplay: () => ({ id: "local", name: "Local", path: "/tmp/workspace", preset: "", workspaceType: "local" }),
    restartLocalServer: async () => false,
    createRemoteWorkspaceFlow: async () => false,
  });
  const localServerSnapshot = legalworkServer.getSnapshot();
  // Desktop and remote alike save through the LegalWork server; on desktop it
  // is the embedded one, owning the shared connector store.
  const connectedServer: typeof legalworkServer = {
    ...legalworkServer,
    getSnapshot: () => ({
      ...localServerSnapshot,
      legalworkServerStatus: "connected",
      legalworkServerClient: createLegalworkServerClient({ baseUrl: "http://127.0.0.1:9001", token: "test-token" }),
    }),
  };
  return createConnectionsStore({
    client: () => createClient("http://127.0.0.1:9000"),
    setClient: () => undefined,
    projectDir: () => "/tmp/workspace",
    selectedWorkspaceId: () => selectedWorkspaceId,
    selectedWorkspaceRoot: () => "/tmp/workspace",
    workspaceType: () => remote ? "remote" : "local",
    legalworkServer: connectedServer,
    runtimeWorkspaceId: () => remote ? "remote" : null,
    developerMode: () => false,
    markReloadRequired: (reason, trigger) => { reloads.push({ reason, trigger }); },
  });
}

const connectedEvents = () => analyticsEvents.filter((event) => event === "integration_connected");

describe("connection store success reporting", () => {
  beforeEach(() => {
    config = "{}";
    status = { "test-server": { status: "connected" } };
    saveError = "";
    serverAdds = [];
    analyticsEvents = [];
    reloads = [];
    selectedWorkspaceId = "local";
    remoteSaveWait = undefined;
    remoteSaveStarted = undefined;
    const capture = spyOn(analytics, "captureAnalyticsEvent").mockImplementation((event) => { analyticsEvents.push(event); });
    restoreAnalytics = () => capture.mockRestore();
    Object.defineProperty(globalThis, "window", { value: browserWindow, configurable: true });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (/^\/workspace\/[^/]+\/mcp$/.test(pathname)) {
          if (request.method === "POST") {
            serverAdds.push(await request.json());
            remoteSaveStarted?.();
            await remoteSaveWait;
            if (saveError) return Response.json({ code: "runtime_unavailable", message: saveError }, { status: 500 });
          }
          return Response.json({ items: [{ name: "test-server", config: { type: "remote", url: entry.url }, source: "config.remote" }] });
        }
        if (pathname !== "/mcp") throw new Error(`Unexpected request: ${request.url}`);
        return Response.json(status);
      },
    });
  });

  afterEach(() => {
    restoreAnalytics();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    globalThis.fetch = originalFetch;
  });

  test("OAuth waits for verified completion, emits once, and retains the final success message", async () => {
    const store = makeStore();
    expect(await store.connectMcp({ ...entry, oauth: true })).toBe(true);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(true);
    expect(connectedEvents()).toHaveLength(0);
    expect(store.getSnapshot().mcpStatus).not.toBe("Connected");
    // Saved once, into the server's shared row; the user's global opencode
    // config is left alone.
    expect(serverAdds).toEqual([{ name: "test-server", config: { type: "remote", url: entry.url, enabled: true, oauth: {} } }]);
    expect(config).toBe("{}");
    // No engine rebuild while the browser round-trip is pending: the engine
    // would lose the sign-in's client registration.
    expect(reloads).toHaveLength(0);
    await store.completeMcpAuthModal();
    await store.completeMcpAuthModal();
    expect(connectedEvents()).toHaveLength(1);
    expect(store.getSnapshot().mcpStatus).toBe("Connected");
    expect(reloads).toEqual([{ reason: "mcp", trigger: { type: "mcp", name: "test-server", action: "added" } }]);
  });

  test("closing sign-in never emits a success event, but still applies the saved connector", async () => {
    const store = makeStore();
    await store.connectMcp({ ...entry, oauth: true });
    expect(reloads).toHaveLength(0);
    store.closeMcpAuthModal();
    await store.completeMcpAuthModal();
    expect(connectedEvents()).toHaveLength(0);
    expect(reloads).toHaveLength(1);
  });

  test("a failed custom connection retains its engine error and never emits success", async () => {
    status = { "test-server": { status: "failed", error: "MCP endpoint returned 503" } };
    const store = makeStore();
    expect(await store.connectMcp(entry)).toBe(false);
    expect(store.getSnapshot().mcpStatus).toBe("MCP endpoint returned 503");
    expect(connectedEvents()).toHaveLength(0);
  });

  test("a failed save cannot silently report success", async () => {
    saveError = "Runtime config is unavailable";
    const store = makeStore();
    expect(await store.connectMcp(entry)).toBe(false);
    expect(store.getSnapshot().mcpStatus).toContain(saveError);
    expect(connectedEvents()).toHaveLength(0);
    expect(reloads).toHaveLength(0);
  });

  test("a successful non-OAuth connection reports success after its engine status is known", async () => {
    const store = makeStore();
    expect(await store.connectMcp(entry)).toBe(true);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
    expect(store.getSnapshot().mcpStatus).toBe("Connected");
    expect(connectedEvents()).toHaveLength(1);
    // Nothing to wait for: other workspaces get the connector on the reload.
    expect(reloads).toHaveLength(1);
  });

  test("remote workspace OAuth credentials are saved on the selected server, without local config writes or a spurious reload", async () => {
    status = { "test-server": { status: "needs_auth" } };
    const store = makeStore(true);
    expect(await store.connectMcp({ ...entry, oauthConfig: { clientId: "remote-client", clientSecret: "remote-secret" } })).toBe(true);
    expect(serverAdds).toEqual([{ name: "test-server", config: { type: "remote", url: entry.url, enabled: true, oauth: { clientId: "remote-client", clientSecret: "remote-secret" } } }]);
    expect(config).toBe("{}");
    expect(reloads).toHaveLength(0);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(true);
    expect(store.getSnapshot().mcpAuthNeedsReload).toBe(false);
    expect(connectedEvents()).toHaveLength(0);
  });

  test("explicitly disabled OAuth stays disabled in persisted config even when old client settings exist", async () => {
    const store = makeStore(true);
    expect(await store.connectMcp({ ...entry, oauth: false, oauthConfig: { clientId: "old-client" } })).toBe(true);
    expect(serverAdds).toEqual([{ name: "test-server", config: { type: "remote", url: entry.url, enabled: true, oauth: false } }]);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
  });

  test("cancelling setup during a save keeps the config but cannot reopen OAuth when it finishes", async () => {
    let resumeSave = () => {};
    remoteSaveWait = new Promise<void>((resolve) => { resumeSave = resolve; });
    const started = new Promise<void>((resolve) => { remoteSaveStarted = resolve; });
    const store = makeStore(true);
    const connecting = store.connectMcp({ ...entry, oauth: true });
    await started;
    store.cancelPendingMcpAuth();
    resumeSave();
    expect(await connecting).toBe(true);
    expect(serverAdds).toHaveLength(1);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
    expect(store.getSnapshot().mcpConnectingName).toBeNull();
    expect(connectedEvents()).toHaveLength(0);
  });

  test("a save that finishes after switching workspaces cannot start OAuth for the new selection", async () => {
    let resumeSave = () => {};
    remoteSaveWait = new Promise<void>((resolve) => { resumeSave = resolve; });
    const started = new Promise<void>((resolve) => { remoteSaveStarted = resolve; });
    const store = makeStore(true);
    const connecting = store.connectMcp({ ...entry, oauth: true });
    await started;
    selectedWorkspaceId = "another-workspace";
    resumeSave();
    expect(await connecting).toBe(true);
    expect(serverAdds).toHaveLength(1);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
    expect(connectedEvents()).toHaveLength(0);
  });
});
