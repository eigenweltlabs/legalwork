import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { mcpAuthEntryFromServer, mcpConnectOutcome } from "../src/app/mcp-connect-state";
import type { McpDirectoryInfo } from "../src/app/constants";
import type { McpStatusMap } from "../src/app/types";
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
let runtimeError = "";
let runtimeWrites = 0;
let serverAdds: unknown[] = [];
let analyticsEvents: string[] = [];
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
      if (command === "mergeRuntimeMcpServer") {
        runtimeWrites += 1;
        return { ok: !runtimeError, stderr: runtimeError };
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
  const remoteServer: typeof legalworkServer = {
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
    legalworkServer: remote ? remoteServer : legalworkServer,
    runtimeWorkspaceId: () => remote ? "remote" : null,
    developerMode: () => false,
  });
}

const connectedEvents = () => analyticsEvents.filter((event) => event === "integration_connected");

describe("connection store success reporting", () => {
  beforeEach(() => {
    config = "{}";
    status = { "test-server": { status: "connected" } };
    runtimeError = "";
    runtimeWrites = 0;
    serverAdds = [];
    analyticsEvents = [];
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
        if (new URL(request.url).pathname === "/workspace/remote/mcp") {
          if (request.method === "POST") {
            serverAdds.push(await request.json());
            remoteSaveStarted?.();
            await remoteSaveWait;
          }
          return Response.json({ items: [{ name: "test-server", config: { type: "remote", url: entry.url } }] });
        }
        if (new URL(request.url).pathname !== "/mcp") throw new Error(`Unexpected request: ${request.url}`);
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
    await store.completeMcpAuthModal();
    await store.completeMcpAuthModal();
    expect(connectedEvents()).toHaveLength(1);
    expect(store.getSnapshot().mcpStatus).toBe("Connected");
  });

  test("closing sign-in never emits a success event", async () => {
    const store = makeStore();
    await store.connectMcp({ ...entry, oauth: true });
    store.closeMcpAuthModal();
    await store.completeMcpAuthModal();
    expect(connectedEvents()).toHaveLength(0);
  });

  test("a failed custom connection retains its engine error and never emits success", async () => {
    status = { "test-server": { status: "failed", error: "MCP endpoint returned 503" } };
    const store = makeStore();
    expect(await store.connectMcp(entry)).toBe(false);
    expect(store.getSnapshot().mcpStatus).toBe("MCP endpoint returned 503");
    expect(connectedEvents()).toHaveLength(0);
  });

  test("a failed runtime config write cannot silently report success", async () => {
    runtimeError = "Runtime config is unavailable";
    const store = makeStore();
    expect(await store.connectMcp(entry)).toBe(false);
    expect(store.getSnapshot().mcpStatus).toBe(runtimeError);
    expect(connectedEvents()).toHaveLength(0);
  });

  test("a successful non-OAuth connection reports success after its engine status is known", async () => {
    const store = makeStore();
    expect(await store.connectMcp(entry)).toBe(true);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
    expect(store.getSnapshot().mcpStatus).toBe("Connected");
    expect(connectedEvents()).toHaveLength(1);
  });

  test("remote workspace OAuth credentials are saved on the selected server, without local config writes or a spurious reload", async () => {
    status = { "test-server": { status: "needs_auth" } };
    const store = makeStore(true);
    expect(await store.connectMcp({ ...entry, oauthConfig: { clientId: "remote-client", clientSecret: "remote-secret" } })).toBe(true);
    expect(serverAdds).toEqual([{ name: "test-server", config: { type: "remote", url: entry.url, enabled: true, oauth: { clientId: "remote-client", clientSecret: "remote-secret" } } }]);
    expect(config).toBe("{}");
    expect(runtimeWrites).toBe(0);
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
