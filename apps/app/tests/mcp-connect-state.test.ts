import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { mcpAuthEntryFromServer, mcpConnectOutcome } from "../src/app/mcp-connect-state";
import { MCP_QUICK_CONNECT, type McpDirectoryInfo } from "../src/app/constants";
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
    expect(mcpConnectOutcome(entry, { status: "connected" }, true)).toBe("connected");
    expect(mcpConnectOutcome(entry, { status: "needs_auth" }, true)).toBe("failed");
    expect(mcpConnectOutcome({ ...entry, oauth: false }, { status: "needs_auth" }, false)).toBe("failed");
  });

  test("headers ride along with an OAuth the entry asks for", () => {
    expect(mcpConnectOutcome({ ...entry, oauth: true }, { status: "needs_auth" }, true)).toBe("auth");
    expect(mcpConnectOutcome({ ...entry, oauthConfig: { clientId: "c" } }, { status: "connected" }, true)).toBe("auth");
  });

  test("failed, disabled and missing engine entries do not report success", () => {
    expect(mcpConnectOutcome(entry, { status: "failed", error: "Network unavailable" }, false)).toBe("failed");
    expect(mcpConnectOutcome(entry, { status: "disabled" }, false)).toBe("failed");
    expect(mcpConnectOutcome(entry, undefined, false)).toBe("pending");
  });
  test("a blocked migration cannot fall through to automatic OAuth", () => {
    expect(mcpConnectOutcome({ ...entry, oauth: true }, { status: "failed", error: "Transfer paused", migration: { state: "blocked", canReconnect: true } }, false)).toBe("failed");
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
let migrationActions: unknown[] = [];
let engineAdds: unknown[] = [];
let analyticsEvents: string[] = [];
let reloads: Array<{ reason: ReloadReason; trigger?: ReloadTrigger }> = [];
let restoreAnalytics = () => {};
let selectedWorkspaceId = "local";
let remoteSaveWait: Promise<void> | undefined;
let remoteSaveStarted: (() => void) | undefined;
let emptyServerList = false;
let configExists = true;
let registrationFailed = false;
let serverEnables: unknown[] = [];
let engineStatusWait: Promise<void> | undefined;
let engineStatusStarted: (() => void) | undefined;
let engineStatusRequests = 0;
let serverListReads = 0;
let emptyServerReads = 0;
let openComputerUseError = "";
let openComputerUseCalls = 0;
const openComputerUseConfig = {
  command: ["/installed/Open Computer Use.app/Contents/MacOS/OpenComputerUse", "mcp"],
  environment: { OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: "test-legalwork-ocu" },
};

Object.assign(browserWindow, {
  __LEGALWORK_ELECTRON__: {
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      if (command === "getActaportMcpCommand") return ["node", "/tmp/bundled-actaport/index.mjs"];
      if (command === "getActaportMcpEnvironment") return { ACTAPORT_CONNECTION_FILE: "/tmp/actaport-connection.json", ACTAPORT_ALLOW_WRITES: "0", ACTAPORT_TOOLSETS: "" };
      if (command === "readOpencodeConfig") return { path: "/tmp/opencode.json", exists: configExists, content: config };
      if (command === "getOpenComputerUseMcpConfig") {
        openComputerUseCalls += 1;
        if (openComputerUseError) throw new Error(openComputerUseError);
        return openComputerUseConfig;
      }
      if (command === "writeOpencodeConfig") {
        config = String(args[2]);
        return { ok: true };
      }
      throw new Error(`Unexpected desktop command: ${command}`);
    },
  },
});

function makeStore(remote = false, fileFallback = false, routeConnection = false) {
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
    legalworkServer: fileFallback ? legalworkServer : connectedServer,
    ...(routeConnection ? { legalworkServerConnection: () => connectedServer.getSnapshot() } : {}),
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
    migrationActions = [];
    engineAdds = [];
    analyticsEvents = [];
    reloads = [];
    selectedWorkspaceId = "local";
    remoteSaveWait = undefined;
    remoteSaveStarted = undefined;
    emptyServerList = false;
    configExists = true;
    registrationFailed = false;
    serverEnables = [];
    engineStatusWait = undefined;
    engineStatusStarted = undefined;
    engineStatusRequests = 0;
    serverListReads = 0;
    emptyServerReads = 0;
    openComputerUseError = "";
    openComputerUseCalls = 0;
    const capture = spyOn(analytics, "captureAnalyticsEvent").mockImplementation((event) => { analyticsEvents.push(event); });
    restoreAnalytics = () => capture.mockRestore();
    Object.defineProperty(globalThis, "window", { value: browserWindow, configurable: true });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (/^\/workspace\/[^/]+\/mcp\/[^/]+\/migration$/.test(pathname)) {
          const body: unknown = await request.json();
          migrationActions.push(body);
          if (saveError) return Response.json({ code: "recovery_failed", message: saveError }, { status: 500 });
          status = { "test-server": { status: "needs_auth" } };
          return Response.json({ ok: true });
        }
        if (/^\/workspace\/[^/]+\/mcp\/[^/]+\/enabled$/.test(pathname)) {
          serverEnables.push(await request.json());
          remoteSaveStarted?.();
          await remoteSaveWait;
          if (saveError) return Response.json({ code: "enable_failed", message: saveError }, { status: 500 });
          return Response.json({ ok: true });
        }
        if (/^\/workspace\/[^/]+\/mcp$/.test(pathname)) {
          if (request.method === "POST") {
            serverAdds.push(await request.json());
            remoteSaveStarted?.();
            await remoteSaveWait;
            if (saveError) return Response.json({ code: "runtime_unavailable", message: saveError }, { status: 500 });
          }
          if (status.actaport) return Response.json({ items: [{ name: "actaport", config: { type: "local", command: ["node", "/tmp/bundled-actaport/index.mjs"] }, source: "config.local" }] });
          if (status["open-computer-use"]) return Response.json({ items: [{ name: "open-computer-use", config: { type: "local", ...openComputerUseConfig }, source: "config.local" }] });
          serverListReads += 1;
          return Response.json({ items: emptyServerList || serverListReads <= emptyServerReads ? [] : [{ name: "test-server", config: { type: "remote", url: entry.url }, source: "config.remote" }], ...(registrationFailed ? { engineSync: { status: "failed", failures: [{ name: "test-server", error: "Registration failed" }] } } : {}) });
        }
        if (pathname !== "/mcp") throw new Error(`Unexpected request: ${request.url}`);
        if (request.method === "POST") engineAdds.push(await request.json());
        if (request.method === "POST") return Response.json({ message: "Change settings and connected apps through LegalWork." }, { status: 403 });
        const engineStatus = status;
        engineStatusRequests += 1;
        engineStatusStarted?.();
        await engineStatusWait;
        return Response.json(engineStatus);
      },
    });
  });

  afterEach(() => {
    restoreAnalytics();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    globalThis.fetch = originalFetch;
  });

  test("retrying a transfer uses the server recovery API without opening OAuth", async () => {
    const store = makeStore();
    try {
      expect(await store.retryMcpMigration("test-server")).toBe(true);
      expect(migrationActions).toEqual([{ action: "retry" }]);
      expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
      expect(serverAdds).toHaveLength(0);
    } finally { store.dispose(); }
  });

  test("switching workspaces before recovery resolves cannot mutate the other workspace", async () => {
    const store = makeStore();
    try {
      const retry = store.retryMcpMigration("test-server");
      selectedWorkspaceId = "another-workspace";
      expect(await retry).toBe(false);
      expect(migrationActions).toHaveLength(0);
    } finally { store.dispose(); }
  });

  test.each([false, true])("explicit migration reconnect opens OAuth only after server recovery succeeds (failure=%s)", async failure => {
    const store = makeStore();
    status = { "test-server": { status: "failed", error: "Transfer paused", migration: { state: "blocked", canReconnect: true } } };
    try {
      await store.refreshMcpServers();
      if (failure) saveError = "Vault unavailable";
      const saved = store.getSnapshot().mcpServers[0];
      if (!saved) throw new Error("Missing saved connector");
      await store.authorizeMcp(saved);
      expect(migrationActions).toEqual([{ action: "reconnect" }]);
      expect(store.getSnapshot().mcpAuthModalOpen).toBe(!failure);
      expect(serverAdds).toHaveLength(0);
    } finally { store.dispose(); }
  });

  test("saved connector configuration is visible while engine status is still loading", async () => {
    let finishStatus = () => {};
    engineStatusWait = new Promise<void>(resolve => { finishStatus = resolve; });
    const started = new Promise<void>(resolve => { engineStatusStarted = resolve; });
    const store = makeStore();
    const refreshing = store.refreshMcpServers();
    await started;
    try {
      expect(store.getSnapshot().mcpServers.map(server => server.name)).toEqual(["test-server"]);
    } finally { finishStatus(); await refreshing; store.dispose(); }
  });

  test("import completion can refresh saved configuration without waiting for an engine check", async () => {
    const store = makeStore();
    try {
      await store.refreshMcpServers({ includeStatus: false });
      expect(store.getSnapshot().mcpServers.map(server => server.name)).toEqual(["test-server"]);
      expect(engineStatusRequests).toBe(0);
    } finally { store.dispose(); }
  });

  test("the connected route supplies imported connectors before the store's first health check", async () => {
    const store = makeStore(false, true, true);
    try {
      await store.refreshMcpServers({ includeStatus: false });
      expect(store.getSnapshot().mcpServers.map(server => server.name)).toEqual(["test-server"]);
      expect(serverListReads).toBe(1);
    } finally { store.dispose(); }
  });

  test("import completion waits for its saved connector to reach the library", async () => {
    emptyServerReads = 1;
    const store = makeStore();
    try {
      await store.refreshImportedConnectors(["test-server"]);
      expect(serverListReads).toBe(2);
      expect(store.getSnapshot().mcpServers.map(server => server.name)).toEqual(["test-server"]);
      expect(engineStatusRequests).toBe(0);
    } finally { store.dispose(); }
  });

  test("a pending status check cannot update the previous workspace after selection changes", async () => {
    let finishStatus = () => {};
    engineStatusWait = new Promise<void>(resolve => { finishStatus = resolve; });
    const started = new Promise<void>(resolve => { engineStatusStarted = resolve; });
    const store = makeStore();
    const oldRefresh = store.refreshMcpServers();
    await started;
    selectedWorkspaceId = "other-workspace";
    engineStatusWait = undefined;
    emptyServerList = true;
    try {
      await store.refreshMcpServers();
      finishStatus();
      await oldRefresh;
      expect(store.getSnapshot().mcpServers).toEqual([]);
      expect(store.getSnapshot().mcpStatuses).toEqual({});
    } finally { finishStatus(); await oldRefresh; store.dispose(); }
  });

  test("an older engine-status request cannot erase a connector fetched after an import", async () => {
    let finishStatus = () => {};
    engineStatusWait = new Promise<void>(resolve => { finishStatus = resolve; });
    const started = new Promise<void>(resolve => { engineStatusStarted = resolve; });
    emptyServerList = true;
    const store = makeStore();
    const oldRefresh = store.refreshMcpServers();
    await started;
    engineStatusWait = undefined;
    emptyServerList = false;
    try {
      await store.refreshMcpServers();
      expect(store.getSnapshot().mcpServers.map(server => server.name)).toEqual(["test-server"]);
      finishStatus();
      await oldRefresh;
      expect(store.getSnapshot().mcpServers.map(server => server.name)).toEqual(["test-server"]);
    } finally { finishStatus(); await oldRefresh; store.dispose(); }
  });

  test("a saved connection waiting for migration stays pending without a false failure or sign-in", async () => {
    status = { "test-server": { status: "connecting", message: "Transferring saved sign-in" } };
    const store = makeStore();
    try {
      expect(await store.connectMcp({ ...entry, oauth: true })).toBe(true);
      expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
      expect(store.getSnapshot().mcpStatus).toBe("Connecting…");
      expect(connectedEvents()).toHaveLength(0);
      expect(serverAdds).toHaveLength(1);
    } finally { store.dispose(); }
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

  test("a healthy empty connector list has no legacy configuration banner", async () => {
    emptyServerList = true;
    const store = makeStore();
    await store.refreshMcpServers();
    expect(store.getSnapshot().mcpServers).toEqual([]);
    expect(store.getSnapshot().mcpStatus).toBeNull();
  });

  test("missing or empty config files use the library empty state without file-setup instructions", async () => {
    const store = makeStore(false, true);
    for (const exists of [false, true]) {
      configExists = exists;
      await store.refreshMcpServers();
      expect(store.getSnapshot().mcpServers).toEqual([]);
      expect(store.getSnapshot().mcpStatus).toBeNull();
    }
  });

  test("actual registration failures still explain which connectors need attention", async () => {
    registrationFailed = true;
    status = {};
    const store = makeStore();
    await store.refreshMcpServers();
    expect(store.getSnapshot().mcpStatus).toBe("Could not connect these connectors: test-server. Refresh and try again.");
  });

  test("signing in to an imported disabled connector enables it first and defers reload until sign-in ends", async () => {
    const store = makeStore();
    await store.authorizeMcp({ name: "test-server", config: { type: "remote", url: entry.url, enabled: false, oauth: {} } });
    expect(serverEnables).toEqual([{ enabled: true }]);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(true);
    expect(store.getSnapshot().mcpAuthEntry?.serverName).toBe("test-server");
    expect(reloads).toEqual([]);
    store.closeMcpAuthModal();
    expect(reloads).toEqual([{ reason: "mcp", trigger: { type: "mcp", name: "test-server", action: "updated" } }]);
  });

  test("a rejected enable cannot start sign-in or claim successful activation", async () => {
    saveError = "You cannot enable this connector";
    const store = makeStore();
    await store.authorizeMcp({ name: "test-server", config: { type: "remote", url: entry.url, enabled: false } });
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
    expect(store.getSnapshot().mcpStatus).toBe(saveError);
    expect(reloads).toEqual([]);
  });

  test("changing workspaces while activation is pending cannot open its sign-in in the new workspace", async () => {
    let finish: (() => void) | undefined;
    remoteSaveWait = new Promise(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { remoteSaveStarted = resolve; });
    const store = makeStore();
    const opening = store.authorizeMcp({ name: "test-server", config: { type: "remote", url: entry.url, enabled: false } });
    await started;
    selectedWorkspaceId = "other";
    finish?.();
    await opening;
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
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

  test("a rejected settings update cannot report success using the old connected engine entry", async () => {
    const store = makeStore();
    saveError = "Updated configuration was rejected";
    expect(await store.connectMcp({ ...entry, headers: { Authorization: "Bearer synthetic-token" }, oauth: false })).toBe(false);
    expect(connectedEvents()).toEqual([]);
    store.dispose();
  });

  test("configuring an imported local connector preserves ownership and sends its full launch configuration only to the server", async () => {
    const config = { type: "local", command: ["node", "/plugin/server.js", "", "two words"], cwd: "/plugin", environment: { KEY: "synthetic-key", EMPTY: "" }, timeout: 45000 } satisfies import("../src/app/types").McpServerConfig;
    const store = makeStore();
    expect(await store.connectMcp({ ...entry, ...config, existingConfig: config, oauth: false })).toBe(true);
    expect(serverAdds[0]).toMatchObject({ name: "test-server", preserveScope: true, config: { ...config, enabled: true } });
    expect(engineAdds).toEqual([]);
    store.dispose();
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

  test("connects the new native runtime to OpenCode with its own identity and environment", async () => {
    const integration = MCP_QUICK_CONNECT.find((item) => item.id === "open-computer-use");
    if (!integration) throw new Error("Open Computer Use is missing from the integration directory");
    status = { "open-computer-use": { status: "connected" } };
    const store = makeStore();
    expect(await store.connectMcp(integration)).toBe(true);
    const config = { type: "local", enabled: true, ...openComputerUseConfig };
    expect(serverAdds).toEqual([{ name: "open-computer-use", config }]);
    expect(engineAdds).toEqual([]);
    expect(openComputerUseCalls).toBe(1);
    expect(store.getSnapshot().mcpAuthModalOpen).toBe(false);
  });

  test("a failed runtime install cannot save a broken command or fall back to the old helper", async () => {
    const integration = MCP_QUICK_CONNECT.find((item) => item.id === "open-computer-use");
    if (!integration) throw new Error("Open Computer Use is missing from the integration directory");
    openComputerUseError = "Download failed its integrity check";
    const store = makeStore();
    expect(await store.connectMcp(integration)).toBe(false);
    expect(serverAdds).toHaveLength(0);
    expect(engineAdds).toHaveLength(0);
    expect(store.getSnapshot().mcpStatus).toContain(openComputerUseError);
  });

  test("remote workers cannot install or receive the local desktop command", async () => {
    const integration = MCP_QUICK_CONNECT.find((item) => item.id === "open-computer-use");
    if (!integration) throw new Error("Open Computer Use is missing from the integration directory");
    expect(await makeStore(true).connectMcp(integration)).toBe(false);
    expect(openComputerUseCalls).toBe(0);
    expect(serverAdds).toHaveLength(0);
    expect(engineAdds).toHaveLength(0);
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

  test("Actaport resolves its bundled command and saves only the private connection reference", async () => {
    const actaport = MCP_QUICK_CONNECT.find((item) => item.serverName === "actaport");
    if (!actaport) throw new Error("Missing Actaport extension");
    status = { actaport: { status: "connected" } };
    expect(await makeStore().connectMcp(actaport)).toBe(true);
    expect(serverAdds).toHaveLength(1);
    expect(serverAdds[0]).toMatchObject({ name: "actaport", config: { type: "local", command: ["node", "/tmp/bundled-actaport/index.mjs"],
      environment: { ACTAPORT_CONNECTION_FILE: "/tmp/actaport-connection.json", ACTAPORT_ALLOW_WRITES: "0", ACTAPORT_TOOLSETS: "" } } });
    expect(JSON.stringify(serverAdds)).not.toContain("clientSecret");
    expect(JSON.stringify(serverAdds)).not.toContain("password");
  });

  test("Actaport desktop credentials cannot be sent to a remote worker", async () => {
    const actaport = MCP_QUICK_CONNECT.find((item) => item.serverName === "actaport");
    if (!actaport) throw new Error("Missing Actaport extension");
    expect(await makeStore(true).connectMcp(actaport)).toBe(false);
    expect(serverAdds).toHaveLength(0);
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


test("migration and automatic reconnect wait without starting another OAuth sign-in", () => {
  expect(mcpConnectOutcome({ name: "Saved connector", description: "", type: "remote", oauth: true }, { status: "connecting", message: "Transferring saved sign-in" }, false)).toBe("pending");
});
