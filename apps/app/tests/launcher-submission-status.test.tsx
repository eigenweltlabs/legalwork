import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SubmissionStatusRow } from "../src/react-app/launcher/launcher-conversation";

test("a failed run without a retryable message shows its error without a dead button", () => {
  const submission = { requestId: "request_123", state: "failed", error: "The model stopped responding." };
  const failedRun = renderToStaticMarkup(<SubmissionStatusRow submission={submission} />);
  expect(failedRun).toContain(submission.error);
  expect(failedRun).not.toContain("<button");
  const failedDelivery = renderToStaticMarkup(<SubmissionStatusRow submission={submission} onRetry={() => {}} />);
  expect(failedDelivery).toContain("<button");
});
