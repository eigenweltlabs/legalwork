export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelReasoningConfig = { efforts: ReasoningEffort[]; defaultEffort?: ReasoningEffort };
const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function isEffort(value: unknown): value is ReasoningEffort {
  return EFFORTS.some((effort) => effort === value);
}

/** Absent is the old manifest contract; malformed new controls fail closed. */
export function parseModelReasoningConfig(value: unknown): ModelReasoningConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("efforts" in value) || !Array.isArray(value.efforts)) {
    return { efforts: [] };
  }
  const efforts = [...new Set(value.efforts.filter(isEffort))];
  const defaultEffort = "defaultEffort" in value && isEffort(value.defaultEffort) && efforts.includes(value.defaultEffort)
    ? value.defaultEffort : undefined;
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) };
}

/** OpenCode merges configured variants into inferred ones. Disable every
 * unsupported inferred effort explicitly, including on built-in models. */
export function modelReasoningOptions(value: unknown) {
  const config = parseModelReasoningConfig(value);
  if (!config) return {};
  return {
    variants: Object.fromEntries(EFFORTS.map((effort) => [
      effort,
      config.efforts.includes(effort) ? { reasoningEffort: effort } : { disabled: true },
    ])),
    ...(config.defaultEffort ? { options: { reasoningEffort: config.defaultEffort } } : {}),
  };
}
