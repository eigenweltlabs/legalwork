import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { TimesheetStateSchema } from "@legalwork/types/timesheet";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { modelEvidence } from "./workday-context.js";
import { generateStructuredWorkday, workdayGroupingInput } from "./workday-model-passes.js";
import { validateWorkdayGroups } from "./reconstruct-workday.js";

const date = "2026-11-16";
function matter(id: string, name: string, reference: string, ...clientIds: string[]) {
  return { id, name, reference, clientIds };
}
const fields = [
  matter("kestrel", "Project Kestrel | Battery-controls acquisition (Demo)", "DEMO-2026-001", "copper", "quarry"),
  matter("escrow", "Project Kestrel | Firmware and source-code escrow (Demo)", "DEMO-2026-002", "copper"),
  matter("fieldglass", "Fieldglass | Vendor transfer assessment (Demo)", "DEMO-2026-012", "bramble"),
  matter("renewal", "Fieldglass | Enterprise SaaS renewal (Demo)", "DEMO-2026-010", "bramble"),
  matter("speicher", "Alter Speicher | Mixed-use lease and fit-out (Demo)", "DEMO-2026-016", "ember"),
  matter("retention", "Alter Speicher | Damp remediation and retention (Demo)", "DEMO-2026-017", "ember"),
  matter("haven", "Havenstitch | Care scheduling vendor intake (Demo)", "DEMO-2026-015", "care"),
  matter("workforce", "Havenstitch | Workforce transition (Demo)", "DEMO-2026-018", "care"),
];
const state = TimesheetStateSchema.parse({ scope: "local", userId: "local", canManage: false, canReview: false,
  clients: [["copper", "Copperlark Grid Systems GmbH (Demo)"], ["quarry", "Quarrylight Capital Partners GmbH (Demo)"],
    ["bramble", "Brambleglass Analytics GmbH (Demo)"], ["ember", "Emberfenn Wohnbau eG (Demo)"], ["care", "Havenstitch Pflege gGmbH (Demo)"]]
    .map(([id, name]) => ({ id, name })),
  matters: fields, projects: [{ id: "timekeeping", name: "Private work", matterIds: [] },
    { id: "multiple", name: "Visible linked matters", matterIds: ["renewal", "fieldglass"] }],
  people: [], entries: [], products: [], invoices: [], policies: [] });
const filenames = [
  ["kestrel", "Kestrel battery-controls acquisition diligence brief.pdf"],
  ["kestrel", "Kestrel battery-controls acquisition indemnity markup.docx"],
  ["fieldglass", "Fieldglass vendor transfer data map.xlsx"],
  ["fieldglass", "Fieldglass vendor transfer assessment minutes.docx"],
  ["speicher", "Alter Speicher mixed-use lease rent schedule.xlsx"],
  ["speicher", "Alter Speicher mixed-use lease fit-out redline.docx"],
  ["haven", "Havenstitch care scheduling intake checklist.pdf"],
  ["haven", "Havenstitch care scheduling vendor intake follow-up.docx"],
];
function observation(title: string, fields: Partial<CaptureProposal> = {}) {
  const key = randomUUID();
  const proposal: CaptureProposal = { date, source: "desktop", projectId: null, activity: "", workedMinutes: null,
    startAt: null, endAt: null, key, digest: "f".repeat(64), narrative: title, dismissed: false,
    desktopContext: { platform: "darwin", application: "Pages", documentName: title }, ...fields };
  return { eventKey: key, proposal };
}
function scoped(...observations: ReturnType<typeof observation>[]) {
  return modelEvidence(observations, state, [], date);
}

test("each desktop file independently supports only its own matter, without changing captured evidence or time", () => {
  for (const [id, title] of filenames) {
    for (const source of [observation(title), observation(title, { desktopContext: undefined, fileUseSource: "spotlight-last-used" })]) {
      const [ref] = scoped(source);
      expect(ref.matter?.id).toBe(id);
      expect(ref.matterMatch).toBe("title");
      expect(ref.item).toBe(source);
      expect(source.proposal.matterId).toBeUndefined();
      expect(source.proposal.workedMinutes).toBeNull();
    }
  }
  expect(scoped(observation("Havenstitch care scheduling intake", { source: "calendar", desktopContext: undefined, projectId: "timekeeping" }))[0].matter?.id).toBe("haven");
  expect(scoped(observation("Brambleglass Analytics vendor transfer call", { source: "outlook" }))[0].matter?.id).toBe("fieldglass");
  expect(scoped(observation("Endorsement DEMO_2026_016.pdf"))[0]).toMatchObject({ matter: { id: "speicher" }, matterMatch: "reference" });
  expect(scoped(observation("Battery controls acquisition.pdf"))[0].matter?.id).toBe("kestrel");
});

