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
import { elapsedEvidence } from "./private-workday.js";
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

test("document drafting preserves the guideline-based model narrative instead of rebuilding it from the filename", () => {
  const narrative = "Entwerfen der Revision; Ausführungen zur Zulässigkeit und zum Verfahrensmangel.";
  for (const activity of ["DFT", "MOD"]) {
    const document = evidence("saved-file", { source: "documents", documentId: "revision-file", activity,
      narrative: "Rekurs-PR438.md", startAt: null, endAt: null, workedMinutes: null });
    document.documentTitle = "Rekurs-PR438";
    document.sourceDocumentTitle = "Rekurs-PR438";
    const timing = evidence("work", { endAt: at("09:17"), workedMinutes: 17 });
    const output = reconstructWorkday({ proposals: [proposal(["saved-file", "work"], {
      documentId: "revision-file", activity, narrative, endAt: at("09:17"), workedMinutes: 17,
    })] }, [document, timing], date, "UTC");
    expect(output[0].proposal.narrative).toBe(narrative);
    expect(output[0].proposal.workedMinutes).toBe(17);
    expect(output[0].proposal.documentId).toBe("revision-file");
  }
});

test("elapsed inference clips an appointment in progress and leaves a future plan out without modifying the day log", () => {
  const raw = [evidence("current").item, evidence("later", { startAt: at("11:00"), endAt: at("12:00") }).item];
  const cut = elapsedEvidence(raw, date, "UTC", Date.parse(at("09:20")));
  expect(cut).toHaveLength(1);
  expect(cut[0].proposal).toMatchObject({ startAt: at("09:00"), endAt: new Date(at("09:20")).toISOString(), workedMinutes: 20 });
  expect(raw[0].proposal.endAt).toBe(at("10:00"));
});

test("corroborating point actions allow a reviewable estimate without inventing clocks or measured work", () => {
  const one = evidence("save", { source: "documents", documentId: "memo", activity: "MOD", startAt: null, endAt: null, workedMinutes: null, observedAt: at("09:20") });
  const two = evidence("sent", { source: "gmail", startAt: null, endAt: null, workedMinutes: null, observedAt: at("09:27") });
  const base = proposal(["save", "sent"], { activity: "MOD", documentId: "memo", startAt: null, endAt: null, workedMinutes: null });
  const estimated = { ...base, estimatedMinutes: 5, estimateReason: "Memo amendment followed by sending the revised memo." };
  const [result] = reconstructWorkday({ proposals: [estimated] }, [one, two], date, "UTC");
  expect(result.proposal).toMatchObject({ estimatedMinutes: 5, estimateReason: estimated.estimateReason, startAt: null, endAt: null, workedMinutes: null, observedAt: at("09:20") });
  expect(result.claims?.map(claim => claim.id)).toEqual(["save", "sent"]);
  const infer = (row: typeof base, refs = [one, two]) => reconstructWorkday({ proposals: [row] }, refs, date, "UTC");
  expect(() => infer({ ...estimated, evidenceIds: ["save"] })).toThrow(/invalid/);
  expect(() => infer({ ...estimated, workedMinutes: 5 })).toThrow(/invalid/);
  expect(() => infer({ ...estimated, estimateReason: undefined })).toThrow(/invalid/);
  expect(infer({ ...base, evidenceIds: ["save"] })[0].proposal.estimatedMinutes).toBeUndefined();
});

