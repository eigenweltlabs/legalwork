/**
 * Mapping between the custom-provider form and the engine's provider `models`
 * block, in both directions. Kept pure (no store, no React) so it is testable.
 *
 * The engine requires BOTH `limit.context` and `limit.output` when a `limit`
 * is present. A block with only `context` invalidates the whole runtime config
 * and takes the engine down for every workspace, so `limit` is always written
 * with both keys here — via resolveModelLimit, the same rule the server uses
 * for Eigenwelt models.
 */
import { resolveModelLimit } from "@legalwork/types/model-limits";

export type CustomProviderModelFields = {
  id: string;
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

/**
 * Engine `models.<id>` entry for one form row. `limit` is written only when a
 * context limit is set, and then with both keys: the output limit the user
 * gave, or the default for that context window.
 */
export function customProviderModelEntry(
  model: Partial<CustomProviderModelFields> & { id: string; name?: string },
): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: model.name?.trim() || model.id };
  if (model.toolCall !== undefined) entry.tool_call = model.toolCall;
  if (model.reasoning) entry.reasoning = true;
  if (typeof model.contextLimit === "number" && model.contextLimit > 0) {
    entry.limit = resolveModelLimit({ context: model.contextLimit, output: model.outputLimit }).limit;
  }
  return entry;
}

export type CustomModelLimitProblem = {
  modelId: string;
  /**
   * output-needs-context: an output limit only reaches the engine inside a
   * `limit` block, which needs the context window too.
   * output-not-below-context: an output limit at least as large as the window
   * leaves no room for input, so the engine could not use it.
   */
  reason: "output-needs-context" | "output-not-below-context";
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
    if (model.contextLimit === null) return { modelId: model.id, reason: "output-needs-context" };
    if (model.outputLimit >= model.contextLimit) return { modelId: model.id, reason: "output-not-below-context" };
  }
  return null;
}

/** Form row for one stored `models.<id>` entry (inverse of customProviderModelEntry). */
export function customProviderModelFromEntry(id: string, raw: unknown): CustomProviderModelFields {
  const model = isPlainRecord(raw) ? raw : {};
  const limit = isPlainRecord(model.limit) ? model.limit : {};
  return {
    id,
    toolCall: typeof model.tool_call === "boolean" ? model.tool_call : true,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : false,
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
