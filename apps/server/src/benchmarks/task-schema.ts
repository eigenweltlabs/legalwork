import { z } from "zod";

export const BENCHMARK_WORK_TYPES = ["analyze", "draft", "review", "research"] as const;

export type BenchmarkWorkType = (typeof BENCHMARK_WORK_TYPES)[number];

export type BenchmarkCriterion = {
  id: string;
  title: string;
  deliverables: string[];
  matchCriteria: string;
};

export type BenchmarkTaskDefinition = {
  title: string;
  workType: BenchmarkWorkType;
  tags: string[];
  instructions: string;
  deliverables: string[];
  criteria: BenchmarkCriterion[];
};

export type BenchmarkTaskSource = "harvey" | "custom";

export type BenchmarkTaskRef = {
  source: BenchmarkTaskSource;
  key: string;
};

const HARVEY_TASK_KEY_PATTERN = /^tasks\/([^/]+)\/([^/]+)$/;

const workTypeSchema = z.enum(BENCHMARK_WORK_TYPES);

const harveyCriterionSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  deliverables: z.array(z.string().trim().min(1)).optional(),
  match_criteria: z.string().trim().min(1),
});

const harveyTaskSchema = z.object({
  title: z.string().trim().min(1),
  work_type: workTypeSchema,
  tags: z.array(z.string().trim().min(1)).default([]),
  instructions: z.string().trim().min(1),
  deliverables: z.union([z.record(z.string(), z.string()), z.array(z.string().trim().min(1))]).default([]),
  criteria: z.array(harveyCriterionSchema).min(1),
});

const customCriterionSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  deliverables: z.array(z.string().trim().min(1).max(200)).optional(),
  matchCriteria: z.string().trim().min(1).max(8000),
});

export const customTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  workType: workTypeSchema,
  tags: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  instructions: z.string().trim().min(1).max(40000),
  deliverables: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  criteria: z.array(customCriterionSchema).min(1).max(100),
});

export type CustomTaskInput = z.infer<typeof customTaskInputSchema>;

export type TaskParseResult =
  | { ok: true; task: BenchmarkTaskDefinition }
  | { ok: false; error: string };

function normalizeDeliverables(value: Record<string, string> | string[]): string[] {
  const names = Array.isArray(value) ? value : Object.keys(value);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function normalizeCriteria(
  criteria: Array<{ id?: string; title?: string; deliverables?: string[]; matchCriteria: string }>,
  taskDeliverables: string[],
): BenchmarkCriterion[] {
  const seenIds = new Set<string>();
  return criteria.map((criterion, index) => {
    let id = criterion.id?.trim() || `C-${String(index + 1).padStart(3, "0")}`;
    while (seenIds.has(id)) id = `${id}-${index + 1}`;
    seenIds.add(id);
    const deliverables = criterion.deliverables?.length
      ? normalizeDeliverables(criterion.deliverables)
      : [...taskDeliverables];
    return {
      id,
      title: criterion.title?.trim() || `Criterion ${index + 1}`,
      deliverables,
      matchCriteria: criterion.matchCriteria.trim(),
    };
  });
}

export function parseHarveyTaskJson(raw: unknown): TaskParseResult {
  const parsed = harveyTaskSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  const deliverables = normalizeDeliverables(parsed.data.deliverables);
  return {
    ok: true,
    task: {
      title: parsed.data.title,
      workType: parsed.data.work_type,
      tags: parsed.data.tags,
      instructions: parsed.data.instructions,
      deliverables,
      criteria: normalizeCriteria(
        parsed.data.criteria.map((criterion) => ({
          id: criterion.id,
          title: criterion.title,
          deliverables: criterion.deliverables,
          matchCriteria: criterion.match_criteria,
        })),
        deliverables,
      ),
    },
  };
}

export function parseCustomTaskInput(raw: unknown): TaskParseResult {
  const parsed = customTaskInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  const deliverables = normalizeDeliverables(parsed.data.deliverables);
  return {
    ok: true,
    task: {
      title: parsed.data.title,
      workType: parsed.data.workType,
      tags: parsed.data.tags,
      instructions: parsed.data.instructions,
      deliverables,
      criteria: normalizeCriteria(parsed.data.criteria, deliverables),
    },
  };
}

export function parseStoredTaskJson(raw: string): BenchmarkTaskDefinition | null {
  try {
    const value = JSON.parse(raw) as BenchmarkTaskDefinition;
    if (!value || typeof value.title !== "string" || !Array.isArray(value.criteria)) return null;
    return value;
  } catch {
    return null;
  }
}

export function isHarveyTaskKey(key: string): boolean {
  return HARVEY_TASK_KEY_PATTERN.test(key);
}

export function verticalFromHarveyKey(key: string): string {
  const match = HARVEY_TASK_KEY_PATTERN.exec(key);
  return match?.[1] ?? "";
}

export function taskNameFromHarveyKey(key: string): string {
  const match = HARVEY_TASK_KEY_PATTERN.exec(key);
  return match?.[2] ?? key;
}

export function verticalLabel(task: BenchmarkTaskDefinition | null, verticalId: string): string {
  const tag = task?.tags[0]?.trim();
  if (tag) return tag;
  return verticalId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
