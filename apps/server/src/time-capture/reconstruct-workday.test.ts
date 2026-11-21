import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { TimesheetStateSchema } from "@legalwork/types/timesheet";
import {
  reconstructWorkday,
  remainingEvidence,
  type ModelEvidence,
  type WorkdayModelOutput,
} from "./reconstruct-workday.js";
import { acceptedFileProduct, modelEvidence } from "./workday-context.js";
import { generateStructuredWorkday } from "./workday-model-passes.js";

const date = "2026-11-20";
const at = (clock: string) => date + "T" + clock + ":00Z";
const matter = { id: "matter", name: "Synthetic matter" };
const other = { id: "other", name: "Other matter" };
function evidence(
  id: string,
  fields: Partial<CaptureProposal> = {},
): ModelEvidence {
  return {
    instructions: [],
    matter,
    item: {
      eventKey: id,
      proposal: {
        key: randomUUID(),
        digest: "0".repeat(64),
        source: "calendar",
        activity: "EXM",
        narrative: id,
        date,
        dismissed: false,
        projectId: "project",
        startAt: at("09:00"),
        endAt: at("10:00"),
        workedMinutes: 60,
        ...fields,
      },
    },
  };
}
function proposal(
  evidenceIds: string[],
  fields: Partial<WorkdayModelOutput["proposals"][number]> = {},
) {
  return {
    evidenceIds,
    matterId: matter.id,
    projectId: "project",
    documentId: null,
    activity: "EXM",
    narrative: "Discussing the agreement",
    startAt: at("09:00"),
    endAt: at("10:00"),
    workedMinutes: 60,
    ...fields,
  };
}

test("whole-day reconstruction groups adjoining evidence, omits unrelated sources, and splits one interval without reuse", () => {
  const first = evidence("first");
  const second = evidence("second", {
    startAt: at("10:00"),
    endAt: at("10:30"),
    workedMinutes: 30,
  });
  const machine = evidence("agent", {
    source: "agent",
    observation: "agent",
    startAt: at("12:00"),
    endAt: at("12:40"),
  });
  const grouped = reconstructWorkday(
    {
      proposals: [
        proposal(["second", "first"], {
          endAt: at("10:30"),
          workedMinutes: 90,
        }),
      ],
    },
    [first, second, machine],
    date,
    "UTC",
  );
  expect(grouped).toHaveLength(1);
  expect(grouped[0].claims?.map((claim) => claim.id)).toEqual([
    "first",
    "second",
  ]);
  expect(grouped[0].proposal.workedMinutes).toBe(90);

  const rows = [
    proposal(["first"], { endAt: at("09:15"), workedMinutes: 15 }),
    proposal(["first"], { startAt: at("09:15"), workedMinutes: 45 }),
  ];
  const result = reconstructWorkday({ proposals: rows }, [first], date, "UTC");
  expect(result.map((item) => item.proposal.workedMinutes)).toEqual([15, 45]);
  expect(new Set(result.map((item) => item.eventKey)).size).toBe(2);
  expect(
    reconstructWorkday({ proposals: rows }, [first], date, "UTC").map(
      (item) => item.eventKey,
    ),
  ).toEqual(result.map((item) => item.eventKey));
  const remaining = remainingEvidence([first], [result[0]]);
  expect(remaining[0].item.proposal).toMatchObject({
    workedMinutes: 45,
    startAt: new Date(at("09:15")).toISOString(),
  });
  expect(() =>
    reconstructWorkday({ proposals: [...rows, rows[0]] }, [first], date, "UTC"),
  ).toThrow(/invalid/);
});

