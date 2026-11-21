import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { bindingTimeTerm, TimesheetStateSchema, type TimePolicy, type WorkdayGuideline } from "../back-office/timesheet-schema.js";
import { extractGuidelineRules } from "./guideline-rules.js";
import { draftRules, effectiveWorkdayGuidelines } from "./workday-context.js";
import { proposedWorkdayCharge } from "./reconstruct-workday.js";

const date = "2026-11-21";
const matter = { id: "matter", name: "Matter", reference: "", clientIds: ["client"] };
function state() {
  return TimesheetStateSchema.parse({ scope: "local", userId: "local", canManage: true, canReview: true,
    clients: [{ id: "client", name: "Client" }], matters: [matter], people: [], entries: [], products: [], invoices: [], policies: [], projects: [] });
}
const upload = (rules: WorkdayGuideline["rules"]): WorkdayGuideline => ({ id: randomUUID(), name: "Reviewed guideline", revision: 1,
  scope: "matter", targetId: matter.id, effectiveFrom: date, rules });

test("uploaded numerical rules become editable policies and apply to billable, retaining actual time", async () => {
  const text = "Bill at least ten minutes, in six-minute units. Round upwards.";
  const extracted = await extractGuidelineRules(text, async prompt => {
    expect(prompt).toContain(JSON.stringify({ stage: "guideline-rules", text }));
    return JSON.stringify({ rules: { minimumMinutes: 10, incrementMinutes: 6, enforceIncrement: true, rounding: "up" },
      evidence: { minimumMinutes: "at least ten minutes", incrementMinutes: "six-minute units", enforceIncrement: "six-minute units", rounding: "Round upwards." }, notes: [] });
  });
  const rules = draftRules(state(), [upload({ ...extracted.rules, instructions: text })], matter, date);
  const proposal = { key: randomUUID(), digest: "a".repeat(64), source: "calendar" as const, date, projectId: null,
    activity: "MOD", narrative: "Amending the draft", startAt: null, endAt: null, workedMinutes: 4, dismissed: false };
  expect(proposedWorkdayCharge(proposal, rules)).toBe(12);
  expect(proposal.workedMinutes).toBe(4);
});

test("extracting cannot invent source passages, unsupported fields or contradictory limits", async () => {
  const text = "Minimum 10 minutes; maximum 30 minutes.";
  for (const result of [
    { rules: { minimumMinutes: 10 }, evidence: {}, notes: [] },
    { rules: { minimumMinutes: 10 }, evidence: { minimumMinutes: "Minimum 60" }, notes: [] },
    { rules: { minimumMinutes: 30, maxMinutes: 10 }, evidence: { minimumMinutes: text, maxMinutes: text }, notes: [] },
    { rules: { hourlyRate: 999 }, evidence: {}, notes: [] },
  ]) await expect(extractGuidelineRules(text, async () => JSON.stringify(result))).rejects.toThrow();
  await expect(extractGuidelineRules(text, async () => "not JSON")).rejects.toThrow();
  expect(await extractGuidelineRules("Discuss the applicable minimum with the client.", async () => JSON.stringify({
    rules: {}, evidence: {}, notes: ["No numerical minimum is stated."],
  }))).toEqual({ rules: {}, evidence: {}, notes: ["No numerical minimum is stated."] });
});

test("an unrelated published reviewer preserves upload context; only explicit overlapping fields win", () => {
  const current = state();
  const guideline = upload({ minimumMinutes: 10, maxMinutes: 60, incrementMinutes: 6, rounding: "up",
    actionWords: { DFT: "Drafting", MOD: "Amending" }, instructions: "Use the approved document terminology." });
  current.policies = [{ scope: "matter", targetId: matter.id, effectiveFrom: date, revision: 1, reviewerId: "partner" }];
  expect(effectiveWorkdayGuidelines(current, [guideline], { clientId: "client", matterId: matter.id, date })).toEqual([guideline]);
  expect(draftRules(current, [guideline], matter, date)).toMatchObject({ minimumMinutes: 10, maxMinutes: 60, incrementMinutes: 6,
    guidelineInstructions: [guideline.rules.instructions], actionWords: { DFT: "Drafting", MOD: "Amending" } });
  current.policies[0] = { ...current.policies[0], incrementMinutes: 15, actionWords: { DFT: "Preparing" } };
  expect(draftRules(current, [guideline], matter, date)).toMatchObject({ minimumMinutes: 10, incrementMinutes: 15,
    actionWords: { DFT: "Preparing", MOD: "Amending" }, guidelineInstructions: [guideline.rules.instructions] });
  expect(draftRules(current, [guideline], matter, "2026-11-20").guidelineInstructions).toEqual([]);
});