test("ambiguous titles, client-only clues, partial identifiers and application names supply no matter", () => {
  for (const title of ["Fieldglass memo.docx", "Brambleglass Analytics GmbH.docx", "Vendor memorandum.pdf", "Havenstitching careless rescheduling intake.pdf",
    "Fieldglass vendor transfer and enterprise SaaS renewal agenda.pdf", "Havenstitch care call next week about a different vendor.pdf", "Fieldglass DEMO-2026-016.pdf",
    "XXDEMO-2026-0165.pdf", "Kestrel draft contract notes.pdf", "Quarterly review.pdf", "Preview", "Finder"]) {
    expect(scoped(observation(title))[0].matter, title).toBeUndefined();
  }
  const generic = observation("Kestrel battery controls acquisition", { desktopContext: { platform: "darwin", application: "Finder" } });
  expect(scoped(generic)[0].matter).toBeUndefined();
  expect(scoped(observation(filenames[0][1], { projectId: "multiple" }))[0].matter).toBeUndefined();
  expect(scoped(observation(filenames[0][1], { matterId: "hidden" }))).toEqual([]);
  const undisclosed = { ...state, matters: state.matters.filter(matter => matter.id !== "speicher") };
  expect(modelEvidence([observation("DEMO_2026_016 private letter.pdf")], undisclosed, [], date)[0].matter).toBeUndefined();
  const duplicate = { ...state, matters: [...state.matters, matter("ambiguous", "Other party | Battery-controls acquisition", "DUP-001")] };
  expect(modelEvidence([observation("Battery controls acquisition.pdf")], duplicate, [], date)[0].matter).toBeUndefined();
});

test("grouping uses only handles authorized by cited observations and keeps app-only activity separate", async () => {
  const first = observation(filenames[0][1]), other = observation(filenames[2][1]);
  const app = observation("Finder", { desktopContext: { platform: "darwin", application: "Finder" } });
  const refs = scoped(first, other, app);
  const payload = workdayGroupingInput(refs);
  expect(payload.map(row => row.matterId)).toEqual(["m1", "m2", null]);
  const group = { evidenceIds: [first.eventKey], activity: null, matterId: "kestrel", projectId: null, documentId: null,
    startAt: null, endAt: null, workedMinutes: null };
  expect(() => validateWorkdayGroups([{ ...group, evidenceIds: [first.eventKey, app.eventKey] }], refs, date, "UTC")).toThrow();
  for (const proposed of ["m1", "m2", "m999", "kestrel", null]) {
    const result = generateStructuredWorkday({ date, zone: "UTC", skill: "", transcript: [], evidence: refs,
      async generate(prompt) {
        const input = JSON.parse(prompt.split("\n\n").at(-1)!);
        if (input.stage === "grouping") {
          expect(prompt).not.toContain("Firmware and source-code escrow");
          expect(input.evidence.map((row: { matterId: string | null }) => row.matterId)).toEqual(["m1", "m2", null]);
          return JSON.stringify({ proposals: [{ ...group, evidenceIds: ["e1"], matterId: proposed }] });
        }
        return JSON.stringify({ wording: [{ index: 0, narrative: "Reviewed document name" }] });
      } });
    if (proposed === "m1" || proposed === null) {
      const [draft] = await result;
      expect(draft.proposal.matterId).toBe(proposed ? "kestrel" : undefined);
      expect(draft.proposal.projectId).toBeNull();
      expect(draft.proposal.workedMinutes).toBeNull();
      expect(draft.claims[0].id).toBe(first.eventKey);
    } else await expect(result).rejects.toMatchObject({ code: "timesheet_model_format" });
  }
});
