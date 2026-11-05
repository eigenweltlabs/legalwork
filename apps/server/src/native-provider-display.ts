import { createEngineClient, workspaceEngineLocation } from "./engine-client.js";
import { engineProjectStatus } from "./engine-project.js";
import { findApiError } from "./errors.js";
import type { NativeConfig } from "./native-opencode-config.js";
import type { ConfigEntry } from "@opencode/client";
import type { EngineProjectStatus } from "@legalwork/types/engine-project";
import { orgChatEngineIds } from "./org-policy-ai.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Definitions = NativeConfig["providers"];
export type ProviderDisplayMetadata = Record<string, { hasCustomEndpoint: boolean; editable: boolean }>;
const hasEndpoint = (value: unknown) => typeof value === "string" && value.length > 0;

/** These flags describe ownership and presence only. Managed settings belong
 * to LegalWork; native-project sources require resolved document provenance. */
export async function nativeProviderDisplay(config: ServerConfig, workspace: WorkspaceInfo, definitions: {
  authored: Definitions; owned: Definitions; combined: Definitions;
}, resolved?: { entries: ConfigEntry[]; project: EngineProjectStatus }): Promise<ProviderDisplayMetadata> {
  const firm = new Set(await orgChatEngineIds(config));
  const display = Object.fromEntries(Object.entries(definitions.combined ?? {}).map(([id, provider]) => [id, {
    hasCustomEndpoint: hasEndpoint(provider.settings?.baseURL),
    editable: !firm.has(id) && Object.hasOwn(definitions.owned ?? {}, id) && !Object.hasOwn(definitions.authored ?? {}, id),
  }]));
  if (config.engineConfigurationMode === "managed" || !resolveWorkspaceOpencodeConnection(config, workspace).baseUrl) return display;
  const project = resolved?.project ?? await engineProjectStatus(config, workspace);
  if (project.state !== "ready") return display;
  const entries = resolved?.entries ?? await createEngineClient(config, workspace).config.get({ location: workspaceEngineLocation(workspace) }).catch(error => {
    if (findApiError(error)?.code === "opencode_unavailable") return undefined;
    throw error;
  });
  if (!entries) return display;
  for (const entry of entries) if (entry.type === "document") {
    for (const [id, provider] of Object.entries(entry.info.providers ?? {})) display[id] = {
      hasCustomEndpoint: provider.settings?.baseURL === undefined ? display[id]?.hasCustomEndpoint === true : hasEndpoint(provider.settings.baseURL),
      editable: !firm.has(id) && Object.hasOwn(definitions.owned ?? {}, id) && entry.path !== undefined && entry.path === project.projection.path,
    };
  }
  return display;
}
