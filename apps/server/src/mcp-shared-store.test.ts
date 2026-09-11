import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLegalworkRuntimeConfig,
  keepLegalworkRuntimeConfigFileFresh,
  legalworkRuntimeConfigFilePath,
  writeLegalworkRuntimeConfigFile,
} from "./legalwork-runtime-config.js";
import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";
import { installCloudPlugin } from "./cloud-plugins.js";
import { importConnectorsIntoSharedRow } from "./mcp-shared-store.js";
import {
  readGlobalMcpMap,
  readRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/**
 * One connector store for every workspace. A desktop connector is saved into
 * the shared row; every workspace lists it, every workspace's engine config
 * carries it, and connectors earlier builds left in per-workspace rows or in
 * files are folded into the same row at startup.
 */

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;
let previousXdg: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousDb;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

const FIBERY = { type: "remote", url: "https://mcp.fibery.io/mcp", enabled: true, oauth: {} };
const NOTION = { type: "remote", url: "https://mcp.notion.com/mcp", enabled: true, oauth: {} };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-shared-mcp-"));
  roots.push(root);
  previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  // listMcp reads the user's global opencode config; never this machine's.
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  const wsA = join(root, "a");
  const wsB = join(root, "b");
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_a", name: "A", path: wsA, preset: "starter", workspaceType: "local" },
      { id: "ws_b", name: "B", path: wsB, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, wsA, wsB, config };
}

