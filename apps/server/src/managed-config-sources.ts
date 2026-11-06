import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import type { NativeRuntimeConfiguration } from "./runtime-config-upgrade.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const declarations = new Set(["providers", "agents", "commands"]);

/** Share complete identical native declarations only. Project permission
 * grants and custom plugins stay project-scoped, even with one project. */
export function commonManagedConfiguration(configurations: readonly NativeRuntimeConfiguration[]): NativeRuntimeConfiguration {
  const first = configurations[0];
  if (!first) return {};
  const result: Record<string, unknown> = {};
  const documents: readonly Record<string, unknown>[] = configurations;
  for (const [key, value] of Object.entries(first)) {
    if (key === "permissions" || key === "plugins") continue;
    if (declarations.has(key) && record(value)) {
      const shared = Object.fromEntries(Object.entries(value).filter(([id, entry]) => documents.every(document => record(document[key]) && same(document[key][id], entry))));
      if (Object.keys(shared).length) result[key] = shared;
    } else if (documents.every(document => same(document[key], value))) result[key] = value;
  }
  return Schema.decodeUnknownSync(Config.Info)(result, { onExcessProperty: "error" });
}

/** Generation-time document selection. The native engine loads and merges the
 * resulting project file; no per-location runtime reconstruction is involved. */
export function managedConfigurationDiff(configuration: NativeRuntimeConfiguration, shared: NativeRuntimeConfiguration): NativeRuntimeConfiguration {
  const baseline: Record<string, unknown> = shared;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configuration)) {
    if (same(value, baseline[key])) continue;
    if (declarations.has(key) && record(value) && record(baseline[key])) {
      const common = baseline[key];
      const local = Object.fromEntries(Object.entries(value).filter(([id, entry]) => !same(entry, common[id])));
      if (Object.keys(local).length) result[key] = local;
    } else result[key] = value;
  }
  return Schema.decodeUnknownSync(Config.Info)(result, { onExcessProperty: "error" });
}
