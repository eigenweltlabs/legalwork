import type { BenchmarkCustomTaskInput, BenchmarkWorkType } from "../../../app/lib/benchmark-types";
import { BENCHMARK_WORK_TYPES } from "../../../app/lib/benchmark-types";

export type CustomTaskDraft = {
  title: string;
  workType: BenchmarkWorkType;
  tags: string[];
  instructions: string;
  deliverables: string[];
  criteria: string[];
  documents: Array<{ name: string; contentBase64: string }>;
};

export const EMPTY_CUSTOM_TASK_DRAFT: CustomTaskDraft = {
  title: "",
  workType: "analyze",
  tags: [],
  instructions: "",
  deliverables: [""],
  criteria: [""],
  documents: [],
};

export type CustomTaskValidation =
  | { ok: true; input: BenchmarkCustomTaskInput }
  | { ok: false; errors: Partial<Record<"title" | "instructions" | "criteria" | "deliverables", string>> };

export function validateCustomTask(draft: CustomTaskDraft): CustomTaskValidation {
  const errors: Partial<Record<"title" | "instructions" | "criteria" | "deliverables", string>> = {};

  const title = draft.title.trim();
  if (!title) errors.title = "benchmark.form_validation_title_required";

  const instructions = draft.instructions.trim();
  if (!instructions) errors.instructions = "benchmark.form_validation_instructions_required";

  const criteria = draft.criteria.map((entry) => entry.trim()).filter(Boolean);
  if (!criteria.length) errors.criteria = "benchmark.form_validation_criteria_required";

  const deliverables = draft.deliverables.map((entry) => entry.trim()).filter(Boolean);
  if (deliverables.some((name) => name.includes("/") || name.includes("\\"))) {
    errors.deliverables = "benchmark.form_validation_deliverable_invalid";
  }

  const workType = BENCHMARK_WORK_TYPES.includes(draft.workType) ? draft.workType : "analyze";

  if (Object.keys(errors).length) return { ok: false, errors };

  const tags = Array.from(new Set(draft.tags.map((tag) => tag.trim()).filter(Boolean)));
  return {
    ok: true,
    input: {
      title,
      workType,
      tags,
      instructions,
      deliverables,
      criteria: criteria.map((matchCriteria) => ({ matchCriteria })),
      ...(draft.documents.length ? { documents: draft.documents } : {}),
    },
  };
}
