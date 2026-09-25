import { ApiError } from "../errors.js";
import type { ReviewCell, ReviewColumn, ReviewMode, ReviewSettings, ReviewCapabilities } from "./schema.js";
import { incompatibleJevQuestion, isJevColumnKind } from "./schema.js";

export function columnBackend(mode: ReviewMode, column: ReviewColumn): "llm" | "systemone" {
  if (mode === "jev" && incompatibleJevQuestion(column))
    throw new ApiError(422, "review_mode_conflict", "Only JEV accepts yes/no and fixed-choice classification questions.", { columnKeys: [column.key], allowedKinds: ["yes_no", "classification"], mode });
  return mode === "llm" || !isJevColumnKind(column.kind) ? "llm" : "systemone";
}

export function validateReviewPolicy(settings: ReviewSettings, columns: ReviewColumn[]) {
  const incompatible = columns.filter(column => settings.mode === "jev" && incompatibleJevQuestion(column));
  if (incompatible.length) throw new ApiError(422, "review_mode_conflict", "These columns need an LLM. Reformulate them as yes/no or fixed-choice classification, or ask the user to change the review mode.", {
    mode: settings.mode, columnKeys: incompatible.map(column => column.key), allowedKinds: ["yes_no", "classification"],
  });
}

export function validateAvailableModels(capabilities: ReviewCapabilities, settings: ReviewSettings, columns: ReviewColumn[]) {
  const blocked = new Map<string, NonNullable<ReviewCell["blockedBy"]>>();
  for (const column of columns) {
    if (settings.mode === "jev" && incompatibleJevQuestion(column)) {
      blocked.set(column.key, "jev_mode");
      continue;
    }
    const backend = columnBackend(settings.mode, column);
    const selected = backend === "systemone" ? settings.jev : settings.llm;
    if (!selected || !capabilities.models.some(model => model.backend === backend && model.providerId === selected.providerId && model.model === selected.model))
      blocked.set(column.key, backend);
  }
  if (columns.length && blocked.size === columns.length) {
    if ([...blocked.values()].every(reason => reason === "jev_mode"))
      throw new ApiError(422, "review_mode_conflict", "These columns cannot run in Only JEV mode. Choose JEV + LLM or Only LLM to run them.", { columnKeys: [...blocked.keys()] });
    throw new ApiError(409, "review_model_unavailable", "Connect and select the model required by these columns in review settings.", { columnKeys: [...blocked.keys()] });
  }
  return blocked;
}
