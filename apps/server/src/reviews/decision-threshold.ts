import { reviewDecisionThreshold, selectedReviewDecisionProbability, type ReviewResult, type ReviewSettings } from "./schema.js";

/** Apply the saved user threshold without losing the original model distribution. */
export function enforceReviewDecisionThreshold(result: ReviewResult, settings: ReviewSettings): ReviewResult {
  if (result.backend !== "systemone" || !result.decision || result.value === "Needs review") return result;
  const probability = selectedReviewDecisionProbability(result.decision), threshold = reviewDecisionThreshold(settings);
  if (probability >= threshold && probability > 0.5) return result;
  return { ...result, value: "Needs review", evidence: "uncertain", decisionThreshold: threshold,
    reason: `The model assigned ${(probability * 100).toFixed(1)}% to its selected answer. This does not meet the ${Math.round(threshold * 100)}% minimum for an unambiguous answer. Review the source; no answer was accepted.`,
  };
}
