#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { createServerLogger, startServer, syncAllWorkspacesRuntimeMcpToEngine } from "./server.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";
import { keepLegalworkRuntimeConfigFileFresh, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { prepareManagedOpencodeEngineDb } from "./managed-opencode-db.js";
import { refreshEigenweltFreeManifest } from "./eigenwelt-free.js";
import { refreshEigenweltProviderModels } from "./eigenwelt-auth.js";
import pkg from "../package.json" with { type: "json" };

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
const logger = createServerLogger(config);
const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
let managedOpencode: ManagedOpencodeServer | null = null;

if (!config.readOnly) {
  for (const workspace of config.workspaces) {
    await ensureWorkspaceFiles(workspace.path, workspace.preset ?? "starter");
  }
}

if (!config.opencodeBaseUrl && process.env.LEGALWORK_MANAGE_OPENCODE === "1") {
  const workspace = config.workspaces[0];
  if (workspace?.path) {
    // Server-managed config file: the engine re-reads it from disk on every
    // instance rebuild, and keepLegalworkRuntimeConfigFileFresh rewrites it
    // on every runtime-DB write — so disposes always pick up current state.
    const runtimeConfigPath = await writeLegalworkRuntimeConfigFile(config, workspace.id);
    keepLegalworkRuntimeConfigFileFresh(config, workspace.id);
    // Fire-and-forget: refresh the free-tier manifest disk cache; on change,
    // rewrite the engine config file so the free provider (and the zen
    // disable that rides on it) update on the next instance rebuild.
    void refreshEigenweltFreeManifest(config)
      .then((changed) => (changed ? writeLegalworkRuntimeConfigFile(config, workspace.id) : undefined))
      .catch(() => undefined);
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
    managedOpencode = await createManagedOpencodeServer({
      bin: process.env.LEGALWORK_OPENCODE_BIN,
      cwd: managedOpencodeCwd,
      excludedPorts: [config.port],
      env: {
        ...(process.env.LEGALWORK_DEV_MODE ? { LEGALWORK_DEV_MODE: process.env.LEGALWORK_DEV_MODE } : {}),
        ...(process.env.LEGALWORK_UI_CONTROL_DISCOVERY ? { LEGALWORK_UI_CONTROL_DISCOVERY: process.env.LEGALWORK_UI_CONTROL_DISCOVERY } : {}),
        LEGALWORK_SERVER_URL: serverUrl,
        LEGALWORK_SERVER_TOKEN: config.token,
        OPENCODE_CONFIG: runtimeConfigPath,
        ...(managedDb ? { OPENCODE_DB: managedDb.path } : {}),
      },
    });
    config.opencodeBaseUrl = managedOpencode.url;
    config.opencodeUsername = managedOpencode.username;
    config.opencodePassword = managedOpencode.password;
    for (const entry of config.workspaces) {
      entry.baseUrl ??= managedOpencode.url;
      entry.opencodeUsername ??= managedOpencode.username;
      entry.opencodePassword ??= managedOpencode.password;
      entry.directory ??= entry.path;
    }
    logger.log("info", `Managed OpenCode listening on ${managedOpencode.url}`);
  }
}

const server = await startServer(config);

// The runtime config file above only covers workspaces[0]. Push every
// workspace's runtime-DB MCPs into the engine so they aren't invisible
// until a manual reload. Best-effort.
if (managedOpencode) {
  void syncAllWorkspacesRuntimeMcpToEngine(config);
}

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
  void managedOpencode?.close();
  (server as { stop?: (closeActiveConnections?: boolean) => void }).stop?.(true);
};

process.once("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.once("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