test("activity-specific extraction uses the actual billing activity catalog", async () => {
  const text = "Telephone calls at most 15 minutes.";
  await expect(extractGuidelineRules(text, async () => JSON.stringify({
    rules: { activityLimits: { phone: 15 } }, evidence: { activityLimits: text }, notes: [],
  }))).rejects.toThrow("unknown code");
  const extracted = await extractGuidelineRules(text, async prompt => {
    expect(prompt).toContain('"TEL":"Telephone call"');
    return JSON.stringify({ rules: { activityLimits: { TEL: 15 } }, evidence: { activityLimits: text }, notes: [] });
  });
  const rules = draftRules(state(), [upload({ ...extracted.rules, enforceIncrement: false })], matter, date);
  expect(proposedWorkdayCharge({ key: randomUUID(), digest: "a".repeat(64), source: "calendar", date,
    projectId: null, activity: "TEL", narrative: "Telephone call", startAt: null, endAt: null,
    workedMinutes: 30, dismissed: false }, rules)).toBe(15);
});

const clientUpload = (rules: WorkdayGuideline["rules"]): WorkdayGuideline => ({
  ...upload(rules), scope: "client", targetId: "client",
});

function projectException(policies: TimePolicy[], incrementMinutes: number): TimePolicy {
  const term = bindingTimeTerm(policies, "client", date, "project");
  if (!term) throw new Error("Expected a published binding term.");
  return {
    scope: "project", targetId: "project", effectiveFrom: date, revision: 1,
    enforceIncrement: false, incrementMinutes,
    incrementException: {
      reason: "Client approved a project exception", authorizedBy: "partner",
      authorizedAt: date + "T12:00:00Z", terms: [term],
    },
  };
}

test("private rules preserve a published binding client increment inherited from the firm", () => {
  const current = state();
  current.policies = [
    { scope: "firm", targetId: "firm", effectiveFrom: date, revision: 1, incrementMinutes: 10 },
    { scope: "client", targetId: "client", effectiveFrom: date, revision: 2, bindingIncrement: true },
  ];
  const guidelines = [clientUpload({ incrementMinutes: 6, enforceIncrement: false, minimumMinutes: 15 })];
  expect(draftRules(current, guidelines, matter, date)).toMatchObject({
    incrementMinutes: 10, enforceIncrement: true, minimumMinutes: 15,
  });
  current.policies.push(projectException(current.policies, 5));
  expect(draftRules(current, guidelines, matter, date, "project")).toMatchObject({
    incrementMinutes: 5, enforceIncrement: false, minimumMinutes: 15,
  });
});

test("private rules preserve the binding term and authorized exception from a legacy signed agreement", () => {
  const current = state();
  current.policies = [{
    scope: "client", targetId: "client", effectiveFrom: "0001-01-01", revision: 0,
    agreementId: "signed-agreement", bindingIncrement: true, incrementMinutes: 12,
  }];
  const guidelines = [clientUpload({ maxMinutes: 48, instructions: "Use complete work descriptions." })];
  expect(draftRules(current, guidelines, matter, date)).toMatchObject({
    incrementMinutes: 12, enforceIncrement: true, maxMinutes: 48,
    guidelineInstructions: ["Use complete work descriptions."],
  });
  current.policies.push(projectException(current.policies, 6));
  expect(draftRules(current, guidelines, matter, date, "project")).toMatchObject({
    incrementMinutes: 6, enforceIncrement: false, maxMinutes: 48,
  });
});
