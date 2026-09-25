import { ApiError } from "../errors.js";
import type { ReviewColumn, ReviewMode, ReviewSettings, ReviewCapabilities } from "./schema.js";
import { incompatibleJevQuestion } from "./schema.js";

export function columnBackend(mode: ReviewMode, column: ReviewColumn): "llm" | "systemone" {
  if (mode === "jev" && incompatibleJevQuestion(column))
    throw new ApiError(422, "review_mode_conflict", "Only JEV accepts yes/no and fixed-choice classification questions.", { columnKeys: [column.key], allowedKinds: ["yes_no", "classification"], mode });
  return mode === "llm" || column.kind === "text" ? "llm" : "systemone";
}

export function validateReviewPolicy(settings: ReviewSettings, columns: ReviewColumn[]) {
  const incompatible = columns.filter(column => settings.mode === "jev" && incompatibleJevQuestion(column));
  if (incompatible.length) throw new ApiError(422, "review_mode_conflict", "These columns need an LLM. Reformulate them as yes/no or fixed-choice classification, or ask the user to change the review mode.", {
    mode: settings.mode, columnKeys: incompatible.map(column => column.key), allowedKinds: ["yes_no", "classification"],
  });
  for (const column of columns) {
    const backend = columnBackend(settings.mode, column);
    if (!(backend === "systemone" ? settings.jev : settings.llm))
      throw new ApiError(409, "review_model_required", backend === "systemone" ? "Select a JEV model in review settings." : "Select an LLM in review settings.", { backend });
  }
}

export function validateAvailableModels(capabilities: ReviewCapabilities, settings: ReviewSettings, columns: ReviewColumn[]) {
  validateReviewPolicy(settings, columns);
  for (const backend of new Set(columns.map(column => columnBackend(settings.mode, column)))) {
    const selected = backend === "systemone" ? settings.jev : settings.llm;
    if (!selected || !capabilities.models.some(model => model.backend === backend && model.providerId === selected.providerId && model.model === selected.model))
      throw new ApiError(409, "review_model_unavailable", "The selected review model is unavailable. Reconnect it or explicitly choose another model in review settings.", { backend, selected });
  }
}
