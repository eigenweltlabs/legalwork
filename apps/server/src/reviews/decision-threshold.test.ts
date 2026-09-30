import { expect, test } from "bun:test";
import { enforceReviewDecisionThreshold } from "./decision-threshold.js";
import { ReviewSettingsSchema, reviewDecisionProbabilities, reviewDecisionThreshold, type ReviewResult, type ReviewSettings } from "./schema.js";

const settings: ReviewSettings = { mode: "jev", jev: { providerId: "firm", model: "jev" }, llm: null };
function binary(probability: number): ReviewResult {
  return { value: probability >= .5 ? "Yes" : "No", reason: "", confidence: null, citations: [], evidence: "uncited", backend: "systemone", providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: "hash",
    prompt: { key: "answer", label: "Answer", question: "Is assignment permitted?", kind: "yes_no", options: [], hint: "" }, completedAt: 1, chunks: [], decision: { type: "noul", noul: probability } };
}

test("binary probabilities show both outcomes and threshold the chosen answer, not always Yes", () => {
  expect(reviewDecisionThreshold(settings)).toBe(.8);
  for (const probability of [0, .01, .2, .4, .49, .5, .51, .6, .79, .8, .99, 1]) {
    const raw = binary(probability), result = enforceReviewDecisionThreshold(raw, settings);
    expect(reviewDecisionProbabilities(raw.decision!)).toEqual([{ label: "Yes", probability }, { label: "No", probability: 1 - probability }]);
    if (Math.max(probability, 1 - probability) >= .8) expect(result).toBe(raw);
    else {
      expect(result.value).toBe("Needs review"); expect(result.evidence).toBe("uncertain");
      expect(result.decision).toEqual(raw.decision); expect(result.decisionThreshold).toBe(.8);
    }
  }
});
test("custom thresholds apply to all JEV choices and never manufacture certainty or alter LLM results", () => {
  const raw = binary(.85);
  expect(enforceReviewDecisionThreshold(raw, { ...settings, minDecisionProbability: .9 }).value).toBe("Needs review");
  expect(enforceReviewDecisionThreshold(raw, { ...settings, minDecisionProbability: .7 })).toBe(raw);
  expect(enforceReviewDecisionThreshold(binary(.5), { ...settings, minDecisionProbability: .5 }).value).toBe("Needs review");
  const choice: ReviewResult = { ...raw, value: "A", decision: { type: "choice", choice: "A", probabilities: { A: .4, B: .35, C: .25 } } };
  expect(enforceReviewDecisionThreshold(choice, settings).value).toBe("Needs review");
  expect(enforceReviewDecisionThreshold(choice, settings).decision).toEqual(choice.decision);
  const llm: ReviewResult = { ...raw, backend: "llm", decision: undefined };
  expect(enforceReviewDecisionThreshold(llm, settings)).toBe(llm);
  for (const minDecisionProbability of [-1, .49, 1.01, NaN]) expect(ReviewSettingsSchema.safeParse({ ...settings, minDecisionProbability }).success).toBe(false);
});