test("model times need human evidence and may not cross gaps, dates, accounts or authorized matter boundaries", () => {
  const first = evidence("first");
  const passive = evidence("passive", {
    source: "workspace",
    observation: "passive",
  });
  const agent = evidence("agent", { source: "agent", observation: "agent" });
  const timer = evidence("timer", { source: "stopwatch" });
  const later = evidence("later", {
    startAt: at("10:30"),
    endAt: at("11:00"),
    workedMinutes: 30,
  });
  const otherMatter = { ...evidence("other"), matter: other };
  const results = [
    proposal(["passive"]),
    proposal(["agent"]),
    proposal(["first"], { matterId: other.id }),
    proposal(["first", "other"]),
    proposal(["missing"]),
    proposal(["first", "later"], { endAt: at("11:00"), workedMinutes: 120 }),
    proposal(["timer"], { endAt: at("09:15"), workedMinutes: 15 }),
    proposal(["first"], {
      startAt: "2026-11-19T22:00:00Z",
      workedMinutes: 720,
    }),
  ];
  for (const row of results)
    expect(() =>
      reconstructWorkday(
        { proposals: [row] },
        [first, passive, agent, timer, later, otherMatter],
        date,
        "UTC",
      ),
    ).toThrow(/invalid/);
  const untimed = proposal(["first", "later"], {
    startAt: null,
    endAt: null,
    workedMinutes: 90,
  });
  const [grouped] = reconstructWorkday(
    { proposals: [untimed] },
    [first, later],
    date,
    "UTC",
  );
  expect(grouped.proposal).toMatchObject({
    workedMinutes: 90,
    startAt: null,
    endAt: null,
  });
});

test("guidelines and definite document terminology apply by scope and service date, retaining actual time", () => {
  const client = { id: "client", name: "Synthetic client" };
  const state = TimesheetStateSchema.parse({
    scope: "local",
    userId: "local",
    canManage: true,
    canReview: true,
    clients: [client],
    matters: [
      { ...matter, clientIds: [client.id], reference: "" },
      { ...other, clientIds: [], reference: "" },
    ],
    people: [],
    entries: [],
    products: [],
    invoices: [],
    policies: [],
    projects: [
      { id: "project", name: "First project", matterIds: [matter.id] },
      { id: "other-project", name: "Other project", matterIds: [other.id] },
    ],
  });
  const one = evidence("one", {
    documentId: "file-id",
    source: "documents",
    narrative: "Moved.docx",
    activity: "MOD",
    changeSummary: "Discussion added",
    startAt: null,
    endAt: null,
    workedMinutes: null,
  });
  const two = evidence("two", {
    documentId: "other-file",
    projectId: "other-project",
    source: "documents",
    narrative: "Revision.docx",
    activity: "MOD",
  });
  const deduped = modelEvidence(
    [one.item, two.item, evidence("work", { endAt: at("09:11") }).item],
    state,
    [
      {
        id: randomUUID(),
        name: "Worker-approved rules",
        revision: 1,
        effectiveFrom: date,
        scope: "matter",
        targetId: matter.id,
        rules: {
          language: "de",
          minimumMinutes: 15,
          maxMinutes: 40,
          incrementMinutes: 5,
          rounding: "up",
        },
      },
    ],
    [
      {
        id: randomUUID(),
        scope: "document",
        matterId: matter.id,
        documentId: "file-id",
        text: "Revision → Rekurs",
      },
    ],
    date,
  );
  expect(deduped.map((item) => item.documentTitle)).toEqual([
    "Rekurs",
    "Revision",
    undefined,
  ]);
  const result = reconstructWorkday(
    {
      proposals: [
        proposal(["one", "work"], {
          activity: "MOD",
          documentId: "file-id",
          narrative: "Amending Revision after discussion",
          endAt: at("09:11"),
          workedMinutes: 11,
        }),
      ],
    },
    deduped,
    date,
    "UTC",
  );
  expect(result[0].proposal).toMatchObject({
    narrative: "Amending Rekurs after discussion",
    workedMinutes: 11,
    chargeMinutes: 15,
    documentId: "file-id",
  });
});

