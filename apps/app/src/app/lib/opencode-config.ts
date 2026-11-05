import type { ConfigEntry } from "@opencode/client";
import type { Client } from "../types";

export type NativeConfigDocument = Extract<ConfigEntry, { type: "document" }>["info"];

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

/** Read-only document projection for settings. Native catalogs own effective runtime availability. */
export function resolveConfigDocuments(entries: ConfigEntry[]): NativeConfigDocument {
  const result: NativeConfigDocument = {};
  // The native API guarantees discovery order from lowest to highest priority.
  const documents = entries.filter(entry => entry.type === "document");
  for (const entry of documents) overlay(result, entry.info);
  // Native policy precedence is deliberately reversed: user-global outranks
  // project policy. Console-managed statements are applied by the engine later.
  const policies = documents.toReversed().flatMap(entry => entry.info.policies ?? []);
  if (policies.length) result.policies = policies;
  return result;
}

export async function readConfig(client: Client, directory?: string): Promise<NativeConfigDocument> {
  return resolveConfigDocuments(await client.config.get({ location: directory ? { directory } : undefined }));
}

/** Settings index of explicit provider choices; the engine remains policy authority. */
export function disabledProvidersFromConfig(config: NativeConfigDocument): string[] {
  const explicit = new Map<string, boolean>();
  for (const policy of config.policies ?? []) {
    if (policy.action !== "provider.use" || /[?*]/.test(policy.resource)) continue;
    explicit.set(policy.resource, policy.effect === "deny");
  }
  return [...explicit].flatMap(([id, disabled]) => disabled ? [id] : []);
}
