/**
 * Token limits LegalWork hands the engine for each model it configures.
 *
 * The engine uses a model's `limit.output` when allocating response tokens and
 * deciding when to compact. Native v2 fits that allowance to the remaining
 * context and applies its own maximum; this module preserves reported limits.
 *
 * The real value belongs to whoever runs the model — the Eigenwelt gateway
 * reports it in the platform manifest, the user types it in for a custom
 * provider — so LegalWork only supplies a default when that source is silent.
 *
 * Shared by the UI and the server. The server imports it through
 * apps/server/src/model-limits.ts, which `build` bundles to plain JS so the
 * packaged app never loads TypeScript from a workspace dependency.
 */

/**
 * Historical v1 response ceiling, retained for compatibility with the legacy
 * helper below. This is not v2's ceiling and does not clamp v2 model settings.
 */
export const ENGINE_OUTPUT_CEILING = 32_000;

/**
 * Output limit only when a model's source reports none. Matches native 2.1.4's
 * unknown-model fallback; reported limits such as 65,536 remain unchanged.
 */
export const DEFAULT_OUTPUT_LIMIT = ENGINE_OUTPUT_CEILING;

/** Context window for a model whose source reports none. */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

export type ModelLimit = { context: number; output: number };

export type ResolvedModelLimit = {
  limit: ModelLimit;
  /** True when the output limit is the default rather than the source's value. */
  outputIsDefault: boolean;
};

/** A positive token count, or null. Sources report 0 for "unknown". */
function tokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

/**
 * The default output limit for a context window: DEFAULT_OUTPUT_LIMIT, but
 * never more than half the window. The engine reserves the output limit out of
 * the context, so on a small-context model the full default would leave no
 * room for the conversation itself.
 */
export function defaultOutputLimit(context: number): number {
  return Math.max(1, Math.min(DEFAULT_OUTPUT_LIMIT, Math.floor(context / 2)));
}

/**
 * The `limit` block to write for a model, from whatever its source reported.
 *
 * Always returns both keys: the engine's config schema requires `context` and
 * `output` together, and a block missing either invalidates the entire
 * runtime config for every workspace.
 *
 * A reported output limit is trusted unless it leaves no room for input (at
 * least the whole context window), which can only be bad data.
 */
export function resolveModelLimit(reported: { context?: unknown; output?: unknown }): ResolvedModelLimit {
  const context = tokenCount(reported.context) ?? DEFAULT_CONTEXT_LIMIT;
  const output = tokenCount(reported.output);
  if (output !== null && output < context) {
    return { limit: { context, output }, outputIsDefault: false };
  }
  return { limit: { context, output: defaultOutputLimit(context) }, outputIsDefault: true };
}

/**
 * Historical v1 response-length calculation, retained for compatibility.
 * Native v2 owns its response allocation; no v2 production caller uses this
 * helper. Use resolveModelLimit to preserve reported model settings.
 */
export function enforcedOutputLimit(configuredOutput: unknown): number {
  const configured = tokenCount(configuredOutput);
  return configured === null ? ENGINE_OUTPUT_CEILING : Math.min(configured, ENGINE_OUTPUT_CEILING);
}