test("the model receives descriptions for the authorized matter, client and exact work product only", () => {
  const priorDate = "2026-11-19";
  const entry = (id: string, changes: object = {}) => ({
    id,
    date: priorDate,
    matterId: matter.id,
    clientId: "client-a",
    workProductId: "product-a",
    activity: "MOD",
    narrative: id,
    workedMinutes: 15,
    billable: false,
    billableMinutes: 0,
    history: [],
    revision: 1,
    workerId: "worker",
    authorId: "worker",
    status: "confirmed",
    source: "manual",
    ...changes,
  });
  const state = TimesheetStateSchema.parse({
    scope: "firm",
    userId: "worker",
    canManage: false,
    canReview: false,
    clients: [
      { id: "client-a", name: "First client" },
      { id: "client-b", name: "Second client" },
    ],
    matters: [
      { ...matter, clientIds: ["client-a"], reference: "" },
      { ...other, clientIds: ["client-b"], reference: "" },
    ],
    projects: [
      { id: "project", name: "Work", matterIds: [matter.id] },
      { id: "ambiguous", name: "Ambiguous", matterIds: [matter.id, other.id] },
    ],
    policies: [
      {
        scope: "client",
        targetId: "client-a",
        effectiveFrom: priorDate,
        revision: 2,
        language: "de",
        narrativeCorrections: { Motion: "Rekurs" },
      },
      {
        scope: "client",
        targetId: "client-b",
        effectiveFrom: priorDate,
        revision: 2,
        language: "en",
        narrativeCorrections: { Motion: "Appeal" },
      },
      {
        scope: "client",
        targetId: "client-a",
        effectiveFrom: "2026-11-22",
        revision: 3,
        language: "fr",
      },
    ],
    products: [
      { id: "product-a", name: "Pleading", matterId: matter.id },
      {
        id: "product-b",
        name: "Pleading",
        matterId: other.id,
        reference: "document-b",
      },
    ],
    entries: [
      entry("Authorized history"),
      entry("Wrong client history", { clientId: "client-b" }),
      entry("Unconfirmed history", { status: "pending" }),
      entry("Other document history", { workProductId: "product-b" }),
      entry("Other matter history", { matterId: other.id }),
      entry("Later history", { date: "2026-11-21" }),
    ],
    people: [],
    invoices: [],
  });
  const item = (id: string, changes: Partial<CaptureProposal>) =>
    evidence(id, {
      source: "documents",
      narrative: "Pleading.docx",
      ...changes,
    }).item;
  const key = randomUUID(),
    hash = "a".repeat(64),
    documentId = randomUUID();
  const binding = acceptedFileProduct(
    {
      products: state.products,
      entries: [{ ...state.entries[0], groupId: key, proposalDigest: hash }],
    },
    key,
    hash,
    "worker",
  );
  expect(binding).toEqual({ matterId: matter.id, workProductId: "product-a" });
  if (!binding) throw Error("Missing authorized acceptance link");
  const fileProducts = {
    [documentId]: { [binding.matterId]: binding.workProductId },
  };
  const result = modelEvidence(
    [
      item("owned-document", { documentId }),
      item("unlinked-same-name", { documentId: "other-local-id" }),
      item("ambiguous-matter", { documentId, projectId: "ambiguous" }),
      item("removed-matter", { documentId, matterId: "hidden" }),
      item("wrong-document-scope", { documentId: "document-b" }),
    ],
    state,
    [],
    [],
    date,
    fileProducts,
  );
  expect(result).toHaveLength(4);
  expect(result[0]).toMatchObject({
    history: ["Authorized history"],
    documentTitle: "Pleading",
    item: { proposal: { workProductId: "product-a" } },
    rules: { language: "de", narrativeCorrections: { Motion: "Rekurs" } },
  });
  expect(result.slice(1).every((ref) => ref.history === undefined)).toBe(true);
  expect(
    result.find((ref) => ref.item.eventKey === "ambiguous-matter")?.rules,
  ).toBeUndefined();
  expect(
    modelEvidence(
      [item("revoked-document", { documentId })],
      { ...state, products: [] },
      [],
      [],
      date,
      fileProducts,
    )[0].history,
  ).toBeUndefined();
});

