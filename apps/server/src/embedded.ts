/**
 * Single entry point for embedding the LegalWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 */
import { mkdir } from "node:fs/promises";
import { connectorRuntimeCapability } from "./connectors/capability.js";
import { join, resolve } from "node:path";
import { engineStorageDir } from "./engine-storage.js";
import { resolveServerConfig, type CliArgs } from "./config.js";
import { resolveEngineExecutable, type ManagedOpencodeServer, type OpencodeExecutionSnapshot } from "./managed-opencode.js";
import { startServer } from "./server.js";
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
import { refreshEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { startModelCatalogRelay } from "./model-catalog.js";
import type { ServeResult } from "./serve-node.js";
import type { ServerConfig } from "./types.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { createConfiguredManagedEngine, startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";
import { ensureWikiAgentToken } from "./wiki/agent-access.js";
import { bootCloudSync } from "./cloud-sync/lifecycle.js";

export type EmbeddedServerOptions = CliArgs & {
  /** Desktop networking stack, including its system proxy, for model assets. */
  modelDownloadFetch?: import("./ocr/models.js").ModelDownloadFetch;
  /** Host-resolved existing Node/OpenSSL runtime for policy-controlled HTTP hops. Never read from configuration or HTTP. */
  rawHttpNodeExecutable?: () => string;
  /** Existing physical Node/image modules for isolated, cancellable image crops. Host-only. */
  toolImageRasterRuntime?: import("./types.js").ServerRuntimeOptions["toolImageRasterRuntime"];
  /** Host-resolved bundled SDK location, including the desktop development build. */
  opencodeSdkDirectory?: string;
  decryptLegacyConnectorSecrets?: ServerConfig["decryptLegacyConnectorSecrets"];
  /** Fallback only; explicit CLI, environment and file approval settings take precedence. */
  defaultApprovalMode?: ServerConfig["approval"]["mode"];
  /** Host-owned approval presentation for manual mode. */
  requestHostApproval?: ServerConfig["requestHostApproval"];
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Host-only existing execution boundary; desktop defaults to protected. */
  managedEngineSandbox?: boolean;
  /** Path to the OpenCode binary. Falls back to LEGALWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Host-only artifact capability, unavailable to HTTP or configuration files. */
  opencodeCandidateBuild?: import("@legalwork/opencode-release/candidate").VerifiedOpencodeCandidate;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
  /** OS-resolved Documents project root provided by the desktop host. */
  projectsDirectory?: string;
  /** Native folder-picker hook, forwarded to ServerConfig.pickDirectory. */
  pickDirectory?: ServerConfig["pickDirectory"];
  /** Desktop recorder hook, forwarded to Office add-in API routes. */
  recorder?: ServerConfig["recorder"];
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config (with OpenCode URLs populated). */
  config: ServerConfig;
  /** Redacted details for the managed OpenCode child process, when spawned. */
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  managedOpencodeStatus: () => { running: boolean; pid: number | null } | null;
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
  /** Host-only notification after a successful explicit OS trust change. */
  invalidateRawHttpTrust: () => void;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options, { approvalMode: options.defaultApprovalMode });
  config.decryptLegacyConnectorSecrets = options.decryptLegacyConnectorSecrets;
  const managedEngine = options.manageOpencode === true && !config.opencodeBaseUrl;
  if (managedEngine) await expectedOpencodeVersion(options.opencodeBin?.trim() || "opencode", options.opencodeCandidateBuild);
  config.agentSandboxEnabled = managedEngine && options.managedEngineSandbox !== false;
  config.engineProjectTrustRequired = managedEngine;
  config.engineConfigurationMode = managedEngine ? "managed" : "native-project";
  config.requestHostApproval = options.requestHostApproval;
  config.pickDirectory = options.pickDirectory ?? null;
  config.projectsDirectory = options.projectsDirectory;
  config.recorder = options.recorder ?? null;
  const cloudSync = await bootCloudSync(config);

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  const managed: {
    engine: ManagedOpencodeServer | null;
    lifecycle: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | null;
    catalog: Awaited<ReturnType<typeof startModelCatalogRelay>> | null;
  } = { engine: null, lifecycle: null, catalog: null };
  let stopConfigRefresh: (() => Promise<void>) | null = null;
  let stopped = false;

  if (config.cloudSync) config.cloudSync.onLeaseLost = () => { void managed.engine?.close(); };
  if (cloudSync?.replica.settings.role === "executor" && !options.manageOpencode)
    throw new Error("A cloud execution owner requires a managed OpenCode engine");
  if (!config.readOnly) {
    await retireSharedLegacyReview(globalSkillsDir());
    await ensureBundledWorkflows();
    for (const workspace of config.workspaces) {
      if (config.cloudSync && !config.cloudSync.shouldSyncFiles(workspace.id)) continue;
      // A disconnected cloud project must not prevent the shared server from
      // starting. Its requests retry initialization and return the real error.
      await ensureWorkspaceFiles(workspace.path, workspace.preset ?? "starter", { bundledCore: config.engineConfigurationMode !== "managed" }).catch((error: unknown) => {
        console.warn(`[workspace-init] ${workspace.path}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  // Drop retired / unparsable provider blocks from the runtime DB BEFORE the
  // engine config file is built: one bad stored block takes the engine down.
  await repairAllWorkspaceRuntimeProviders(config);
  // Desktop connectors are shared by every workspace. Fold what earlier builds
  // stored per workspace or in files into the shared row before the engine
  // config file is built from it, so nothing already connected disappears.
  const connectorImport = await importConnectorsIntoSharedRow(config, {
    runtimeConfigFile: legalworkRuntimeConfigFilePath(config),
    globalOpencodeConfigFile: globalOpenCodeConfigPath(),
  }).catch((error: unknown) => {
    console.warn(`[embedded] connector import skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { imported: [] as string[] };
  });
  if (connectorImport.imported.length > 0) {
    console.log(`[embedded] moved connectors into the shared store: ${connectorImport.imported.join(", ")}`);
  }

  const server = await startServer(config, { modelDownloadFetch: options.modelDownloadFetch,
    ...(options.rawHttpNodeExecutable ? { rawHttpNodeExecutable: options.rawHttpNodeExecutable } : {}),
    ...(options.toolImageRasterRuntime ? { toolImageRasterRuntime: options.toolImageRasterRuntime } : {}), onListening: async (port) => {
    const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`;
    if (!config.opencodeBaseUrl && options.manageOpencode) {
      const workspace = config.workspaces[0];
      if (workspace?.path) {
        // Server-managed config file: the engine re-reads it from disk on every
        // instance rebuild, and keepLegalworkRuntimeConfigFileFresh rewrites it
        // on every runtime-DB write — so disposes always pick up current state.
        const runtimeConfigPath = await writeLegalworkRuntimeConfigFile(config, workspace.id);
        stopConfigRefresh = keepLegalworkRuntimeConfigFileFresh(config, workspace.id);
        // Fire-and-forget: refresh the GLOBAL paid manifest's model list around
        // the kept key (no-op when not signed in) with the firm's access token,
        // so the list reflects the admin's on/off choices, then rewrite the
        // engine config so the current models appear across every workspace.
        void ensureFreshPlatformToken(config)
          .catch(() => null)
          .then((platformToken) => refreshEigenweltPaidManifest(config, { platformToken }))
          .then((r) => (r.changed && !stopped ? writeLegalworkRuntimeConfigFile(config, workspace.id) : undefined))
          .catch(() => undefined);
        const cwd = options.opencodeCwd
          || process.env.LEGALWORK_MANAGED_OPENCODE_CWD?.trim()
          || workspace.path;
        await mkdir(cwd, { recursive: true });

        // Private engine DB: never share OpenCode's global opencode.db with a
        // separately installed OpenCode — a newer install migrates it to a
        // schema the pinned sidecar can't open, which kills provider listing,
        // MCP connect, and session create (issue #62). Also exported to
        // process.env so server-side direct DB access (opencode-db.ts) targets
        // the same file the engine writes.
        const managedDb = await prepareManagedOpencodeEngineDb(config);
        if (managedDb) process.env.OPENCODE_DB = managedDb.path;

        managed.catalog = await startModelCatalogRelay(config);
        const engineHome = join(engineStorageDir(config), "engine-home");
        await mkdir(engineHome, { recursive: true });
        const database = managedDb?.path || (process.env.OPENCODE_DB ? resolve(cwd, process.env.OPENCODE_DB) : "");
        if (!database) throw new Error("A private managed engine database is required for native restart recovery.");
        process.env.OPENCODE_DB = database;
        const executablePath = await resolveEngineExecutable(options.opencodeBin?.trim() || process.env.LEGALWORK_OPENCODE_BIN?.trim() || "opencode", options.opencodeCwd || process.env.LEGALWORK_MANAGED_OPENCODE_CWD?.trim() || engineHome, process.env);
        await expectedOpencodeVersion(executablePath, options.opencodeCandidateBuild);
        const service = { configDirectory: orgPolicyEngineDir(config), stateDirectory: join(engineHome, "state"), executablePath };
        const catalog = managed.catalog;
        const dependencies = await prepareManagedOpencodeDependencies(config, options.opencodeSdkDirectory);
        if (dependencies.reason === "bundle-unavailable") console.warn("[legalwork-server] Prepare desktop resources to validate the released engine's bundled runtime declaration.");
        managed.lifecycle = await startManagedEngineLifecycle({ config, database, service, create: async (mode, beforeSpawn) => {
          const engine = await createConfiguredManagedEngine(config, {
          bin: executablePath,
          candidateBuild: options.opencodeCandidateBuild,
          cwd: options.opencodeCwd || process.env.LEGALWORK_MANAGED_OPENCODE_CWD?.trim() || engineHome,
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
            // App-owned discovery root; native guard hooks enforce firm policy.
            OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config),
            OPENCODE_MODELS_URL: catalog.url,
            OPENCODE_MODELS_PATH: catalog.catalogPath,
            OPENCODE_CONFIG_PROJECT_DISABLE: "1",
            OPENCODE_TEST_HOME: engineHome,
            XDG_CONFIG_HOME: join(engineHome, "config"),
            XDG_STATE_HOME: service.stateDirectory,
            OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config),
            OPENCODE_DB: database,
          },
          });
          managed.engine = engine;
          return engine;
        } }).catch(async (error: unknown) => {
          await managed.catalog?.stop();
          throw error;
        });

      }
    }
  } }).catch(async (error: unknown) => {
    stopped = true;
    await stopConfigRefresh?.();
    if (managed.lifecycle) await managed.lifecycle.close(); else await managed.engine?.close();
    await managed.catalog?.stop();
    await cloudSync?.stop();
    throw error;
  });

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    invalidateRawHttpTrust: () => server.invalidateRawHttpTrust(),
    get managedOpencodeExecution() { return managed.engine?.execution ?? null; },
    managedOpencodeStatus: () => managed.engine
      ? { running: managed.engine.running(), pid: managed.engine.pid }
      : null,
    async stop() {
      stopped = true;
      await stopConfigRefresh?.();
      if (managed.lifecycle) await managed.lifecycle.close(); else await managed.engine?.close();
      await server.stop();
      await managed.catalog?.stop();
      if (cloudSync) {
        try { await cloudSync.replica.tick(); }
        finally { await cloudSync.stop(); }
      }
    },
  };
}
