import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import type { NativeConfig } from "./native-opencode-config.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const atomic = (key: string) => ["model", "reasoning", "mcp"].includes(key);
function common(values: unknown[], key = ""): unknown {
  const first = values[0];
  if (!atomic(key) && record(first) && values.every(record)) return Object.fromEntries(Object.keys(first).flatMap(key => {
    const value = common(values.map(item => record(item) ? item[key] : undefined), key);
    return value === undefined ? [] : [[key, value]];
  }));
  return values.length && values.every(value => JSON.stringify(value) === JSON.stringify(first)) ? first : undefined;
}

/** Native loads shared provider/model definitions, including distinct custom
 * models. Only conflicting fields stay in per-location transforms; presence,
 * activation and model selection remain per-location controls. */
export function commonManagedConfiguration(configurations: NativeConfig[]): NativeConfig {
  const result = configurations.length ? common(configurations) : {};
  if (!record(result)) return Schema.decodeUnknownSync(Config.Info)({});
  // The native location-scoped MCP transform owns the complete managed set.
  // A second file-backed source would retain a deleted connector until its
  // asynchronous watcher catches up, after the removal API has returned.
  delete result.mcp;
  const providerIDs = new Set(configurations.flatMap(configuration => Object.keys(configuration.providers ?? {})));
  result.providers = Object.fromEntries([...providerIDs].map(id => {
    const definitions = configurations.flatMap(configuration => configuration.providers?.[id] ? [configuration.providers[id]] : []);
    const provider = common(definitions);
    if (!record(provider)) throw new Error("A managed provider definition must be an object.");
    const modelIDs = new Set(definitions.flatMap(provider => Object.keys(provider.models ?? {})));
    provider.models = Object.fromEntries([...modelIDs].map(modelID => {
      const models = definitions.flatMap(provider => provider.models?.[modelID] ? [provider.models[modelID]] : []);
      const model = common(models);
      if (!record(model)) throw new Error("A managed model definition must be an object.");
      // A late native disabled:false would otherwise undo a location's filter.
      // The managed transform applies every saved enablement before the fold.
      delete model.disabled;
      if (record(model.capabilities) && models.some(value => record(value) && JSON.stringify(value.variants) !== JSON.stringify(record(models[0]) ? models[0].variants : undefined))) {
        // A late shared reasoning fold would erase this location's variants.
        delete model.capabilities.reasoning;
      }
      return [modelID, model];
    }));
    return [id, provider];
  }));
  return Schema.decodeUnknownSync(Config.Info)(result);
}

export function managedConfigurationDiff(configuration: NativeConfig, shared: NativeConfig): NativeConfig {
  const difference = (value: unknown, baseline: unknown, key = ""): unknown => {
    if (JSON.stringify(value) === JSON.stringify(baseline)) return undefined;
    if (!atomic(key) && record(value) && record(baseline)) return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const delta = difference(item, baseline[key], key);
      return delta === undefined ? [] : [[key, delta]];
    }));
    return value;
  };
  return Schema.decodeUnknownSync(Config.Info)(difference(configuration, shared) ?? {});
}
