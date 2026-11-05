#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { connectorRuntimeCapability } from "./connectors/capability.js";
import { join, resolve } from "node:path";
import { resolveServerOpencodeExecutable } from "./server-opencode-executable.js";
import { engineStorageDir } from "./engine-storage.js";

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { type ManagedOpencodeServer } from "./managed-opencode.js";
import { createServerLogger, startServer } from "./server.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";
import { globalSkillsDir } from "./workspace-files.js";
import { ensureBundledWorkflows } from "./bundled-workflows.js";
import { retireSharedLegacyReview } from "./reviews/retire-legacy.js";
import {
  keepLegalworkRuntimeConfigFileFresh,
  legalworkRuntimeConfigFilePath,
  writeLegalworkRuntimeConfigFile,
  legalworkMandatoryRuntimeConfigContent,
} from "./legalwork-runtime-config.js";
import { globalOpenCodeConfigPath } from "./mcp.js";
import { importConnectorsIntoSharedRow } from "./mcp-shared-store.js";
import { repairAllWorkspaceRuntimeProviders } from "./runtime-provider-repair.js";
import { prepareManagedOpencodeDependencies } from "./managed-opencode-dependencies.js";
import { prepareManagedOpencodeEngineDb } from "./managed-opencode-db.js";
import { refreshEigenweltProviderModels } from "./eigenwelt-auth.js";
import { ensureWikiAgentToken } from "./wiki/agent-access.js";
import pkg from "../package.json" with { type: "json" };
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { createConfiguredManagedEngine, startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import { bootCloudSync } from "./cloud-sync/lifecycle.js";
import { runCloudSyncCli } from "./cloud-sync/cli.js";

if (process.argv[2] === "sync") {
  await runCloudSyncCli(process.argv.slice(3));
  process.exit(0);
}

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}

const config = await resolveServerConfig(args);
const managedEngine = process.env.LEGALWORK_MANAGE_OPENCODE === "1" && !config.opencodeBaseUrl;
config.agentSandboxEnabled = managedEngine && process.env.LEGALWORK_MANAGED_OPENCODE_SANDBOX !== "0";
config.engineProjectTrustRequired = managedEngine;
config.engineConfigurationMode = managedEngine ? "managed" : "native-project";
const logger = createServerLogger(config);
let managedOpencode: ManagedOpencodeServer | null = null;
let managedLifecycle: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | null = null;
let stopConfigRefresh: (() => Promise<void>) | null = null;
const cloudSync = await bootCloudSync(config);
if (config.cloudSync) config.cloudSync.onLeaseLost = () => { void managedOpencode?.close(); };

if (cloudSync?.replica.settings.role === "executor" && process.env.LEGALWORK_MANAGE_OPENCODE !== "1")
  throw new Error("A cloud execution owner requires LEGALWORK_MANAGE_OPENCODE=1");
if (!config.readOnly) {
  await retireSharedLegacyReview(globalSkillsDir());
  await ensureBundledWorkflows();
  for (const workspace of config.workspaces) {
    if (config.cloudSync && !config.cloudSync.shouldSyncFiles(workspace.id)) continue;
    await ensureWorkspaceFiles(workspace.path, workspace.preset ?? "starter", { bundledCore: config.engineConfigurationMode !== "managed" });
  }
}
// Drop retired / unparsable provider blocks from the runtime DB BEFORE the
// engine config file is built: one bad stored block takes the engine down.
await repairAllWorkspaceRuntimeProviders(config);
// Connectors are shared by every workspace; fold what earlier builds stored
// per workspace or in files into the shared row before the engine config
// file is built from it.
await importConnectorsIntoSharedRow(config, {
  runtimeConfigFile: legalworkRuntimeConfigFilePath(config),
  globalOpencodeConfigFile: globalOpenCodeConfigPath(),
}).catch((error: unknown) => {
  console.warn(`[legalwork-server] connector import skipped: ${error instanceof Error ? error.message : String(error)}`);
});

