/**
 * Mapping between the custom-provider form and the engine's provider `models`
 * block, in both directions. Kept pure (no store, no React) so it is testable.
 *
 * The engine requires BOTH `limit.context` and `limit.output` when a `limit`
 * is present. A block with only `context` invalidates the whole runtime config
 * and takes the engine down for every workspace, so `limit` is always written
 * with both keys here.
 */
export const DEFAULT_MODEL_OUTPUT_LIMIT = 16_384;

export type CustomProviderModelFields = {
  id: string;
  toolCall: boolean;
  reasoning: boolean;
  /** Context-window size, or null when the engine default applies. */
  contextLimit: number | null;
  /** Output-token limit read back from an existing block, or null. */
  outputLimit: number | null;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Engine `models.<id>` entry for one form row. `limit` is written only when a
 * context limit is set, and then with both keys: an edited model keeps its
 * stored output limit, a new one gets the default.
 */
export function customProviderModelEntry(
  model: Partial<CustomProviderModelFields> & { id: string; name?: string },
): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: model.name?.trim() || model.id };
  if (model.toolCall !== undefined) entry.tool_call = model.toolCall;
  if (model.reasoning) entry.reasoning = true;
  if (typeof model.contextLimit === "number" && model.contextLimit > 0) {
    const output =
      typeof model.outputLimit === "number" && model.outputLimit > 0
        ? model.outputLimit
        : DEFAULT_MODEL_OUTPUT_LIMIT;
    entry.limit = { context: model.contextLimit, output };
  }
  return entry;
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
