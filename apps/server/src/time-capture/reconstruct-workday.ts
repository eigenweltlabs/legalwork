import { replaceDocumentTerm } from "./document-terminology.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  captureFileSource,
  proposedCharge,
  proposedStopwatchCharge,
  timeActivities,
  type resolveTimePolicy,
} from "../back-office/timesheet-schema.js";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { dayInZone } from "../calendar/dates.js";
import { ApiError } from "../errors.js";
import { proposalCommitment } from "./original.js";
import {
  claimsFor,
  claimsOverlap,
  digest,
  humanInterval,
  intervalsOverlap,
  type EvidenceClaim,
  type Interval,
  type WorkdayEvidence,
} from "./private-workday.js";

export type DraftRules = Pick<
  ReturnType<typeof resolveTimePolicy>,
  | "language"
  | "actionWords"
  | "narrativeCorrections"
  | "narrativeExample"
  | "actionFirst"
  | "activityLabels"
  | "maxMinutes"
  | "activityLimits"
  | "incrementMinutes"
  | "enforceIncrement"
  | "rounding"
  | "stopwatchRoundUp"
> & { minimumMinutes: number; guidelineInstructions?: string[] };

export type ModelEvidence = {
  item: WorkdayEvidence;
  matter?: { id: string; name: string };
  matterMatch?: "reference" | "title";
  sourceDocumentTitle?: string;
  documentTitle?: string;
  history?: string[];
  rules?: DraftRules;
};

