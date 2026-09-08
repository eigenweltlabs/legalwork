/**
 * Self-heal for provider blocks stored in the runtime DB.
 *
 * The engine validates the WHOLE runtime config file: one provider block it
 * cannot parse (e.g. a model `limit` without `output`) fails every engine call
 * with ConfigInvalidError, and because the file is regenerated from the DB on
 * each start the user cannot fix it by hand. A provider LegalWork used to
 * inject and has since retired (the free tier) can also linger in the DB as a
 * stale copy.
 *
 * Both are dropped here: persistently at startup (with a notice the app
 * toasts) and defensively every time the engine config file is built.
 */
import { z } from "zod";
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

// The keys the engine REQUIRES when present (opencode
// packages/core/src/v1/config/provider.ts). Unknown keys pass through.
const modelSchema = z.looseObject({
  name: z.string().optional(),
  tool_call: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  limit: z.looseObject({ context: z.number(), input: z.number().optional(), output: z.number() }).optional(),
  cost: z.looseObject({ input: z.number(), output: z.number() }).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
const providerSchema = z.looseObject({
  npm: z.string().optional(),
  name: z.string().optional(),
  api: z.string().optional(),
  env: z.array(z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  models: z.record(z.string(), modelSchema).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerDisplayName(id: string, block: unknown): string {
  const name = isRecord(block) && typeof block.name === "string" ? block.name.trim() : "";
  return name || id;
}

/** Pure: split a stored provider map into what the engine may see and what must go. */
export function repairRuntimeProviders(
  providers: Record<string, unknown>,
): { providers: Record<string, unknown>; removed: ProviderRepairNotice[] } {
  const kept: Record<string, unknown> = {};
  const removed: ProviderRepairNotice[] = [];
  for (const [id, block] of Object.entries(providers)) {
    if (RETIRED_PROVIDER_IDS.has(id)) {
      removed.push({ providerId: id, name: providerDisplayName(id, block), reason: "retired" });
    } else if (!providerSchema.safeParse(block).success) {
      removed.push({ providerId: id, name: providerDisplayName(id, block), reason: "invalid" });
    } else {
      kept[id] = block;
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
 * Drop retired / unparsable provider blocks from one workspace's runtime-DB
 * row. Writes only when something was removed and records a notice for the
 * app. Safe to run before the engine config file is first built.
 */
export async function repairWorkspaceRuntimeProviders(
  config: ServerConfig,
  workspaceId: string,
): Promise<ProviderRepairNotice[]> {
  const current = await readRuntimeOpencodeConfig(config, workspaceId);
  const { removed } = repairRuntimeProviders(current.provider ?? {});
  if (!removed.length) return [];
  await writeRuntimeOpencodeConfig(config, workspaceId, (latest) => ({
    ...latest,
    provider: repairRuntimeProviders(latest.provider ?? {}).providers,
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