test("delivery can contextualize a related sent reply but cannot establish work or duration", () => {
  const threadKey = "a".repeat(64);
  const source = { source: "gmail" as const, startAt: null, endAt: null, workedMinutes: null, threadKey };
  const incoming = evidence("in", { ...source, mailDirection: "received", observedAt: at("09:20") });
  const outgoing = evidence("out", { ...source, mailDirection: "sent", observedAt: at("09:27") });
  const base = proposal(["in", "out"], { activity: "EML", startAt: null, endAt: null, workedMinutes: null });
  const infer = (row: typeof base, refs = [incoming, outgoing]) => reconstructWorkday({ proposals: [row] }, refs, date, "UTC");
  expect(infer(base)).toHaveLength(1);
  expect(() => infer({ ...base, evidenceIds: ["in"] })).toThrow(/invalid/);
  expect(() => infer({ ...base, estimatedMinutes: 7, estimateReason: "Gap since delivery." })).toThrow(/invalid/);
  const unrelated = evidence("out", { ...source, mailDirection: "sent", threadKey: "b".repeat(64) });
  expect(() => infer(base, [incoming, unrelated])).toThrow(/invalid/);
  const file = evidence("file", { ...source, source: "google-drive", activity: "MOD", documentId: "cloud", observedAt: at("09:23") });
  expect(infer({ ...base, evidenceIds: ["file", "out"], documentId: "cloud", activity: "MOD", estimatedMinutes: 3,
    estimateReason: "Modified memo followed by sending it." }, [file, outgoing])[0].proposal.source).toBe("google-drive");
});

test("distinct matters retain independently evidenced overlapping clock ranges", async () => {
  const meeting = evidence("call");
  const drafting = evidence("foreground", { source: "workspace", observation: "foreground", projectId: "other-project" });
  drafting.matter = other;
  const file = evidence("save", { source: "documents", documentId: "memo", activity: "MOD", projectId: "other-project",
    startAt: null, endAt: null, workedMinutes: null, observedAt: at("09:40") });
  file.matter = other;
  const result = await generateStructuredWorkday({ skill: "", evidence: [meeting, drafting, file], date, zone: "UTC", transcript: [],
    generate: async prompt => {
      const input = JSON.parse(prompt.split("\n").at(-1)!);
      if (input.stage === "grouping") {
        expect(prompt).toContain("clock ranges overlap");
        return JSON.stringify({ proposals: [
          { ...proposal(["call"]), narrative: undefined },
          { ...proposal(["foreground", "save"], { matterId: other.id, projectId: "other-project", documentId: "memo", activity: "MOD",
            startAt: at("09:30"), endAt: at("09:45"), workedMinutes: 15 }), narrative: undefined },
        ] });
      }
      return JSON.stringify({ wording: [{ index: input.entries[0].index, narrative: input.entries[0].activity === "MOD" ? "Amending the memo" : "Meeting with client" }] });
    } });
  expect(result.map(item => [item.proposal.matterId, item.proposal.workedMinutes])).toEqual([[matter.id, 60], [other.id, 15]]);
  expect(remainingEvidence([meeting, drafting, file], [result[0]]).map(ref => ref.item.eventKey)).toEqual(["foreground", "save"]);
});

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

test("unclassified work stays editable and the server calculates validated clock intervals", () => {
  const timer = evidence("timer", { source: "stopwatch", projectId: null, activity: "", matterId: matter.id,
    startAt: at("09:00"), endAt: at("09:01"), workedMinutes: 1 });
  const row = proposal(["timer"], { activity: null, projectId: null, endAt: at("09:01"), workedMinutes: null });
  const infer = (change = {}) => reconstructWorkday({ proposals: [{ ...row, ...change }] }, [timer], date, "UTC");
  expect(infer()[0].proposal).toMatchObject({ activity: "", workedMinutes: 1, matterId: matter.id });
  expect(() => infer({ workedMinutes: 15 })).toThrow(/invalid/);
  expect(() => infer({ endAt: at("09:02") })).toThrow(/invalid/);
  expect(() => infer({ activity: "UNKNOWN" })).toThrow(/invalid/);
  const opening = evidence("opening", { source: "desktop", fileUseSource: "spotlight-last-used", projectId: null, activity: "",
    observedAt: at("09:00"), startAt: null, endAt: null, workedMinutes: null });
  expect(reconstructWorkday({ proposals: [proposal(["opening"], { projectId: null, activity: null, startAt: null,
    endAt: null, workedMinutes: null })] }, [opening], date, "UTC")[0].proposal).toMatchObject({ activity: "", workedMinutes: null });
});

