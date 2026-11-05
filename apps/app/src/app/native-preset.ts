function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

export function presetConfiguration(payload: Record<string, unknown>, connected: Record<string, { hasCustomEndpoint: boolean }> = {}) {
  if (payload.$legalworkReadOnlyProjection === true) throw new Error("A read-only connection view cannot be applied as a preset.");
  const configuration = Object.fromEntries(["provider", "providers", "model", "small_model"].filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
  const providers = record(configuration.providers), setup = record(payload.providerSetup);
  const requiresSetup: string[] = [];
  for (const [id, required] of Object.entries(setup)) {
    if (required !== true || connected[id]?.hasCustomEndpoint || !Object.hasOwn(providers, id)) continue;
    const provider = record(providers[id]);
    providers[id] = { ...provider, models: Object.fromEntries(Object.entries(record(provider.models)).map(([id, model]) => [id, { ...record(model), disabled: true }])) };
    requiresSetup.push(id);
  }
  return { configuration: { ...configuration, ...(Object.hasOwn(configuration, "providers") ? { providers } : {}) }, requiresSetup };
}