test("a save with no change evidence provides the document title but supports no invented change description or duration", () => {
  const document = {
    ...evidence("save", {
      source: "documents",
      documentId: "doc",
      narrative: "Example.docx",
      activity: "MOD",
      startAt: null,
      endAt: null,
      workedMinutes: null,
    }),
    documentTitle: "Example",
  };
  const row = proposal(["save"], {
    activity: "MOD",
    documentId: "doc",
    startAt: null,
    endAt: null,
    workedMinutes: null,
    documentTitle: "Unsupported title",
    narrative: "Amending Example to introduce two novel arguments",
  });
  const [actual] = reconstructWorkday(
    { proposals: [row] },
    [document],
    date,
    "UTC",
  );
  expect(actual.proposal).toMatchObject({
    narrative: "Amending Example",
    workedMinutes: null,
  });
  const [corrected] = reconstructWorkday(
    { proposals: [{ ...row, documentTitle: "Appeal" }] },
    [document],
    date,
    "UTC",
    ["Call this document Appeal for this day."],
  );
  expect(corrected.proposal.narrative).toBe("Amending Appeal");
});

test("a whole-day plan is followed by separate wording requests that isolate each client's rules and document history", async () => {
  const state = TimesheetStateSchema.parse({
    scope: "firm",
    userId: "worker",
    canManage: false,
    canReview: false,
    clients: [
      { id: "a", name: "First client" },
      { id: "b", name: "Second client" },
    ],
    matters: [
      { ...matter, clientIds: ["a"], reference: "" },
      { ...other, clientIds: ["b"], reference: "" },
    ],
    projects: [
      { id: "project", name: "First", matterIds: [matter.id] },
      { id: "other-project", name: "Second", matterIds: [other.id] },
    ],
    people: [],
    entries: [],
    products: [],
    policies: [],
    invoices: [],
  });
  const scoped = modelEvidence(
    [
      evidence("first", { documentId: "first-doc" }).item,
      evidence("second", {
        projectId: "other-project",
        documentId: "second-doc",
      }).item,
      evidence("unassigned", { projectId: null }).item,
    ],
    state,
    [
      {
        id: randomUUID(),
        revision: 1,
        name: "First rules",
        scope: "client",
        targetId: "a",
        effectiveFrom: date,
        rules: { instructions: "First client private guidance" },
      },
      {
        id: randomUUID(),
        revision: 1,
        name: "Second rules",
        scope: "client",
        targetId: "b",
        effectiveFrom: date,
        rules: { instructions: "Second client private guidance" },
      },
    ],
    [],
    date,
  ).map((item, index) => ({
    ...item,
    history:
      index < 2
        ? [index === 0 ? "First private history" : "Second private history"]
        : undefined,
  }));
  const prompts: string[] = [];
  const { narrative: _, ...first } = proposal(["first"], {
    documentId: "first-doc",
  });
  const { narrative: __, ...second } = proposal(["second"], {
    matterId: other.id,
    projectId: "other-project",
    documentId: "second-doc",
  });
  const { narrative: ___, ...unassigned } = proposal(["unassigned"], {
    matterId: null,
    projectId: null,
  });
  const result = await generateStructuredWorkday({
    date,
    zone: "UTC",
    skill: "Skill",
    evidence: scoped,
    transcript: [],
    async generate(prompt) {
      const index = prompts.push(prompt) - 1;
      if (index === 0)
        return JSON.stringify({ proposals: [first, second, unassigned] });
      return JSON.stringify({
        wording: [{ index: index - 1, narrative: "Meeting" }],
      });
    },
  });
  expect(result).toHaveLength(3);
  expect(prompts[0]).not.toContain("private guidance");
  expect(prompts[0]).not.toContain("private history");
  expect(prompts[1]).toContain("First client private guidance");
  expect(prompts[1]).toContain("First private history");
  expect(prompts[1]).not.toContain("Second client private guidance");
  expect(prompts[1]).not.toContain("Second private history");
  expect(prompts[2]).toContain("Second client private guidance");
  expect(prompts[2]).toContain("Second private history");
  expect(prompts[2]).not.toContain("First client private guidance");
  expect(prompts[2]).not.toContain("First private history");
  expect(prompts[3]).not.toContain("private guidance");
  expect(prompts[3]).not.toContain("private history");
});
