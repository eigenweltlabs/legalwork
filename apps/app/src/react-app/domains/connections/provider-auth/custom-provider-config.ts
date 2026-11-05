/** Native model overrides preserve the user's explicit limits. Unset limits inherit engine capacity. */
export type CustomProviderModelFields = {
  id: string;
  name?: string;
  toolCall: boolean;
  reasoning: boolean;
  /** Context-window size, or null when the engine default applies. */
  contextLimit: number | null;
  /** Longest single response in tokens, or null when the default applies. */
  outputLimit: number | null;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serialize one native model override without inventing token limits. */
export function customProviderModelEntry(
  model: Partial<CustomProviderModelFields> & { id: string },
): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: model.name?.trim() || model.id };
  if (model.toolCall !== undefined || model.reasoning !== undefined) entry.capabilities = {
    ...(model.toolCall === undefined ? {} : { tools: model.toolCall }),
    ...(model.reasoning === undefined ? {} : { reasoning: { supported: model.reasoning } }),
  };
  const limit = {
    ...(typeof model.contextLimit === "number" && model.contextLimit > 0 ? { context: model.contextLimit } : {}),
    ...(typeof model.outputLimit === "number" && model.outputLimit > 0 ? { output: model.outputLimit } : {}),
  };
  if (Object.keys(limit).length) entry.limit = limit;
  return entry;
}

export type CustomModelLimitProblem = {
  modelId: string;
  /** An output limit at least as large as the context leaves no room for input. */
  reason: "output-not-below-context";
};

/**
 * The first model whose limits cannot be saved as typed, or null. Checked
 * before saving so the form can say what is wrong rather than quietly
 * replacing the value with a default.
 */
export function findCustomModelLimitProblem(
  models: ReadonlyArray<Pick<CustomProviderModelFields, "id" | "contextLimit" | "outputLimit">>,
): CustomModelLimitProblem | null {
  for (const model of models) {
    if (model.outputLimit === null) continue;
    if (model.contextLimit !== null && model.outputLimit >= model.contextLimit) return { modelId: model.id, reason: "output-not-below-context" };
  }
  return null;
}

/** Form row for one stored `models.<id>` entry (inverse of customProviderModelEntry). */
export function customProviderModelFromEntry(id: string, raw: unknown): CustomProviderModelFields {
  const model = isPlainRecord(raw) ? raw : {};
  const limit = isPlainRecord(model.limit) ? model.limit : {};
  return {
    id,
    ...(typeof model.name === "string" && model.name.trim() && model.name.trim() !== id ? { name: model.name.trim() } : {}),
    toolCall: isPlainRecord(model.capabilities) && typeof model.capabilities.tools === "boolean" ? model.capabilities.tools : true,
    reasoning: isPlainRecord(model.capabilities) && isPlainRecord(model.capabilities.reasoning) ? model.capabilities.reasoning.supported === true : false,
    contextLimit: typeof limit.context === "number" ? limit.context : null,
    outputLimit: typeof limit.output === "number" ? limit.output : null,
  };
}

/** Keep edits for offered models and remove IDs no longer in the endpoint inventory. */
export function replaceDiscoveredModels<T extends { id: string }>(
  current: readonly T[],
  ids: readonly string[],
  create: (id: string) => T,
): T[] {
  return ids.map((id) => current.find((model) => model.id === id) ?? create(id));
}
