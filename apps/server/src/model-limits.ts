// Bundled to plain JS by `build`, so packaged Electron never loads TypeScript
// from a workspace dependency. UI and server still share one limit rule.
export {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_OUTPUT_LIMIT,
  ENGINE_OUTPUT_CEILING,
  defaultOutputLimit,
  enforcedOutputLimit,
  resolveModelLimit,
} from "@legalwork/types/model-limits";
export type { ModelLimit, ResolvedModelLimit } from "@legalwork/types/model-limits";
