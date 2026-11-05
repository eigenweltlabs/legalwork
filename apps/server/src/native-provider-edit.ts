import { nativeProvider } from "./native-opencode-config.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** An omitted private field means keep it. JSON null explicitly removes it. */
function mergeFields(previous: unknown, patch: unknown): Record<string, unknown> {
  const result = record(previous);
  for (const [name, value] of Object.entries(record(patch))) {
    if (value === null) delete result[name];
    else if (value && typeof value === "object" && !Array.isArray(value)) result[name] = mergeFields(result[name], value);
    else result[name] = value;
  }
  return result;
}

function mergeModel(previous: unknown, patch: unknown) {
  const old = record(previous), next = record(patch), result = mergeFields(old, next);
  if (Array.isArray(next.variants)) {
    const variants = Array.isArray(old.variants) ? old.variants : [];
    result.variants = next.variants.map(value => {
      const variant = record(value);
      return mergeFields(variants.find(value => record(value).id === variant.id), variant);
    });
  }
  return result;
}

/** A model inventory is explicit, while unchanged models retain private
 * transport settings that the public edit view deliberately cannot return. */
export function mergePrivateProviderEdits(previous: unknown, updates: Record<string, unknown>) {
  const result = record(previous);
  for (const [id, update] of Object.entries(updates)) {
    if (update === null) { delete result[id]; continue; }
    const old = nativeProvider(result[id]), patch = record(update), provider = mergeFields(old, patch);
    if (Object.hasOwn(patch, "models") && patch.models !== null) {
      const models = record(old.models);
      provider.models = Object.fromEntries(Object.entries(record(patch.models)).filter(([, value]) => value !== null).map(([id, value]) => [id, mergeModel(models[id], value)]));
    }
    result[id] = provider;
  }
  return result;
}
