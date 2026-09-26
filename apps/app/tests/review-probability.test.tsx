import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewResult } from "@legalwork/types/reviews";
import { ReviewProbabilities, reviewAnswerProbability } from "../src/react-app/domains/reviews/review-ui";

const result: ReviewResult = { value: "No", reason: "", confidence: null, citations: [], evidence: "uncited", backend: "systemone", providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: "hash",
  prompt: { key: "answer", label: "Answer", question: "Is assignment permitted?", kind: "yes_no", options: [], hint: "" }, completedAt: 1, chunks: [], decision: { type: "noul", noul: 0 } };

test("a No answer shows its own probability and both Yes and No are rendered without statistical notation", () => {
  expect(reviewAnswerProbability(result)).toBe(1);
  const html = renderToStaticMarkup(<ReviewProbabilities result={result} />);
  expect(html).toContain("Yes"); expect(html).toContain("No");
  expect(html).toContain("0.0%"); expect(html).toContain("100.0%");
  expect(html).not.toContain("P(");
  expect(reviewAnswerProbability({ ...result, value: "Needs review" })).toBeNull();
});
test("classification details retain every option including zero-probability and fallback choices", () => {
  const choice: ReviewResult = { ...result, value: "Not found", decision: { type: "choice", choice: "Not found", probabilities: { Mutual: .02, "One-way": 0, "Not found": .96, "Not applicable": .01, Unclear: .01 } } };
  expect(reviewAnswerProbability(choice)).toBe(.96);
  const html = renderToStaticMarkup(<ReviewProbabilities result={choice} />);
  for (const label of ["Mutual", "One-way", "Not found", "Not applicable", "Unclear"]) expect(html).toContain(label);
});
