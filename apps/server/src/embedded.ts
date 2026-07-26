/**
 * Single entry point for embedding the LegalWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 */
import { mkdir } from "node:fs/promises";
import { resolveServerConfig, type CliArgs } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer, type OpencodeExecutionSnapshot } from "./managed-opencode.js";
import { startServer, syncAllWorkspacesRuntimeMcpToEngine } from "./server.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";
import { keepLegalworkRuntimeConfigFileFresh, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { prepareManagedOpencodeEngineDb } from "./managed-opencode-db.js";
import { readCachedEigenweltFreeManifest, refreshEigenweltFreeManifest } from "./eigenwelt-free.js";
import { refreshEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import type { ServeResult } from "./serve-node.js";
import type { ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Path to the OpenCode binary. Falls back to LEGALWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
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
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  config.pickDirectory = options.pickDirectory ?? null;
  config.recorder = options.recorder ?? null;
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  // No trailing slash: the engine appends "/api.json" to this value, so a
  // trailing slash produces the malformed "https://…com//api.json" seen in
  // user-reported engine logs.
  const opencodeModelsUrl = process.env.LEGALWORK_DEV_MODE === "1"
    ? "http://localhost:8791/models"
    : "https://models.eigenweltlabs.com";

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  let managedOpencode: ManagedOpencodeServer | null = null;

  if (!config.readOnly) {
    for (const workspace of config.workspaces) {
      await ensureWorkspaceFiles(workspace.path, workspace.preset ?? "starter");
    }
  }

  if (!config.opencodeBaseUrl && options.manageOpencode) {
    const workspace = config.workspaces[0];
    if (workspace?.path) {
      // Refresh the free-tier manifest disk cache. On a FRESH install the cache
      // is empty, so if we wrote the engine config before the mint landed the
      // engine would boot with zen and no free provider — the free tier (and
      // zen's removal) would only appear after a later instance rebuild. So when
      // nothing is cached yet, wait for this first mint (bounded, so a slow or
      // unreachable platform never blocks startup) BEFORE writing the config, so
      // a first launch comes up with the free provider already present. When a
      // cache already exists we don't wait — the config below is written from it
      // immediately and the refresh only updates models in the background.
      const freeManifestRefresh = refreshEigenweltFreeManifest(config).catch(() => false);
      if (!(await readCachedEigenweltFreeManifest(config))) {
        await Promise.race([
          freeManifestRefresh,
          new Promise((resolve) => setTimeout(resolve, 8_000)),
        ]);
      }

      // Server-managed config file: the engine re-reads it from disk on every
      // instance rebuild, and keepLegalworkRuntimeConfigFileFresh rewrites it
      // on every runtime-DB write — so disposes always pick up current state.
      const runtimeConfigPath = await writeLegalworkRuntimeConfigFile(config, workspace.id);
      keepLegalworkRuntimeConfigFileFresh(config, workspace.id);
      // Whenever the refresh actually lands new data — including the case where
      // the bounded wait above timed out and it finished afterwards — rewrite the
      // engine config file so the free provider (and the zen disable that rides
      // on it) update on the next instance rebuild.
      void freeManifestRefresh
        .then((changed) => (changed ? writeLegalworkRuntimeConfigFile(config, workspace.id) : undefined))
        .catch(() => undefined);
      // Fire-and-forget: refresh the GLOBAL paid manifest's model list around
      // the kept key (no-op when not signed in), then rewrite the engine config
      // so newly-available models appear across every workspace.
      void refreshEigenweltPaidManifest(config)
        .then((r) => (r.changed ? writeLegalworkRuntimeConfigFile(config, workspace.id) : undefined))
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

      managedOpencode = await createManagedOpencodeServer({
        bin: options.opencodeBin || process.env.LEGALWORK_OPENCODE_BIN,
        cwd,
        excludedPorts: [config.port],
        env: {
          ...(process.env.LEGALWORK_DEV_MODE ? { LEGALWORK_DEV_MODE: process.env.LEGALWORK_DEV_MODE } : {}),
          ...(process.env.LEGALWORK_UI_CONTROL_DISCOVERY ? { LEGALWORK_UI_CONTROL_DISCOVERY: process.env.LEGALWORK_UI_CONTROL_DISCOVERY } : {}),
          LEGALWORK_SERVER_URL: serverUrl,
          LEGALWORK_SERVER_TOKEN: config.token,
          OPENCODE_CONFIG: runtimeConfigPath,
          OPENCODE_MODELS_URL: opencodeModelsUrl,
          ...(managedDb ? { OPENCODE_DB: managedDb.path } : {}),
        },
      });

      config.opencodeBaseUrl = managedOpencode.url;
      config.opencodeUsername = managedOpencode.username;
      config.opencodePassword = managedOpencode.password;
      for (const entry of config.workspaces) {
        if (entry.workspaceType === "remote") {
          entry.baseUrl ??= managedOpencode.url;
          entry.opencodeUsername ??= managedOpencode.username;
          entry.opencodePassword ??= managedOpencode.password;
          entry.directory ??= entry.path;
          continue;
        }
        entry.baseUrl = managedOpencode.url;
        entry.opencodeUsername = managedOpencode.username;
        entry.opencodePassword = managedOpencode.password;
        entry.directory = entry.path;
      }
    }
  }

  const server = await startServer(config);

  // The runtime config file above only covers workspaces[0]. Push every
  // workspace's runtime-DB MCPs into the engine so they aren't invisible
  // until a manual reload. Best-effort.
  if (managedOpencode) {
    void syncAllWorkspacesRuntimeMcpToEngine(config);
  }

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    managedOpencodeExecution: managedOpencode?.execution ?? null,
    async stop() {
      await managedOpencode?.close();
      await server.stop();
    },
  };
}
