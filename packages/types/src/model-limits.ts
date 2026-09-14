/**
 * Token limits LegalWork hands the engine for each model it configures.
 *
 * The engine uses a model's `limit.output` twice: as the cap on a single
 * response (its maxOutputTokens), and as room it reserves out of the context
 * window when deciding when to compact. When one response needs more than the
 * cap, it is cut off with `finish: length` and whatever it was writing is lost.
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
 * The engine's own ceiling on a single response, applied to every model on top
 * of its `limit.output`: it sends min(limit.output, ceiling). Mirrors
 * OUTPUT_TOKEN_MAX in the pinned engine (v1.18.29), which the
 * OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX env var would override — LegalWork
 * does not set it.
 */
export const ENGINE_OUTPUT_CEILING = 32_000;

/**
 * Output limit for a model whose source reports none. Equal to the engine
 * ceiling, so a model nobody described behaves the same whether it came
 * through Eigenwelt, a custom provider, or neither.
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
 * The response length the engine actually enforces for a configured
 * `limit.output` — the configured value, but never above the engine ceiling
 * (and the ceiling itself when nothing is configured).
 */
export function enforcedOutputLimit(configuredOutput: unknown): number {
  const configured = tokenCount(configuredOutput);
  return configured === null ? ENGINE_OUTPUT_CEILING : Math.min(configured, ENGINE_OUTPUT_CEILING);
}
