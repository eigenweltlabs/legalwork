import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { opencodeConfigPaths } from "./workspace-files.js";
import { Config } from "@opencode/schema/config";
import type { ConfigEntry } from "@opencode/client";
import { Schema } from "effect";
import { createEngineClient, workspaceEngineLocation } from "./engine-client.js";
import { engineProjectStatus } from "./engine-project.js";
import { findApiError } from "./errors.js";
import { publicNativeConfig } from "./native-client-projection.js";
import { runtimeEngineConfiguration, type NativeRuntimeConfiguration as NativeConfig } from "./runtime-config-upgrade.js";
import { nativeProviderDisplay } from "./native-provider-display.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import type { RuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overlay(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const previous = target[key];
    if (isRecord(previous) && isRecord(value)) overlay(previous, value);
    else target[key] = structuredClone(value);
  }
}

/** A settings display projection, not a replacement for native config loading
 * or its runtime catalogs. Saved app settings remain available while offline. */
function projectDocuments(documents: ReadonlyArray<typeof Config.Info.Type>): NativeConfig {
  const result: Record<string, unknown> = {};
  for (const info of documents) overlay(result, info);
  // The native policy domain gives earlier documents higher authority.
  result.policies = [...documents].reverse().flatMap(info => info.policies ?? []);
  return Schema.decodeUnknownSync(Config.Info)(result);
}

/** Discover names for offline diagnostics without parsing or expanding files.
 * Native OpenCode remains responsible for loading their actual contents. */
async function projectConfigPaths(directory: string, generated: string | undefined) {
  const paths: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    for (const path of opencodeConfigPaths(current)) {
      if (path === generated) continue;
      const info = await stat(path).catch(error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info?.isFile()) paths.push(path);
    }
    if (dirname(current) === current) return paths;
  }
}

/** The native loader alone resolves and validates authored documents. */
export async function readNativeWorkspaceConfig(config: ServerConfig, workspace: WorkspaceInfo, owned: RuntimeOpencodeConfig, sourcePaths: string[] = []) {
  const saved = runtimeEngineConfiguration(owned);
  const project = await engineProjectStatus(config, workspace);
  const paths = await projectConfigPaths(project.directory, project.projection.path);
  let status: "resolved" | "approval_required" | "configuration_conflict" | "unavailable" = project.state === "ready" ? "unavailable" : project.state;
  let projected = saved;
  let entries: ConfigEntry[] | undefined;
  if (project.state === "ready" && resolveWorkspaceOpencodeConnection(config, workspace).baseUrl) {
    try {
      entries = await createEngineClient(config, workspace).config.get({ location: workspaceEngineLocation(workspace) });
      const decoded = Schema.decodeUnknownSync(Config.Entry.pipe(Schema.Array))(entries);
      const documents = decoded.flatMap(entry => entry.type === "document" ? [entry.info] : []);
      // Native documents own the configuration; runtime catalogs remain the
      // authority for models, agents and connector availability.
      projected = projectDocuments(documents);
      status = "resolved";
    } catch (error) {
      if (findApiError(error)?.code !== "opencode_unavailable") throw error;
    }
  }
  const providerDisplay = await nativeProviderDisplay(config, workspace, { authored: undefined, owned: saved.providers, combined: projected.providers },
    { entries: entries ?? [], project });
  // Without native provenance, a saved ID alone cannot establish that its
  // effective definition belongs to the app rather than an authored override.
  if (status !== "resolved") for (const metadata of Object.values(providerDisplay)) metadata.editable = false;
  const sourceConfigs = Object.fromEntries(sourcePaths.map(path => {
    const documents = (entries ?? []).flatMap(entry => entry.type === "document" && entry.path === path && path !== project.projection.path ? [entry.info] : []);
    return [path, { status: status === "resolved" ? documents.length ? "resolved" : "not_loaded" : status,
      config: { ...publicNativeConfig(projectDocuments(Schema.decodeUnknownSync(Config.Info.pipe(Schema.Array))(documents))), $legalworkReadOnlyProjection: true } }];
  }));
  return {
    opencode: { ...publicNativeConfig(projected), $legalworkReadOnlyProjection: true },
    providerDisplay,
    authoredConfig: { status, paths },
    sourceConfigs,
  };
}
