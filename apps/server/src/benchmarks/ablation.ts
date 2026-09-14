/**
 * Ablation arms — the capability configurations a benchmark run is compared across.
 *
 * A run expands to task × model × arm, so the same task can be scored with and
 * without a capability and the difference read off the leaderboard. Two levers,
 * because the engine delivers capabilities two different ways:
 *
 *   - Tools are addressable by name, so they ride the engine's native per-prompt
 *     `tools` map (the judge already uses it to switch off mutating tools).
 *   - Skills and workflows are BOTH loaded through the single `skill` tool, so
 *     the tools map can only turn all of them off at once. Naming individual
 *     ones needs interception: the benchmark plugin's `tool.execute.before` hook
 *     denies `skill` calls outside the arm's policy (see resolveSkillDecision).
 *
 * This module is imported by the server AND inlined into the benchmark plugin
 * bundle, so it must stay dependency-light and side-effect free.
 */
import { z } from "zod";

/** The engine's single skill-loading tool — the gate for skills and workflows alike. */
export const SKILL_TOOL = "skill";

export const skillPolicySchema = z.discriminatedUnion("mode", [
  /** Every installed skill and workflow stays available (the baseline arm). */
  z.object({ mode: z.literal("all") }),
  /** No skill or workflow can be loaded at all. */
  z.object({ mode: z.literal("none") }),
  /** Only the named skills/workflows load; everything else is denied. */
  z.object({ mode: z.literal("allow"), names: z.array(z.string().trim().min(1)).max(200) }),
  /** Every skill/workflow loads except the named ones. */
  z.object({ mode: z.literal("deny"), names: z.array(z.string().trim().min(1)).max(200) }),
]);

export type BenchmarkSkillPolicy = z.infer<typeof skillPolicySchema>;

export const armConfigSchema = z.object({
  /**
   * Tool id → enabled. Only the listed tools are overridden; anything omitted
   * keeps the engine default, so `{bash: false}` ablates bash and nothing else.
   */
  tools: z.record(z.string().trim().min(1), z.boolean()).optional(),
  skills: skillPolicySchema.optional(),
});

export type BenchmarkArmConfig = z.infer<typeof armConfigSchema>;

export const armSchema = z.object({
  /** Stable within a run; generated from the label when the caller omits it. */
  id: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(80),
  config: armConfigSchema.optional(),
});

export type BenchmarkArmInput = z.infer<typeof armSchema>;

export type BenchmarkArm = {
  id: string;
  label: string;
  config: BenchmarkArmConfig;
};

/** The arm every pre-ablation run implicitly had: nothing switched off. */
export const BASELINE_ARM: BenchmarkArm = { id: "full", label: "Full", config: {} };

export function normalizeSkillPolicy(policy: BenchmarkSkillPolicy | undefined): BenchmarkSkillPolicy {
  if (!policy) return { mode: "all" };
  // An empty name list makes allow/deny degenerate; collapse rather than carry
  // a policy that reads as a restriction but blocks nothing (or everything).
  if (policy.mode === "allow" && !policy.names.length) return { mode: "none" };
  if (policy.mode === "deny" && !policy.names.length) return { mode: "all" };
  return policy;
}

/** Skill names compare case-insensitively; the engine matches directory names. */
function sameSkill(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type SkillDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether one skill/workflow may load under an arm. Shared by the server (for
 * validation) and the plugin (for enforcement) so the two can never disagree.
 */
export function resolveSkillDecision(
  policy: BenchmarkSkillPolicy | undefined,
  skillName: string,
): SkillDecision {
  const normalized = normalizeSkillPolicy(policy);
  const name = skillName.trim();
  switch (normalized.mode) {
    case "all":
      return { allowed: true };
    case "none":
      return {
        allowed: false,
        reason: "Skills and workflows are switched off for this benchmark arm. Complete the task using your own reasoning and the tools you still have.",
      };
    case "allow":
      return normalized.names.some((entry) => sameSkill(entry, name))
        ? { allowed: true }
        : {
            allowed: false,
            reason: `The skill "${name}" is switched off for this benchmark arm. Available: ${normalized.names.join(", ")}.`,
          };
    case "deny":
      return normalized.names.some((entry) => sameSkill(entry, name))
        ? {
            allowed: false,
            reason: `The skill "${name}" is switched off for this benchmark arm. Complete the task without it.`,
          }
        : { allowed: true };
  }
}

/**
 * The engine `tools` map for an arm.
 *
 * `skills: none` folds into it as `skill: false`, which blocks every skill and
 * workflow at the engine boundary — no plugin round-trip needed. Named policies
 * cannot be expressed here (one tool, many skills) and are left to the plugin.
 */
export function resolveToolOverrides(config: BenchmarkArmConfig): Record<string, boolean> | undefined {
  const tools: Record<string, boolean> = { ...(config.tools ?? {}) };
  if (normalizeSkillPolicy(config.skills).mode === "none") tools[SKILL_TOOL] = false;
  return Object.keys(tools).length ? tools : undefined;
}

/** True when enforcing this arm needs the plugin (i.e. a named skill policy). */
export function needsSkillInterception(config: BenchmarkArmConfig): boolean {
  const mode = normalizeSkillPolicy(config.skills).mode;
  return mode === "allow" || mode === "deny";
}

/**
 * A one-line note for the agent's system prompt so the model does not burn
 * turns reaching for a capability the arm has taken away. Enforcement is still
 * the plugin's job — this only saves wasted attempts.
 */
export function describeArmRestrictions(config: BenchmarkArmConfig): string | null {
  const parts: string[] = [];
  const disabledTools = Object.entries(config.tools ?? {})
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name);
  if (disabledTools.length) parts.push(`these tools are unavailable: ${disabledTools.join(", ")}`);

  const skills = normalizeSkillPolicy(config.skills);
  if (skills.mode === "none") {
    parts.push("no skills or workflows can be loaded");
  } else if (skills.mode === "allow") {
    parts.push(`the only loadable skills/workflows are: ${skills.names.join(", ")}`);
  } else if (skills.mode === "deny") {
    parts.push(`these skills/workflows are unavailable: ${skills.names.join(", ")}`);
  }

  if (!parts.length) return null;
  return `This session runs under a benchmark ablation arm: ${parts.join("; ")}. Do not attempt to use them; complete the task with what remains.`;
}

/** Slug an arm label into a stable id, de-duplicated against ids already taken. */
export function armIdFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "arm";
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Parse an arm config JSON blob from the DB, falling back to no restrictions. */
export function parseArmConfig(json: string | null | undefined): BenchmarkArmConfig {
  if (!json) return {};
  try {
    const parsed = armConfigSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
