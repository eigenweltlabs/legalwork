/**
 * Prompt builders and verdict parsing for the benchmark pipeline.
 *
 * Judging is batched: one judge session per task×model item receives the
 * deliverable content once plus every rubric criterion, and returns a JSON
 * array with one independent pass/fail verdict per criterion. Task scoring is
 * binary all-pass (Harvey's methodology).
 */
import type { BenchmarkTaskDefinition } from "./task-schema.js";
import type { CollectedDeliverable } from "./workdir.js";

export type JudgeDecision = {
  verdict: "pass" | "fail";
  reasoning: string;
};

export const JUDGE_BATCH_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["pass", "fail"] },
          reasoning: { type: "string" },
        },
        required: ["id", "verdict", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

/** The agent gets the task instructions plus an explicit deliverable manifest. */
export function buildAgentPrompt(task: BenchmarkTaskDefinition): string {
  const lines = [task.instructions.trim(), ""];
  if (task.deliverables.length) {
    lines.push(
      "Write the following deliverable file(s) directly into the current working directory:",
      ...task.deliverables.map((name) => `- ${name}`),
      "",
    );
  }
  lines.push(
    "Any input documents you need are in the `documents/` folder of the current working directory.",
    "Work autonomously and do not ask clarifying questions. The task is complete once every deliverable file has been written.",
  );
  return lines.join("\n");
}

export function buildJudgeSystemPrompt(): string {
  return [
    "You are a meticulous legal work evaluator. You judge whether an AI agent's deliverable satisfies a set of evaluation criteria.",
    "When a deliverable's content is included in the prompt, judge from that content directly. Only when a deliverable is referenced by file path instead, read it from the current working directory with your file tools.",
    "Judge every criterion INDEPENDENTLY on its own match text: a verdict must never be influenced by the other criteria.",
    "Judge semantic substance, not wording: a criterion passes when the deliverable satisfies it even if phrased differently.",
    "If a referenced deliverable file does not exist or cannot be read, its criteria fail.",
    'Respond with your verdicts as JSON: {"verdicts": [{"id": "<criterion id>", "verdict": "pass" | "fail", "reasoning": "..."}]} — exactly one entry for every criterion, with concise reasoning that cites the evidence you found.',
  ].join("\n");
}

export type JudgeDeliverable = CollectedDeliverable & {
  /** Extracted plain text, when the server could parse the format. */
  text?: string | null;
};

export function buildJudgePrompt(input: {
  task: BenchmarkTaskDefinition;
  deliverables: JudgeDeliverable[];
}): string {
  const fileLines = input.deliverables.map((deliverable) => {
    if (!deliverable.relativePath) return `- ${deliverable.name} — MISSING: the agent did not produce this file`;
    if (deliverable.text) return `- ${deliverable.name} — content included below`;
    return `- ${deliverable.name} — read the file at \`${deliverable.relativePath}\``;
  });
  const contentSections = input.deliverables
    .filter((deliverable) => deliverable.text)
    .flatMap((deliverable) => ["", `## Content of ${deliverable.name}`, "", deliverable.text!]);
  const criteriaSections = input.task.criteria.flatMap((criterion) => [
    "",
    `### ${criterion.id}: ${criterion.title}`,
    ...(criterion.deliverables.length ? [`Applies to: ${criterion.deliverables.join(", ")}`] : []),
    criterion.matchCriteria,
  ]);
  const needsReading = input.deliverables.some((deliverable) => deliverable.relativePath && !deliverable.text);
  return [
    "## Task given to the agent",
    `Title: ${input.task.title}`,
    "",
    input.task.instructions.trim(),
    "",
    "## Deliverable file(s) to evaluate",
    ...(fileLines.length ? fileLines : ["- (the task defines no deliverable files)"]),
    ...contentSections,
    "",
    `## Criteria to judge (${input.task.criteria.length})`,
    ...criteriaSections,
    "",
    needsReading
      ? "Read the deliverable file(s) listed above, then return your JSON verdicts: exactly one entry per criterion id listed above."
      : "Return your JSON verdicts: exactly one entry per criterion id listed above.",
  ].join("\n");
}

function normalizeDecision(value: unknown): (JudgeDecision & { id: string }) | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const verdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
  if (!id || (verdict !== "pass" && verdict !== "fail")) return null;
  const reasoning = typeof record.reasoning === "string" ? record.reasoning.trim() : "";
  return { id, verdict, reasoning };
}

/** Parse a structured batch response into criterionId → decision. */
export function parseJudgeVerdicts(value: unknown): Map<string, JudgeDecision> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (typeof candidate !== "object" || candidate === null) return null;
  const verdicts = (candidate as Record<string, unknown>).verdicts;
  if (!Array.isArray(verdicts)) return null;
  const decisions = new Map<string, JudgeDecision>();
  for (const entry of verdicts) {
    const decision = normalizeDecision(entry);
    if (decision) decisions.set(decision.id, { verdict: decision.verdict, reasoning: decision.reasoning });
  }
  return decisions.size ? decisions : null;
}

/**
 * Extract the verdicts object from a free-form judge reply. Some providers
 * reject the forced structured-output tool call (e.g. DeepSeek thinking mode),
 * so the fallback prompt asks for plain JSON — which may arrive wrapped in
 * prose, reasoning, or a markdown fence. The LAST parseable verdicts object
 * wins (thinking models put their reasoning first and the answer at the end).
 */
export function parseJudgeVerdictsFromText(text: string): Map<string, JudgeDecision> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const direct = parseJudgeVerdicts(trimmed);
  if (direct) return direct;

  let last: Map<string, JudgeDecision> | null = null;
  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < trimmed.length; end += 1) {
      const char = trimmed[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = !inString;
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJudgeVerdicts(trimmed.slice(start, end + 1));
          if (parsed) last = parsed;
          break;
        }
      }
    }
  }
  return last;
}

/** Binary all-pass scoring with pass-count diagnostics (Harvey's methodology). */
export function scoreVerdicts(verdicts: Array<{ verdict: "pass" | "fail" | "error" }>): {
  score: number;
  nCriteria: number;
  nPassed: number;
} {
  const nCriteria = verdicts.length;
  const nPassed = verdicts.filter((entry) => entry.verdict === "pass").length;
  return { score: nCriteria > 0 && nPassed === nCriteria ? 1 : 0, nCriteria, nPassed };
}
