import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PluginImportRequest, PluginImportPreview } from "@legalwork/types/plugin-import";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { createLegalworkServerStore } from "../src/react-app/domains/connections/legalwork-server-store";
import { createExtensionsStore } from "../src/react-app/domains/settings/state/extensions-store";
import { createConnectionsStore } from "../src/react-app/domains/connections/store";

const preview: PluginImportPreview = {
  id: "import:claude:github", name: "github", description: null, version: null, format: "claude", root: ".", digest: "reviewed", fileCount: 2, bytes: 100,
  components: [{ type: "mcp", name: "github", installedName: "imported-github" }, { type: "skill", name: "review", installedName: "github-review" }], warnings: [],
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
let skillReads = 0;
let skillReadStarted: (() => void) | undefined;
let skillReadWait: Promise<void> | undefined;
let imported = false;
let importWrites = 0;
let finishConnectors: (() => void) | undefined;
let connectorWait: Promise<void> | undefined;
let connectorNames: readonly string[] = [];
let importRequests: PluginImportRequest[] = [];
let skillWrites: Array<{ name: string; scope?: string }> = [];

function makeServerStore() {
  return createLegalworkServerStore({
    startupPreference: () => "local", documentVisible: () => true, developerMode: () => false, runtimeWorkspaceId: () => null, activeClient: () => null,
    selectedWorkspaceDisplay: () => ({ id: "local", name: "Local", path: "/tmp/workspace", preset: "", workspaceType: "local" }),
    restartLocalServer: async () => false,
  });
}
function makeStore(refreshConnectors?: (names: readonly string[]) => Promise<void>) {
  const legalworkServer = makeServerStore();
  return createExtensionsStore({
    client: () => null, projectDir: () => "/tmp/workspace", selectedWorkspaceId: () => "local", selectedWorkspaceRoot: () => "/tmp/workspace", workspaceType: () => "local", legalworkServer,
    legalworkServerConnection: () => ({ legalworkServerClient: createLegalworkServerClient({ baseUrl: "http://127.0.0.1:9001", token: "test" }), legalworkServerStatus: "connected", legalworkServerCapabilities: null }),
    runtimeWorkspaceId: () => "local", setBusy: () => {}, setBusyLabel: () => {}, setBusyStartedAt: () => {}, setError: () => {},
    refreshConnectors: refreshConnectors ?? (async names => { connectorNames = names; finishConnectors?.(); await connectorWait; }),
  });
}

beforeEach(() => {
  importRequests = []; skillWrites = []; skillReads = 0; imported = false; importWrites = 0; skillReadStarted = undefined; skillReadWait = undefined; finishConnectors = undefined; connectorWait = undefined; connectorNames = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __LEGALWORK_ELECTRON__: {
    invokeDesktop: async (command: string) => {
      if (command !== "listLocalSkills") throw new Error(`Unexpected desktop command: ${command}`);
      skillReads += 1;
      const items = imported ? [{ name: "github-review", path: "/tmp/SKILL.md", description: "Review code" }] : [];
      skillReadStarted?.();
      await skillReadWait;
      return { items, skipped: [] };
    },
  } } });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/plugin-imports/preview")) { importRequests.push(await request.json()); return Response.json({ items: [{ ...preview, format: "skills", readiness: "ready", validationId: "reviewed-on-server", components: preview.components.filter(item => item.type === "skill") }] }); }
    if (path.endsWith("/plugin-imports/install")) { importRequests.push(await request.json()); imported = true; importWrites += 1; return Response.json({ preview }); }
    if (path.endsWith("/firm-hub/skills")) return Response.json({ items: [] });
    if (path.endsWith("/skills")) {
      if (request.method === "POST") { skillWrites.push(await request.json()); return Response.json({ name: skillWrites.at(-1)?.name, path: "/global/SKILL.md" }); }
      return Response.json({ items: [], skipped: [] });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.fetch = originalFetch;
});

test("removing a plugin refreshes its connectors and skills after the server confirms deletion", async () => {
  imported = true;
  const store = makeStore();
  await store.refreshSkills({ force: true });
  const order: string[] = [];
  finishConnectors = () => { order.push("refresh connectors"); };
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "DELETE" && new URL(request.url).pathname.endsWith("/cloud-plugins/test")) {
      order.push("delete"); imported = false;
      return Response.json({ item: {} });
    }
    return fixtureFetch(input, init);
  };
  try {
    await store.removeImportedPackage("test");
    expect(order).toEqual(["delete", "refresh connectors"]);
    expect(connectorNames).toEqual([]);
    expect(store.skills()).toEqual([]);
  } finally { store.dispose(); }
});

