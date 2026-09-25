import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { ReviewToolCardSchema } from "@legalwork/types/reviews";
export function isReviewCardTool(part: ToolUIPart | DynamicToolUIPart) {
  return ["legalwork_review_create", "legalwork_review_edit", "legalwork_review_start", "legalwork_review_cancel"].includes(getToolName(part));
}
export function parseReviewCard(output: unknown) {
  try { const result = ReviewToolCardSchema.safeParse(typeof output === "string" ? JSON.parse(output) : output); return result.success ? result.data : null; }
  catch { return null; }
}