test("a timer keeps the selected matter when the model combines it with a project event", () => {
  const timer = evidence("timer", { source: "stopwatch", matterId: matter.id, projectId: null });
  const meeting = evidence("meeting");
  const result = reconstructWorkday({ proposals: [proposal(["timer", "meeting"], { matterId: null })] }, [timer, meeting], date, "UTC");
  expect(result[0].proposal).toMatchObject({ source: "stopwatch", projectId: null, matterId: matter.id });
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

test("guidelines apply by scope and service date, retaining actual time", () => {
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
    date,
  );
  expect(deduped.map((item) => item.documentTitle)).toEqual([
    "Moved",
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
    narrative: "Amending Revision after discussion",
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
      date,
      fileProducts,
    )[0].history,
  ).toBeUndefined();
});

test("a file-only save keeps model wording without creating duration or applying an unrequested title", () => {
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
    narrative: "Amending Example",
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
  const [learned] = reconstructWorkday(
    { proposals: [{ ...row, documentTitle: "Extraordinary Appeal" }] },
    [{ ...document, history: ["Reviewing the Extraordinary Appeal for admissibility"] }],
    date,
    "UTC",
  );
  expect(learned.proposal).toMatchObject({ narrative: "Amending Example", workedMinutes: null });
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

test("an unsupported document activity gets one grouping repair before wording, preserving a valid stopwatch", async () => {
  const timer = evidence("stopped-timer", { source: "stopwatch", projectId: null, matterId: matter.id });
  const save = (id: string, activity: string) => evidence(id, { source: "documents", documentId: "doc",
    activity, startAt: null, endAt: null, workedMinutes: null, observedAt: at("10:20") });
  const amended = save("amendment", "MOD"), created = save("creation", "DFT");
  amended.history = ["Private matter history absent from grouping"];
  const { narrative: _timerNarrative, ...clock } = proposal(["stopped-timer"], { projectId: null });
  const { narrative: _fileNarrative, ...draft } = proposal(["amendment"], {
    activity: "DFT", documentId: "doc", startAt: null, endAt: null, workedMinutes: null,
  });
  for (const repair of [true, false]) {
    const prompts: string[] = [];
    const run = generateStructuredWorkday({ date, zone: "UTC", evidence: [created, amended, timer], skill: "", transcript: [],
      async generate(prompt) {
        prompts.push(prompt);
        const payload = JSON.parse(prompt.split("\n\n").at(-1)!);
        if (payload.stage === "wording") return JSON.stringify({ wording: payload.entries.map(({ index }: { index: number }) =>
          ({ index, narrative: index === 0 ? "Discuss the agreement" : "Draft the agreement" })) });
        return JSON.stringify({ proposals: [clock, repair && prompts.length === 2 ? { ...draft, evidenceIds: ["creation"] }
          : { ...draft, wordingHint: "Untrusted previous output marker" }] });
      } });
    if (repair) {
      const rows = await run;
      expect(rows.map(row => row.proposal)).toMatchObject([
        { source: "stopwatch", workedMinutes: 60, narrative: "Discuss the agreement" },
        { source: "documents", activity: "DFT", documentId: "doc", narrative: "Draft the agreement" },
      ]);
      expect(rows[1].claims.map(claim => claim.id)).toEqual(["creation"]);
      expect(prompts).toHaveLength(4);
    } else {
      await expect(run).rejects.toMatchObject({ code: "timesheet_model_format" });
      expect(prompts).toHaveLength(2);
    }
    expect(prompts[1]).toContain("Correct proposal 2.");
    expect(prompts[1]).toContain("DFT requires a cited DFT save");
    expect(prompts[1]).not.toContain("Untrusted previous output marker");
    expect(prompts[1]).not.toContain(amended.history![0]);
  }
});

test("format and evidence errors share the two grouping attempts and never reach wording", async () => {
  const prompts: string[] = [];
  const input = evidence("timer", { source: "stopwatch", projectId: null });
  const { narrative: _, ...partialTimer } = proposal(["timer"], { projectId: null, endAt: at("09:10"), workedMinutes: 10 });
  const run = generateStructuredWorkday({ date, zone: "UTC", evidence: [input], skill: "", transcript: [], async generate(prompt) {
    prompts.push(prompt);
    return prompts.length === 1 ? JSON.stringify({ proposals: [partialTimer] }) : "invalid JSON";
  } });
  await expect(run).rejects.toMatchObject({ code: "timesheet_model_format" });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Use each stopped timer once, with its exact full start and end.");
});
