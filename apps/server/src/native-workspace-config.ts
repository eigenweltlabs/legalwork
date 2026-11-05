import { Config } from "@opencode/schema/config";
import type { ConfigEntry } from "@opencode/client";
import { Schema } from "effect";
import { createEngineClient, workspaceEngineLocation } from "./engine-client.js";
import { engineProjectStatus } from "./engine-project.js";
import { findApiError } from "./errors.js";
import { publicNativeConfig } from "./native-client-projection.js";
import { nativeOpencodeConfig, type NativeConfig } from "./native-opencode-config.js";
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
 * or its transformed runtime catalogs. Managed views also include app settings. */
function projectDocuments(documents: ReadonlyArray<typeof Config.Info.Type>): NativeConfig {
  const result: Record<string, unknown> = {};
  for (const info of documents) overlay(result, info);
  // The native policy domain gives earlier documents higher authority.
  result.policies = [...documents].reverse().flatMap(info => info.policies ?? []);
  return Schema.decodeUnknownSync(Config.Info)(result);
}

/** Reading saved settings must not expand authored file/env references before
 * approval. The native loader alone resolves and validates authored documents. */
export async function readNativeWorkspaceConfig(config: ServerConfig, workspace: WorkspaceInfo, owned: RuntimeOpencodeConfig, sourcePaths: string[] = []) {
  const saved = nativeOpencodeConfig(owned).config;
  const managed = config.engineConfigurationMode === "managed";
  const project = await engineProjectStatus(config, workspace);
  const paths = [...new Set((managed ? [] : project.approvalScope).flatMap(scope => scope.configPaths))]
    .filter(path => /\.jsonc?$/.test(path) && path !== project.projection.path);
  let status: "resolved" | "approval_required" | "configuration_conflict" | "unavailable" = project.state === "ready" ? "unavailable" : project.state;
  let projected = saved;
  let entries: ConfigEntry[] | undefined;
  if (project.state === "ready" && resolveWorkspaceOpencodeConnection(config, workspace).baseUrl) {
    try {
      entries = await createEngineClient(config, workspace).config.get({ location: workspaceEngineLocation(workspace) });
      const decoded = Schema.decodeUnknownSync(Config.Entry.pipe(Schema.Array))(entries);
      const documents = decoded.flatMap(entry => entry.type === "document" ? [entry.info] : []);
      // Managed domain transforms do not create native configuration documents.
      // Show saved app settings alongside shared documents; catalogs remain the
      // authority for transformed models, agents and connector availability.
      projected = projectDocuments(managed ? [...documents, saved] : documents);
      status = "resolved";
    } catch (error) {
      if (findApiError(error)?.code !== "opencode_unavailable") throw error;
    }
  }
  const providerDisplay = await nativeProviderDisplay(config, workspace, { authored: undefined, owned: saved.providers, combined: projected.providers },
    { entries: entries ?? [], project });
  // Without native provenance, a saved ID alone cannot establish that its
  // effective definition belongs to the app rather than an authored override.
  if (status !== "resolved" && !managed) for (const metadata of Object.values(providerDisplay)) metadata.editable = false;
  const sourceConfigs = Object.fromEntries(sourcePaths.map(path => {
    const documents = (entries ?? []).flatMap(entry => entry.type === "document" && entry.path === path && path !== project.projection.path ? [entry.info] : []);
    return [path, { status: managed ? "not_loaded" : status === "resolved" ? documents.length ? "resolved" : "not_loaded" : status,
      config: { ...publicNativeConfig(projectDocuments(Schema.decodeUnknownSync(Config.Info.pipe(Schema.Array))(documents))), $legalworkReadOnlyProjection: true } }];
  }));
  return {
    opencode: { ...publicNativeConfig(projected), $legalworkReadOnlyProjection: true },
    providerDisplay,
    authoredConfig: { status, paths },
    sourceConfigs,
  };
}
