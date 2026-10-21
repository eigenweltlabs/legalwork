import { closeCloudPluginDbForTests } from "./cloud-plugins.js";
import { closeWorkspaceConfigForTests } from "./legalwork-workspace-config-store.js";
import { closeHubInstallsForTests } from "./eigenwelt-hub-installs-store.js";
import { drainLegalworkRuntimeConfigWrites } from "./legalwork-runtime-config.js";
import { drainFirmHubSyncForTests } from "./firm-hub.js";
import { resetOrgPolicyRuntimeForTests } from "./org-policy.js";
import { closeEigenweltConnectionForTests } from "./eigenwelt-connection-store.js";
import { closeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { closeTaskStoreForTests } from "./task-store.js";
import type { ServerConfig } from "./types.js";
import { rm } from "node:fs/promises";

/** Windows can briefly retain closed SQLite files while native finalizers run. */
export async function removeTestDirectory(path: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 20 || !(error instanceof Error) || !("code" in error) ||
          !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

/** Windows cannot unlink databases still held by a test's policy/config caches. */
export async function closeTestRuntime(config: ServerConfig) {
  await drainFirmHubSyncForTests(config);
  await drainLegalworkRuntimeConfigWrites(config).catch(() => {});
  await resetOrgPolicyRuntimeForTests(config);
  await closeEigenweltConnectionForTests(config);
  await closeCloudPluginDbForTests(config);
  await closeWorkspaceConfigForTests(config);
  await closeHubInstallsForTests(config);
  await closeTaskStoreForTests(config);
  await closeRuntimeOpencodeConfig(config);
}