const server = await startServer(config, { onListening: async (port) => {
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`;
  if (!config.opencodeBaseUrl && process.env.LEGALWORK_MANAGE_OPENCODE === "1") {
    const workspace = config.workspaces[0];
    if (workspace?.path) {
      // Server-managed config file: the engine re-reads it from disk on every
      // instance rebuild, and keepLegalworkRuntimeConfigFileFresh rewrites it
      // on every runtime-DB write — so disposes always pick up current state.
      const runtimeConfigPath = await writeLegalworkRuntimeConfigFile(config, workspace.id);
      stopConfigRefresh = keepLegalworkRuntimeConfigFileFresh(config, workspace.id);
      // Fire-and-forget: pick up models added on the Eigenwelt gateway since the
      // provider was connected (no-op unless provider.eigenwelt is configured).
      void refreshEigenweltProviderModels(config, workspace.id);
      const managedOpencodeCwd = process.env.LEGALWORK_MANAGED_OPENCODE_CWD?.trim() || workspace.path;
      await mkdir(managedOpencodeCwd, { recursive: true });
      // Private engine DB (see managed-opencode-db.ts): keep the managed engine
      // off OpenCode's global opencode.db so a separately installed OpenCode
      // can never migrate the engine's schema out from under it (issue #62).
      const managedDb = await prepareManagedOpencodeEngineDb(config);
      if (managedDb) process.env.OPENCODE_DB = managedDb.path;
      const engineHome = join(engineStorageDir(config), "engine-home");
      await mkdir(engineHome, { recursive: true });
      const database = managedDb?.path || (process.env.OPENCODE_DB ? resolve(managedOpencodeCwd, process.env.OPENCODE_DB) : "");
      if (!database) throw new Error("A private managed engine database is required for native restart recovery.");
      process.env.OPENCODE_DB = database;
      const service = { configDirectory: orgPolicyEngineDir(config), stateDirectory: join(engineHome, "state") };
      const dependencies = await prepareManagedOpencodeDependencies(config);
      if (dependencies.reason === "bundle-unavailable") console.warn("[legalwork-server] Prepare desktop resources to validate the released engine's bundled runtime declaration.");
      managedLifecycle = await startManagedEngineLifecycle({ config, database, service, create: async (mode, beforeSpawn) => {
        const engine = await createConfiguredManagedEngine(config, {
        bin: await resolveServerOpencodeExecutable(process.env.LEGALWORK_OPENCODE_BIN),
        ...(process.env.LEGALWORK_MANAGED_OPENCODE_PORT ? { port: Number(process.env.LEGALWORK_MANAGED_OPENCODE_PORT) } : {}),
        ...(process.env.LEGALWORK_MANAGED_OPENCODE_LOG_LEVEL ? { logLevel: process.env.LEGALWORK_MANAGED_OPENCODE_LOG_LEVEL } : {}),
        cwd: process.env.LEGALWORK_MANAGED_OPENCODE_CWD?.trim() || engineHome,
        beforeSpawn,
          ...(mode === "service" ? { service } : { parentLease: true }),
        excludedPorts: [config.port],
        env: {
          ...(process.env.LEGALWORK_DEV_MODE ? { LEGALWORK_DEV_MODE: process.env.LEGALWORK_DEV_MODE } : {}),
          ...(process.env.LEGALWORK_UI_CONTROL_DISCOVERY ? { LEGALWORK_UI_CONTROL_DISCOVERY: process.env.LEGALWORK_UI_CONTROL_DISCOVERY } : {}),
          LEGALWORK_SERVER_URL: serverUrl,
          LEGALWORK_SERVER_TOKEN: config.token,
          LEGALWORK_WIKI_AGENT_TOKEN: await ensureWikiAgentToken(config),
          LEGALWORK_CONNECTOR_TOKEN: connectorRuntimeCapability(config),
          OPENCODE_CONFIG: runtimeConfigPath,
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
          OPENCODE_TEST_HOME: engineHome,
          XDG_CONFIG_HOME: join(engineHome, "config"),
          OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config),
          OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config),
          XDG_STATE_HOME: service.stateDirectory,
          OPENCODE_DB: database,
          OPENCODE_MODELS_URL: `${serverUrl}/model-catalog`,
          ...(process.env.LEGALWORK_ENGINE_DATA_HOME ? { XDG_DATA_HOME: process.env.LEGALWORK_ENGINE_DATA_HOME } : {}),
        },
        });
        managedOpencode = engine;
        return engine;
      } });
      logger.log("info", `Managed OpenCode listening on ${managedLifecycle.engine.url}`);
    }
  }
} }).catch(async (error: unknown) => {
  await stopConfigRefresh?.();
  if (managedLifecycle) await managedLifecycle.close(); else await managedOpencode?.close();
  await cloudSync?.stop();
  throw error;
});


const url = `http://${config.host}:${server.port}`;
logger.log("info", `LegalWork server listening on ${url}`);

if (config.tokenSource === "generated") {
  logger.log("info", `Client token: ${config.token}`);
}

if (config.hostTokenSource === "generated") {
  logger.log("info", `Host token: ${config.hostToken}`);
}

if (config.workspaces.length === 0) {
  logger.log("info", "No workspaces configured. Add --workspace or update server.json.");
} else {
  logger.log("info", `Workspaces: ${config.workspaces.length}`);
}

if (args.verbose) {
  logger.log("info", `Config path: ${config.configPath ?? "unknown"}`);
  logger.log("info", `Read-only: ${config.readOnly ? "true" : "false"}`);
  logger.log("info", `Approval: ${config.approval.mode} (${config.approval.timeoutMs}ms)`);
  logger.log("info", `CORS origins: ${config.corsOrigins.join(", ")}`);
  logger.log("info", `Authorized roots: ${config.authorizedRoots.join(", ")}`);
  logger.log("info", `Token source: ${config.tokenSource}`);
  logger.log("info", `Host token source: ${config.hostTokenSource}`);
}

const shutdown = () => {
  return (async () => { await stopConfigRefresh?.(); if (managedLifecycle) await managedLifecycle.close(); else await managedOpencode?.close(); await server.stop(); if (cloudSync) { try { await cloudSync.replica.tick(); } finally { await cloudSync.stop(); } } })();
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
