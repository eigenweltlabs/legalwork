import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudAssistantSetup } from "./cloud-assistant-setup.js";
import { CloudReplica } from "./cloud-sync/replica.js";
import { DirectoryObjects } from "./cloud-sync/objects.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import type { ServerConfig } from "./types.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(idle = true) {
  const root = await mkdtemp(join(tmpdir(), "cloud-onboarding-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "manual", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  await writeEigenweltConnection(config, { account: { userId: "user_a", orgId: "org_a", userName: null, userEmail: null, orgName: "Test" },
    platformToken: "access-token", accessTokenExpiresAt: Date.now() + 900000 });
  const objects = await DirectoryObjects.open(join(root, "remote"));
  const open = CloudReplica.open.bind(CloudReplica);
  const replicaSpy = spyOn(CloudReplica, "open").mockImplementation((conf, settings) => open(conf, settings, objects));
  cleanup.push(() => replicaSpy.mockRestore());
  const calls: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push(init?.method ?? "GET");
    return Response.json({ userId: "user_a", orgId: "org_a", accountId: "account_a", canEnable: true,
      enabled: init?.method === "POST", state: init?.method === "POST" ? "ready" : "off", error: null });
  }, { preconnect: fetch.preconnect }));
  cleanup.push(() => fetchSpy.mockRestore());
  const setup = await CloudAssistantSetup.open({ config, idle: async () => idle });
  cleanup.push(() => setup.close());
  return { setup, config, calls };
}
async function settle(setup: CloudAssistantSetup) {
  for (let i = 0; i < 100; i++) { const state = (await setup.status()).state; if (state === "enabled" || state === "error") return; await Bun.sleep(5); }
  throw new Error("Setup did not settle");
}
test("enable seeds once, retains local execution, and account changes detach its cloud sync", async () => {
  const { setup, config, calls } = await fixture();
  await Promise.all([setup.enable(), setup.enable()]); await settle(setup);
  expect(await setup.enabled()).toBe(true);
  expect(config.cloudSync?.role).toBe("companion");
  expect(config.cloudSync?.canExecute()).toBe(true);
  expect(calls).toEqual(["GET", "POST"]);
  await setup.enable(); expect(calls).toEqual(["GET", "POST"]);
  await setup.disable(); expect(config.cloudSync).toBeUndefined();
  await setup.enable(); await settle(setup);
  await writeEigenweltConnection(config, { account: null, platformToken: null });
  expect(await setup.enabled()).toBe(false);
  expect(config.cloudSync).toBeUndefined();
  expect((await setup.status()).state).toBe("off");
});
test("an active local run blocks seeding without activating a cloud worker", async () => {
  const { setup, config, calls } = await fixture(false);
  await setup.enable(); await settle(setup);
  expect((await setup.status()).state).toBe("error");
  expect(calls).toEqual(["GET"]);
  expect(config.cloudSync).toBeUndefined();
});
