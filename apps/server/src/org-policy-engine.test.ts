import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { legalworkRuntimeConfigFilePath, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { releaseOrgPolicyKey, resetOrgPolicyRuntimeForTests, scheduleOrgPolicySync } from "./org-policy.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { LegalWorkOrgPolicyGuard } from "./opencode-plugins/legalwork-org-policy-guard.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const realFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  setSystemTime();
  while (cleanups.length) await cleanups.pop()?.();
});

function fakeFetch(handler: (url: string) => Response) {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => handler(String(input)), { preconnect: realFetch.preconnect });
}

async function setup(entries: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-org-policy-engine-"));
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config = {
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
  } as unknown as ServerConfig;
  cleanups.push(async () => {
    resetOrgPolicyRuntimeForTests(config);
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
    else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  });
  fakeFetch((url) =>
    url.endsWith("/api/desktop/policy")
      ? Response.json({ schemaVersion: 1, orgId: "org_kanzlei", orgName: "Kanzlei", revision: 1, role: "member", updatedAt: null, entries })
      : new Response(null, { status: 404 }),
  );
  await writeEigenweltConnection(config, {
    platformToken: "tok",
    platformURL: eigenweltPlatformUrl(),
    account: { userId: "u", userName: "Anna", userEmail: null, orgId: "org_kanzlei", orgName: "Kanzlei" },
  });
  await scheduleOrgPolicySync(config, { force: true });
  return config;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("the firm's tool permissions in the engine", () => {
  test("enforced rules are the minimum and go to the firm's own config folder", async () => {
    const config = await setup({ "tools.permissions": { mode: "enforced", value: { bash: "ask", edit: "ask" } } });
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({
      permission: { bash: "deny", edit: "allow", webfetch: "allow" },
    }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");

    const runtime = await readJson(legalworkRuntimeConfigFilePath(config));
    // The member's stricter bash rule stays; edit follows the firm.
    expect(runtime.permission).toMatchObject({ bash: "deny", edit: "ask", webfetch: "allow" });
    const layer = await readJson(join(orgPolicyEngineDir(config), "opencode.json"));
    expect(layer).toEqual({
      permission: { bash: "deny", edit: "ask" },
      agent: { legalwork: { permission: { bash: "deny", edit: "ask" } } },
    });
  });

  test("defaults replace the member's rule, and nothing is enforced once taken back", async () => {
    const config = await setup({ "tools.permissions": { mode: "default", value: { webfetch: "deny" } } });
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { webfetch: "allow" } }));
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).permission).toMatchObject({ webfetch: "deny" });
    expect(await readJson(join(orgPolicyEngineDir(config), "opencode.json"))).toEqual({});

    await releaseOrgPolicyKey(config, "tools.permissions");
    await writeLegalworkRuntimeConfigFile(config, "ws_1");
    expect((await readJson(legalworkRuntimeConfigFilePath(config))).permission).toMatchObject({ webfetch: "allow" });
  });
});

describe("the guard plugin", () => {
  test("refuses what the firm denies, and calls it covers while the engine's rules are looser", async () => {
    process.env.LEGALWORK_SERVER_URL = "http://legalwork.test";
    let guard: Record<string, unknown> = { orgName: "Kanzlei", permission: { bash: { "*": "ask", "rm *": "deny" }, edit: "ask" }, blockedMcpServers: ["crm"] };
    fakeFetch((url) => (url.endsWith("/org-policy/guard") ? Response.json(guard) : new Response(null, { status: 404 })));
    let engine: Record<string, unknown> = { permission: { bash: { "*": "ask", "rm *": "deny" }, edit: "ask" } };
    const hooks = await LegalWorkOrgPolicyGuard({ client: { config: { get: async () => ({ data: engine }) } } });
    const call = (tool: string, args: Record<string, unknown>) => hooks["tool.execute.before"]({ tool }, { args });

    await call("bash", { command: "ls -la" });
    await call("read", { filePath: "/x" });
    await expect(call("bash", { command: "rm -rf /" })).rejects.toThrow("Kanzlei does not allow");
    await expect(call("crm_search", {})).rejects.toThrow('the connector "crm"');

    // A project file loosened the engine's rules: refused until restored.
    setSystemTime(new Date(Date.now() + 10_000));
    engine = { permission: { bash: "allow", edit: "ask" } };
    await expect(call("bash", { command: "ls" })).rejects.toThrow("until its settings are restored");
    await call("edit", { filePath: "/x" });

    // Nothing enforced: everything goes through.
    setSystemTime(new Date(Date.now() + 20_000));
    guard = { orgName: "Kanzlei", permission: {}, blockedMcpServers: [] };
    await call("bash", { command: "rm -rf /" });
  });
});