test("removing a plugin clears the real connector store, including a stale in-flight read", async () => {
  const connections = createConnectionsStore({
    client: () => null, setClient: () => {}, projectDir: () => "/tmp/workspace", selectedWorkspaceId: () => "local", selectedWorkspaceRoot: () => "/tmp/workspace", workspaceType: () => "local",
    legalworkServer: makeServerStore(), runtimeWorkspaceId: () => "local", developerMode: () => false,
    legalworkServerConnection: () => ({ legalworkServerClient: createLegalworkServerClient({ baseUrl: "http://127.0.0.1:9001", token: "test" }), legalworkServerStatus: "connected", legalworkServerCapabilities: null }),
  });
  const store = makeStore(names => connections.refreshImportedConnectors(names));
  imported = true;
  const fixtureFetch = globalThis.fetch;
  let holdRead = false, releaseRead = () => {}, readStarted = () => {};
  const held = new Promise<void>(resolve => { releaseRead = resolve; });
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith("/mcp")) {
      const items = imported ? [{ name: "test-plugin-global-test", config: { type: "remote", url: "https://example.com/mcp", oauth: {} }, source: "global" }] : [];
      if (holdRead) { holdRead = false; readStarted(); await held; }
      return Response.json({ items });
    }
    if (request.method === "DELETE" && path.endsWith("/cloud-plugins/test")) { imported = false; return Response.json({ item: {} }); }
    return fixtureFetch(input, init);
  };
  try {
    await connections.refreshMcpServers({ includeStatus: false });
    expect(connections.mcpServers.map(item => item.name)).toEqual(["test-plugin-global-test"]);
    holdRead = true;
    const staleRead = connections.refreshMcpServers({ includeStatus: false });
    await started;
    await store.removeImportedPackage("test");
    expect(connections.mcpServers).toEqual([]);
    releaseRead(); await staleRead;
    expect(connections.mcpServers).toEqual([]);
  } finally { releaseRead(); store.dispose(); connections.dispose(); }
});

test("finishing an import waits for connector publication and a fresh read after a pre-import skills scan", async () => {
  let releaseSkills = () => {};
  skillReadWait = new Promise<void>(resolve => { releaseSkills = resolve; });
  const started = new Promise<void>(resolve => { skillReadStarted = resolve; });
  const store = makeStore();
  const oldScan = store.refreshSkills({ force: true });
  await started;
  const result = await store.installPluginImport({ source: { provider: "claude", path: "/tmp/github" }, scope: "global", digest: preview.digest });
  let complete = false;
  const finishing = store.refreshPluginImport(result).then(() => { complete = true; });
  await Promise.resolve();
  expect(complete).toBe(false);
  skillReadWait = undefined;
  releaseSkills();
  await oldScan;
  await finishing;
  expect(skillReads).toBe(2);
  expect(connectorNames).toEqual(["imported-github"]);
  expect(store.skills().map(skill => skill.name)).toEqual(["github-review"]);
  store.dispose();
});

test("import completion remains pending while connector publication is delayed", async () => {
  let releaseConnectors = () => {};
  connectorWait = new Promise<void>(resolve => { releaseConnectors = resolve; });
  const started = new Promise<void>(resolve => { finishConnectors = resolve; });
  const store = makeStore();
  const result = await store.installPluginImport({ source: { provider: "claude", path: "/tmp/github" }, scope: "global", digest: preview.digest });
  let complete = false;
  const finishing = store.refreshPluginImport(result).then(() => { complete = true; });
  await started;
  expect(complete).toBe(false);
  expect(importWrites).toBe(1);
  releaseConnectors();
  await finishing;
  await store.refreshPluginImport(result);
  expect(importWrites).toBe(1);
  store.dispose();
});

test("missing imported skills reject completion, and retry updates the library without another import write", async () => {
  const store = makeStore();
  const result = await store.installPluginImport({ source: { provider: "claude", path: "/tmp/github" }, scope: "global", digest: preview.digest });
  imported = false;
  await expect(store.refreshPluginImport(result)).rejects.toThrow("The import was saved");
  imported = true;
  await store.refreshPluginImport(result);
  expect(store.skills().map(skill => skill.name)).toEqual(["github-review"]);
  expect(importWrites).toBe(1);
  store.dispose();
});


test("standalone GitHub skills use shared review and installation without a desktop copy or the old content-download route", async () => {
  const store = makeStore();
  const result = await store.importGithubSkills({ url: "https://github.com/team/skills", ref: "release/v1", paths: ["skills/review"], asWorkflow: true });
  expect(result.ok).toBe(true);
  expect(importRequests).toHaveLength(2);
  expect(importRequests[0]).toMatchObject({ source: { provider: "claude", url: "https://github.com/team/skills", directory: "skills/review", ref: "release/v1" }, scope: "global", asWorkflow: true });
  expect(importRequests[1]).toMatchObject({ digest: "reviewed", validationId: "reviewed-on-server" });
  expect(importWrites).toBe(1);
  store.dispose();
});

test("plugin and connector imports always review and install globally on desktop and web", async () => {
  for (const desktop of [true, false]) {
    if (!desktop) Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    const store = makeStore();
    for (const provider of ["claude", "chatgpt"] satisfies Array<"claude" | "chatgpt">) {
      const request: PluginImportRequest = { source: { provider, path: "/tmp/import-source" }, scope: "project" };
      const [review] = await store.previewPluginImports(request);
      await store.installPluginImport({ ...request, digest: review?.digest, validationId: review?.validationId });
    }
    store.dispose();
  }
  expect(importRequests).toHaveLength(8);
  expect(importRequests.every(request => request.scope === "global")).toBe(true);
});

test("browser GitHub imports and skill creation or editing use the global library", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  const store = makeStore();
  const result = await store.importGithubSkills({ url: "https://github.com/team/skills", paths: ["skills/review"] });
  expect(result.ok).toBe(true);
  expect(importRequests).toHaveLength(2);
  expect(importRequests.every(request => request.scope === "global")).toBe(true);
  expect((await store.createSkill({ name: "new-skill", content: "Create." })).ok).toBe(true);
  await store.saveSkill({ name: "new-skill", content: "Updated." });
  expect(skillWrites).toHaveLength(2);
  expect(skillWrites.every(request => request.scope === "global")).toBe(true);
  store.dispose();
});
