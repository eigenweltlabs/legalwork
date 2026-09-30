import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { ReviewToolCardSchema, type SavedReview } from "@legalwork/types/reviews";
export function isReviewCardTool(part: ToolUIPart | DynamicToolUIPart) {
  return ["legalwork_review_create", "legalwork_review_edit", "legalwork_review_start", "legalwork_review_cancel"].includes(getToolName(part));
}
export function parseReviewCard(output: unknown) {
  try { const result = ReviewToolCardSchema.safeParse(typeof output === "string" ? JSON.parse(output) : output); return result.success ? result.data : null; }
  catch { return null; }
}

export function reviewCardIdentity(part: ToolUIPart | DynamicToolUIPart) {
  if (!isReviewCardTool(part) || part.state !== "output-available") return null;
  const card = parseReviewCard(part.output);
  return card ? `${card.workspaceId}:${card.review.id}` : null;
}

export function reviewCardProgress(card: NonNullable<ReturnType<typeof parseReviewCard>>, review?: SavedReview) {
  const cells = review?.cells ?? [];
  const done = review ? cells.filter(cell => ["complete", "needs_review", "error"].includes(cell.status)).length : card.review.completed;
  const total = review?.cells.length ?? card.review.total;
  return {
    name: review?.name ?? card.review.name,
    status: review?.status ?? card.review.status,
    documents: review?.documents.length ?? card.review.documents,
    columns: review?.columns.length ?? card.review.columns,
    done, total, percent: total ? Math.min(100, Math.floor(done / total * 100)) : 0,
    running: cells.filter(cell => cell.status === "running").length,
    queued: cells.filter(cell => cell.status === "queued").length,
    preparing: review?.documents.filter(document => document.status === "preparing").length ?? 0,
    attention: cells.filter(cell => ["needs_review", "error", "blocked", "stale"].includes(cell.status)).length,
  };
}
