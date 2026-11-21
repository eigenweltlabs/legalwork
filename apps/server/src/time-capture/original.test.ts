import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { originalBillingComparison, proposalCommitment } from "./original.js";

test("the private comparison verifies the exact referenced original and discloses only billing fields", () => {
  const p: CaptureProposal = {
    key: randomUUID(),
    digest: "",
    date: "2026-11-13",
    source: "calendar",
    account: "a".repeat(64),
    projectId: "workspace",
    activity: "EXM",
    narrative: "Meet to discuss the agreement",
    startAt: "2026-11-13T13:00:00Z",
    endAt: "2026-11-13T13:30:00Z",
    workedMinutes: 30,
    dismissed: false,
  };
  p.digest = proposalCommitment(p);
  expect(originalBillingComparison(p, p.digest)).toEqual({
    digest: p.digest,
    date: p.date,
    activity: p.activity,
    narrative: p.narrative,
    workedMinutes: 30,
  });
  expect(() => originalBillingComparison({ ...p, workedMinutes: 40 }, p.digest)).toThrow(
    /does not match/,
  );
  expect(() => originalBillingComparison(undefined, p.digest)).toThrow(/unavailable/);
  expect(proposalCommitment({ ...p, key: randomUUID() })).not.toBe(p.digest);
});
