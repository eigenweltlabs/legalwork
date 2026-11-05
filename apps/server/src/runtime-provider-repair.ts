/** Validate native provider definitions without discarding a user's connection.
 * The retired LegalWork-owned free tier remains the only removable provider.
 * Legacy records are handled by the versioned upgrade, before normal runtime.
 */
import { ConfigProvider } from "@opencode/schema/config/provider";
import { Schema } from "effect";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/** Provider ids LegalWork once injected and has since retired. */
export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set(["eigenwelt-free"]);

export type ProviderRepairNotice = {
  providerId: string;
  /** Display name from the block, falling back to the id. */
  name: string;
  reason: "retired" | "invalid";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerDisplayName(id: string, block: unknown): string {
  const name = isRecord(block) && typeof block.name === "string" ? block.name.trim() : "";
  return name || id;
}

/** Validate native definitions and remove only the retired app-owned provider. */
export function repairRuntimeProviders(
  providers: Record<string, unknown>,
): { providers: Record<string, typeof ConfigProvider.Info.Type>; removed: ProviderRepairNotice[] } {
  const kept: Record<string, typeof ConfigProvider.Info.Type> = {};
  const removed: ProviderRepairNotice[] = [];
  for (const [id, block] of Object.entries(providers)) {
    if (RETIRED_PROVIDER_IDS.has(id)) {
      removed.push({ providerId: id, name: providerDisplayName(id, block), reason: "retired" });
    } else {
      try { kept[id] = Schema.decodeUnknownSync(ConfigProvider.Info)(block, { onExcessProperty: "error" }); }
      catch { throw new Error(`Saved provider "${id}" has invalid native settings. Correct or restore it; LegalWork has not removed the connection.`); }
    }
  }
  return { providers: kept, removed };
}

const noticesByWorkspace = new Map<string, ProviderRepairNotice[]>();

/** Providers dropped from a workspace's stored config since this server started. */
export function providerRepairNotices(workspaceId: string): ProviderRepairNotice[] {
  return noticesByWorkspace.get(workspaceId) ?? [];
}

export function resetProviderRepairNoticesForTests(): void {
  noticesByWorkspace.clear();
}

/**
 * Drop the retired provider from one workspace's native runtime-DB
 * row. Writes only when something was removed and records a notice for the
 * app. Safe to run before the engine config file is first built.
 */
export async function repairWorkspaceRuntimeProviders(
  config: ServerConfig,
  workspaceId: string,
): Promise<ProviderRepairNotice[]> {
  const current = await readRuntimeOpencodeConfig(config, workspaceId);
  const { removed } = repairRuntimeProviders(current.providers ?? {});
  if (!removed.length) return [];
  await writeRuntimeOpencodeConfig(config, workspaceId, (latest) => ({
    ...latest,
    providers: repairRuntimeProviders(latest.providers ?? {}).providers,
  }));
  noticesByWorkspace.set(workspaceId, [...providerRepairNotices(workspaceId), ...removed]);
  return removed;
}

/** Startup pass over every hosted workspace. Never throws. */
export async function repairAllWorkspaceRuntimeProviders(config: ServerConfig): Promise<void> {
  if (config.readOnly) return;
  for (const workspace of config.workspaces) {
    try {
      for (const notice of await repairWorkspaceRuntimeProviders(config, workspace.id)) {
        console.warn(`Removed provider "${notice.providerId}" from workspace ${workspace.id} (${notice.reason}).`);
      }
    } catch (error) {
      console.warn(
        `Provider repair failed for workspace ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