async function engineMcp(config: ServerConfig, workspaceId: string) {
  const parsed = JSON.parse(await buildLegalworkRuntimeConfig(config, workspaceId)) as {
    mcp?: Record<string, Record<string, unknown>>;
  };
  return parsed.mcp ?? {};
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("shared connector store", () => {
  test("a connector is shared by default: listed in every workspace, in every workspace's engine config", async () => {
    const { wsA, wsB, config } = await setup();
    expect(await addMcp(config, "ws_a", "fibery", FIBERY)).toEqual({ action: "added" });

    for (const [workspaceId, root] of [["ws_a", wsA], ["ws_b", wsB]] as const) {
      const items = await listMcp(config, workspaceId, root);
      expect(items.map((item) => `${item.name}:${item.source}`)).toEqual(["fibery:config.remote"]);
      expect((await engineMcp(config, workspaceId)).fibery?.url).toBe(FIBERY.url);
    }
    // Stored once, in the shared row — not in the workspace that connected it.
    expect((await readRuntimeOpencodeConfig(config, "ws_a")).mcp).toBeUndefined();
    expect((await readGlobalMcpMap(config)).fibery).toEqual(FIBERY);
  });

  test("a workspace's own entry overrides the shared one only in that workspace", async () => {
    const { config } = await setup();
    await addMcp(config, "ws_a", "fibery", FIBERY, "global");
    const own = { ...FIBERY, url: "https://firm.example/fibery-proxy/mcp" };
    expect(await addMcp(config, "ws_a", "fibery", own, "workspace")).toEqual({ action: "updated" });

    expect((await engineMcp(config, "ws_a")).fibery?.url).toBe(own.url);
    expect((await engineMcp(config, "ws_b")).fibery?.url).toBe(FIBERY.url);

    // Disconnecting the app removes every copy, or one would resurrect it.
    expect(await removeMcp(config, "ws_a", "fibery")).toEqual(["workspace", "global"]);
    expect(await engineMcp(config, "ws_a")).toEqual({});
    expect(await engineMcp(config, "ws_b")).toEqual({});
    expect(await removeMcp(config, "ws_a", "fibery")).toEqual([]);
  });

  test("saving a connector as shared drops the workspace copy that would shadow it", async () => {
    const { config } = await setup();
    await addMcp(config, "ws_a", "fibery", { ...FIBERY, url: "https://old.example/mcp" }, "workspace");
    expect(await addMcp(config, "ws_a", "fibery", FIBERY)).toEqual({ action: "updated" });
    expect((await readRuntimeOpencodeConfig(config, "ws_a")).mcp).toEqual({});
    expect((await engineMcp(config, "ws_a")).fibery?.url).toBe(FIBERY.url);
  });

  test("toggling a shared connector writes the shared row", async () => {
    const { config } = await setup();
    await addMcp(config, "ws_a", "fibery", FIBERY, "global");
    expect(await setMcpEnabled(config, "ws_b", "fibery", false)).toBe(true);
    expect((await readGlobalMcpMap(config)).fibery?.enabled).toBe(false);
    expect((await engineMcp(config, "ws_a")).fibery?.enabled).toBe(false);
    expect(await setMcpEnabled(config, "ws_b", "missing", false)).toBe(false);
  });

  test("the engine config file follows shared-row writes", async () => {
    const { config } = await setup();
    await writeLegalworkRuntimeConfigFile(config, "ws_a");
    cleanups.push(keepLegalworkRuntimeConfigFileFresh(config, "ws_a"));

    // Saved from another workspace: the file is built for ws_a, and must still update.
    await addMcp(config, "ws_b", "fibery", FIBERY, "global");
    await waitFor(async () => {
      const raw = await readFile(legalworkRuntimeConfigFilePath(config), "utf8");
      return (JSON.parse(raw) as { mcp?: Record<string, unknown> }).mcp?.fibery !== undefined;
    }, "the engine config file to carry the shared connector");
  });

  test("the shared row's copy stands in for an entry in the user's global opencode config", async () => {
    const { root, wsA, config } = await setup();
    await mkdir(join(root, "xdg", "opencode"), { recursive: true });
    await writeFile(join(root, "xdg", "opencode", "opencode.jsonc"), JSON.stringify({ mcp: { fibery: FIBERY } }), "utf8");

    expect((await listMcp(config, "ws_a", wsA)).map((item) => `${item.name}:${item.source}`)).toEqual(["fibery:config.global"]);
    await addMcp(config, "ws_a", "fibery", FIBERY, "global");
    expect((await listMcp(config, "ws_a", wsA)).map((item) => `${item.name}:${item.source}`)).toEqual(["fibery:config.remote"]);
  });
});

describe("importing connectors from earlier builds", () => {
  test("moves workspace rows and copies file entries into the shared row once", async () => {
    const { root, config } = await setup();
    const runtimeConfigFile = join(root, "runtime-opencode-config.json");
    const globalOpencodeConfigFile = join(root, "opencode.jsonc");
    const notionFromRow = { ...NOTION, url: "https://mcp.notion.com/mcp?row=1" };
    await writeRuntimeOpencodeConfig(config, "ws_a", (current) => ({ ...current, mcp: { notion: notionFromRow }, plugin: ["keep-me"] }));
    await writeRuntimeOpencodeConfig(config, "ws_b", (current) => ({ ...current, mcp: { fibery: FIBERY } }));
    await writeFile(
      runtimeConfigFile,
      JSON.stringify({ mcp: { legalmemory: { type: "remote", url: "https://ki.firm.internal/mcp/", enabled: true }, notion: NOTION } }),
      "utf8",
    );
    const globalFile = [
      "{",
      '  // written by an earlier desktop build',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "courtlistener": { "type": "remote", "url": "https://mcp.courtlistener.com/mcp", "enabled": true },',
      '    "broken": { "type": "remote" }',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(globalOpencodeConfigFile, globalFile, "utf8");

    const first = await importConnectorsIntoSharedRow(config, { runtimeConfigFile, globalOpencodeConfigFile });
    expect(first.imported).toEqual(["notion", "fibery", "legalmemory", "courtlistener"]);

    const shared = await readGlobalMcpMap(config);
    expect(Object.keys(shared).sort()).toEqual(["courtlistener", "fibery", "legalmemory", "notion"]);
    // The row's copy wins over the file's; an entry the engine would refuse is left out.
    expect(shared.notion?.url).toBe(notionFromRow.url);
    expect(shared.broken).toBeUndefined();
    // Workspace rows are emptied (moved, not copied) and keep their other state.
    expect((await readRuntimeOpencodeConfig(config, "ws_a")).mcp).toBeUndefined();
    expect((await readRuntimeOpencodeConfig(config, "ws_a")).plugin).toEqual(["keep-me"]);
    expect((await readRuntimeOpencodeConfig(config, "ws_b")).mcp).toBeUndefined();
    // The user's file is only read.
    expect(await readFile(globalOpencodeConfigFile, "utf8")).toBe(globalFile);
    // Every workspace's engine config now carries all of them.
    expect(Object.keys(await engineMcp(config, "ws_b")).sort()).toEqual(["courtlistener", "fibery", "legalmemory", "notion"]);

    const second = await importConnectorsIntoSharedRow(config, { runtimeConfigFile, globalOpencodeConfigFile });
    expect(second.imported).toEqual([]);
    expect(await readGlobalMcpMap(config)).toEqual(shared);
  });

  test("leaves the MCPs a workspace's plugins brought along with that workspace", async () => {
    const { root, wsA, config } = await setup();
    await installCloudPlugin({
      serverConfig: config,
      workspaceId: "ws_a",
      workspaceRoot: wsA,
      marketplaceId: null,
      resolved: {
        plugin: { id: "plugin_1", name: "Brief Plugin", description: null, updatedAt: null },
        memberships: [
          {
            configObjectId: "config_mcp_1",
            configObject: {
              id: "config_mcp_1",
              objectType: "mcp",
              title: "Brief MCP",
              description: null,
              currentRelativePath: null,
              status: "active",
              updatedAt: null,
              latestVersion: {
                id: "version_mcp_1",
                rawSourceText: JSON.stringify({ mcpServers: { brief: { url: "https://example.com/mcp" } } }),
                normalizedPayloadJson: { mcpServers: { brief: { url: "https://example.com/mcp" } } },
              },
            },
          },
        ],
      },
    });
    await addMcp(config, "ws_a", "fibery", FIBERY, "workspace");

    const result = await importConnectorsIntoSharedRow(config, {
      runtimeConfigFile: join(root, "missing.json"),
      globalOpencodeConfigFile: join(root, "missing.jsonc"),
    });
    expect(result.imported).toEqual(["fibery"]);
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "ws_a")).mcp ?? {})).toEqual(["brief"]);
    expect(Object.keys(await readGlobalMcpMap(config))).toEqual(["fibery"]);
    expect(Object.keys(await engineMcp(config, "ws_b"))).toEqual(["fibery"]);
  });

  test("does nothing on a read-only server", async () => {
    const { root, config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_a", (current) => ({ ...current, mcp: { fibery: FIBERY } }));
    const result = await importConnectorsIntoSharedRow(
      { ...config, readOnly: true },
      { runtimeConfigFile: join(root, "missing.json"), globalOpencodeConfigFile: join(root, "missing.jsonc") },
    );
    expect(result.imported).toEqual([]);
    expect((await readRuntimeOpencodeConfig(config, "ws_a")).mcp).toEqual({ fibery: FIBERY });
  });
});