const reference = z.string().min(1).max(200);
export const workdayModelOutputSchema = z.strictObject({
  proposals: z
    .array(
      z.strictObject({
        evidenceIds: z.array(reference).min(1).max(200),
        matterId: reference.nullable(),
        documentId: reference.nullable(),
        documentTitle: z.string().trim().min(1).max(240).optional(),
        projectId: reference.nullable(),
        activity: z.string().min(1).max(100).nullable(),
        narrative: z.string().trim().min(1).max(2000),
        startAt: z.iso.datetime({ offset: true }).nullable(),
        endAt: z.iso.datetime({ offset: true }).nullable(),
        workedMinutes: z.number().int().min(1).max(1440).nullable(),
        estimatedMinutes: z.number().int().min(1).max(1440).optional(),
        estimateReason: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .max(200),
});
export type WorkdayModelOutput = z.infer<typeof workdayModelOutputSchema>;

const invalidSuggestionsMessage = "The model returned invalid workday suggestions. Retry or choose another model.";
export function invalidModelOutput() {
  return new ApiError(502, "timesheet_model_format", invalidSuggestionsMessage);
}

function union(intervals: Interval[]) {
  const merged: Interval[] = [];
  for (const next of intervals.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = merged.at(-1);
    if (last && next.from <= last.to) last.to = Math.max(last.to, next.to);
    else merged.push({ ...next });
  }
  return merged;
}

export function remainingEvidence(
  evidence: ModelEvidence[],
  protectedItems: WorkdayEvidence[],
) {
  const blocked = protectedItems.flatMap(claimsFor);
  return evidence.flatMap((ref) => {
    const claims = claimsFor(ref.item);
    const conflicts = blocked.filter((claim) =>
      claims.some((other) => claimsOverlap(claim, other)),
    );
    if (!conflicts.length) return [ref];
    const proposal = ref.item.proposal;
    const span = humanInterval(proposal);
    if (
      !span ||
      conflicts.some(
        (claim) =>
          claim.from === null ||
          claim.to === null ||
          claim.source === "stopwatch" ||
          claims.some(
            (other) =>
              other.id === claim.id &&
              other.observationStart !== claim.observationStart,
          ),
      )
    )
      return [];
    let available = [span];
    for (const { from, to } of conflicts) {
      if (from === null || to === null) continue;
      available = available.flatMap((window) => {
        if (to <= window.from || from >= window.to) return [window];
        return [
          { from: window.from, to: Math.min(window.to, from) },
          { from: Math.max(window.from, to), to: window.to },
        ].filter((slice) => slice.to - slice.from >= 30_000);
      });
    }
    return available.map(({ from, to }) => ({
      ...ref,
      item: {
        ...ref.item,
        eventKey: digest([ref.item.eventKey, from, to]),
        claims: claims.map((claim) => ({ ...claim, from, to })),
        proposal: {
          ...proposal,
          startAt: new Date(from).toISOString(),
          endAt: new Date(to).toISOString(),
          workedMinutes: Math.round((to - from) / 60_000),
        },
      },
    }));
  });
}

export function proposedWorkdayCharge(
  proposal: CaptureProposal,
  rules?: DraftRules,
) {
  if (!rules) return;
  const clocks =
    proposal.startAt && proposal.endAt
      ? (Date.parse(proposal.endAt) - Date.parse(proposal.startAt)) / 60_000
      : null;
  const minutes =
    proposal.source === "stopwatch" && clocks !== null
      ? clocks
      : proposal.workedMinutes ?? proposal.estimatedMinutes ?? null;
  if (minutes === null || minutes <= 0) return;
  const maxMinutes =
    rules.activityLimits[proposal.activity] ?? rules.maxMinutes;
  if (rules.minimumMinutes > maxMinutes) return;
  const step =
    rules.enforceIncrement || proposal.source === "stopwatch"
      ? rules.incrementMinutes
      : 1;
  const lower = Math.ceil(rules.minimumMinutes / step) * step,
    upper = Math.floor(maxMinutes / step) * step;
  if (lower > upper) return;
  const charge =
    proposal.source === "stopwatch"
      ? proposedStopwatchCharge(minutes, rules)
      : proposedCharge(minutes, rules);
  if (step > 1 && charge % step !== 0 && charge >= lower && charge <= upper)
    return;
  return Math.min(upper, Math.max(lower, charge));
}

export function modelInput(evidence: ModelEvidence[]) {
  return evidence.map(
    ({
      item: { eventKey, proposal },
      matter,
      matterMatch,
      documentTitle,
      history,
      rules,
    }) => ({
      id: eventKey,
      source: proposal.source,
      status: proposal.observation,
      projectId: proposal.projectId,
      matter: matter ?? null,
      matterMatch,
      documentId: proposal.documentId,
      documentTitle,
      priorDescriptions: history,
      rules,
      startAt: proposal.startAt,
      endAt: proposal.endAt,
      observedAt: proposal.observedAt,
      desktopContext: proposal.desktopContext,
      fileUseSource: proposal.fileUseSource,
      mailDirection: proposal.mailDirection,
      threadKey: proposal.threadKey,
      timingEvidence: Boolean(humanInterval(proposal)),
      activity: proposal.activity || null,
      title: proposal.narrative,
      changeSummary: proposal.changeSummary,
    }),
  );
}

const groupingRepairs = {
  references: "Use each cited evidence ID once in the proposal and choose IDs present in the input.",
  receipt: "Include received email only with a sent reply from the same thread, or omit the delivery.",
  scope: "Use matter, project and document IDs supported by the cited observations. Separate different matters or projects and use null for unknown assignments.",
  activity: "Choose an activity from the supplied codes or use null.",
  document: "DFT requires a cited DFT save and MOD requires a cited MOD save for the same documentId. If only a MOD save is cited, use MOD. To propose DFT, cite its matching DFT save. Without a matching save, choose another supported activity or null.",
  clocks: "Use a positive clock interval entirely within the selected local day and covered by the cited timed evidence. Keep both clocks null if their range is unsupported.",
  stopwatch: "Use each stopped timer once, with its exact full start and end. Keep the timer separate when another observation does not match that range.",
  estimate: "Only estimate unmeasured time with corroborating dated human actions or a substantive change summary. Supply estimatedMinutes and estimateReason together with null clocks and workedMinutes, or omit the estimate.",
  minutes: "Use only the duration covered by the cited clock intervals. Leave workedMinutes null for the server to calculate a clocked row.",
  reuse: "A portion of a source may be claimed only once. Merge duplicate claims or use nonoverlapping portions. Independent evidence can support parallel work.",
};

export class WorkdayGroupingError extends ApiError {
  readonly repair: string;
  constructor(index: number, issue: keyof typeof groupingRepairs) {
    super(502, "timesheet_model_format", invalidSuggestionsMessage);
    this.repair = `Correct proposal ${index + 1}. ${groupingRepairs[issue]} Return the complete grouping, keeping other supported proposals.`;
  }
}

export function validateWorkdayGroups(
  rows: Omit<WorkdayModelOutput["proposals"][number], "narrative" | "documentTitle">[],
  evidence: ModelEvidence[], date: string, zone: string,
) {
  const lookup = new Map(evidence.map((entry) => [entry.item.eventKey, entry]));
  const claimed: EvidenceClaim[] = [];
  return rows.map((row, index) => {
    const ids = [...new Set(row.evidenceIds)].sort();
    if (ids.length !== row.evidenceIds.length) throw new WorkdayGroupingError(index, "references");
    const refs = ids.map((id) => {
      const found = lookup.get(id);
      if (!found) throw new WorkdayGroupingError(index, "references");
      return found;
    });
    const sources = refs.map((ref) => ref.item.proposal);
    if (sources.some(p => p.mailDirection === "received" && !sources.some(other =>
      other.mailDirection === "sent" && other.threadKey && other.threadKey === p.threadKey))) throw new WorkdayGroupingError(index, "receipt");
    const timer = refs.find(ref => ref.item.proposal.source === "stopwatch");
    const matterId = timer?.matter?.id ?? row.matterId;
    const projects = new Set(
      sources.flatMap((proposal) =>
        proposal.projectId ? [proposal.projectId] : [],
      ),
    );
    const matters = new Set(
      refs.flatMap((ref) => (ref.matter ? [ref.matter.id] : [])),
    );
    const documents = new Set(
      sources.flatMap((proposal) =>
        proposal.documentId ? [proposal.documentId] : [],
      ),
    );
    if (
      projects.size > 1 ||
      matters.size > 1 ||
      (row.projectId && !projects.has(row.projectId)) ||
      (row.matterId && !matters.has(row.matterId)) ||
      (matterId && refs.some(({ item, matter }) => !matter && (item.proposal.projectId || item.proposal.source === "desktop"))) ||
      (row.documentId &&
        (documents.size !== 1 || !documents.has(row.documentId)))
    )
      throw new WorkdayGroupingError(index, "scope");
    const policy = refs.find(
      (ref) =>
        ref.matter?.id === matterId &&
        (!row.projectId || ref.item.proposal.projectId === row.projectId),
    )?.rules;
    if (
      row.activity !== null &&
      !Object.hasOwn(timeActivities, row.activity) &&
      !Object.hasOwn(policy?.activityLabels ?? {}, row.activity)
    )
      throw new WorkdayGroupingError(index, "activity");

    const documentActivity = row.activity === "DFT" || row.activity === "MOD";
    const document = refs.find(
      (ref) =>
        ref.item.proposal.documentId === row.documentId &&
        (ref.item.proposal.source === "documents" || captureFileSource(ref.item.proposal.source)) &&
        (!documentActivity || ref.item.proposal.activity === row.activity),
    );
    if (documentActivity && !document) throw new WorkdayGroupingError(index, "document");

    let clocks: Interval | undefined;
    if ((row.startAt === null) !== (row.endAt === null))
      throw new WorkdayGroupingError(index, "clocks");
    if (row.startAt && row.endAt) {
      clocks = { from: Date.parse(row.startAt), to: Date.parse(row.endAt) };
      if (
        clocks.to <= clocks.from ||
        clocks.to - clocks.from > 1440 * 60_000 ||
        dayInZone(row.startAt, zone) !== date ||
        dayInZone(new Date(clocks.to - 1).toISOString(), zone) !== date
      )
        throw new WorkdayGroupingError(index, "clocks");
    }
    const claims: EvidenceClaim[] = [];
    const measured: Interval[] = [];
    for (const { item } of refs) {
      const span = humanInterval(item.proposal);
      if (clocks && span && !intervalsOverlap(span, clocks))
        throw new WorkdayGroupingError(index, "clocks");
      // A stopped timer is one source occurrence. It may be used whole or left available.
      if (
        item.proposal.source === "stopwatch" &&
        (!span || !clocks || span.from !== clocks.from || span.to !== clocks.to)
      )
        throw new WorkdayGroupingError(index, "stopwatch");
      const portion =
        clocks && span
          ? {
              from: Math.max(clocks.from, span.from),
              to: Math.min(clocks.to, span.to),
            }
          : span;
      if (portion) measured.push(portion);
      claims.push(
        ...claimsFor(item).map((claim) => ({
          ...claim,
          from: portion?.from ?? null,
          to: portion?.to ?? null,
        })),
      );
    }
    const combined = union(measured);
    if (
      clocks &&
      (combined.length !== 1 ||
        combined[0].from !== clocks.from ||
        combined[0].to !== clocks.to)
    )
      throw new WorkdayGroupingError(index, "clocks");
    const measuredMinutes = Math.round(
      combined.reduce((total, { from, to }) => total + to - from, 0) / 60_000,
    );
    if (row.estimatedMinutes !== undefined || row.estimateReason !== undefined) {
      const pointSources = sources.filter(source => source.observedAt && source.mailDirection !== "received" &&
        (["documents", "tasks", "gmail", "outlook"].includes(source.source) || captureFileSource(source.source)));
      const distinctTimes = new Set(pointSources.map(source => source.observedAt));
      if (!row.estimatedMinutes || !row.estimateReason || row.workedMinutes !== null || clocks || measured.length ||
          (distinctTimes.size < 2 && !pointSources.some(source => source.changeSummary)))
        throw new WorkdayGroupingError(index, "estimate");
    }
    if (
      measuredMinutes > 1440 ||
      (row.workedMinutes !== null && row.workedMinutes !== measuredMinutes) ||
      (clocks &&
        !measuredMinutes &&
        !sources.some((proposal) => proposal.source === "stopwatch"))
    )
      throw new WorkdayGroupingError(index, "minutes");
    if (
      claims.some((claim) =>
        claimed.some((previous) => claimsOverlap(claim, previous)),
      )
    )
      throw new WorkdayGroupingError(index, "reuse");
    claimed.push(...claims);

    const origin =
      timer ??
      document ??
      refs.find(
        (ref) =>
          ref.item.proposal.projectId === row.projectId &&
          row.projectId !== null,
      ) ??
      refs[0];
    const { source, account, observation } = origin.item.proposal;
    const eventKey = digest([
      "workday-claim-v1",
      claims.map(({ id, from, to }) => [id, from, to]),
    ]);
    const scopedDocument = document && (document.matter?.id ?? null) === matterId ? document : undefined;
    const proposal: CaptureProposal = {
      key: randomUUID(),
      digest: "",
      date,
      source,
      account,
      observation,
      dismissed: false,
      projectId: timer ? null : row.projectId ?? [...projects][0] ?? null,
      matterId: matterId ?? undefined,
      documentId: row.documentId ?? undefined,
      workProductId: row.documentId
        ? scopedDocument?.item.proposal.workProductId
        : undefined,
      activity: row.activity ?? "",
      narrative: "",
      startAt: clocks ? new Date(clocks.from).toISOString() : null,
      endAt: clocks ? new Date(clocks.to).toISOString() : null,
      workedMinutes: clocks ? measuredMinutes || null : row.workedMinutes,
      ...(row.estimatedMinutes !== undefined ? { estimatedMinutes: row.estimatedMinutes, estimateReason: row.estimateReason,
        observedAt: origin.item.proposal.observedAt } : {}),
    };
    proposal.chargeMinutes = proposedWorkdayCharge(proposal, policy);
    const item = { eventKey, proposal, claims, generated: true,
      sourceDocumentTitle: scopedDocument?.sourceDocumentTitle?.slice(0, 500) } satisfies WorkdayEvidence;
    return { item, documentTitle: scopedDocument?.documentTitle };
  });
}

export function applyWorkdayWording(
  group: ReturnType<typeof validateWorkdayGroups>[number], narrative: string, correctedTitle?: string,
) {
  const wording = group.documentTitle && correctedTitle ? replaceDocumentTerm(narrative, group.documentTitle, correctedTitle) : narrative;
  const proposal = { ...group.item.proposal, narrative: wording.slice(0, 2000) };
  proposal.digest = proposalCommitment(proposal);
  return { ...group.item, proposal };
}

export function reconstructWorkday(
  output: WorkdayModelOutput, evidence: ModelEvidence[], date: string, zone: string, chatCorrections: string[] = [],
) {
  const groups = validateWorkdayGroups(output.proposals, evidence, date, zone);
  return groups.map((group, index) => {
    const { narrative, documentTitle } = output.proposals[index];
    const authorized = documentTitle && chatCorrections.some(text => text.toLocaleLowerCase().includes(documentTitle.toLocaleLowerCase()));
    return applyWorkdayWording(group, narrative, authorized ? documentTitle : undefined);
  });
}
