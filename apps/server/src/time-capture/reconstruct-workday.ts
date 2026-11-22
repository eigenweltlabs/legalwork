import { replaceDocumentTerm } from "./document-terminology.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
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
        activity: z.string().min(1).max(100),
        narrative: z.string().trim().min(1).max(2000),
        startAt: z.iso.datetime({ offset: true }).nullable(),
        endAt: z.iso.datetime({ offset: true }).nullable(),
        workedMinutes: z.number().int().min(1).max(1440).nullable(),
      }),
    )
    .max(200),
});
export type WorkdayModelOutput = z.infer<typeof workdayModelOutputSchema>;

export function invalidModelOutput() {
  return new ApiError(
    502,
    "timesheet_model_format",
    "The model returned invalid workday suggestions. Retry or choose another model.",
  );
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
      : proposal.workedMinutes;
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
      documentTitle,
      history,
      rules,
    }) => ({
      id: eventKey,
      source: proposal.source,
      status: proposal.observation,
      projectId: proposal.projectId,
      matter: matter ?? null,
      documentId: proposal.documentId,
      documentTitle,
      priorDescriptions: history,
      rules,
      startAt: proposal.startAt,
      endAt: proposal.endAt,
      observedAt: proposal.observedAt,
      timingEvidence: Boolean(humanInterval(proposal)),
      activity: proposal.activity || null,
      title: proposal.narrative,
      changeSummary: proposal.changeSummary,
    }),
  );
}

function documentWording(
  narrative: string,
  document: ModelEvidence,
  correctedTitle?: string,
) {
  return correctedTitle && document.documentTitle
    ? replaceDocumentTerm(narrative, document.documentTitle, correctedTitle)
    : narrative;
}

export function reconstructWorkday(
  output: WorkdayModelOutput,
  evidence: ModelEvidence[],
  date: string,
  zone: string,
  chatCorrections: string[] = [],
) {
  const lookup = new Map(evidence.map((entry) => [entry.item.eventKey, entry]));
  const claimed: EvidenceClaim[] = [];
  return output.proposals.map((row) => {
    const ids = [...new Set(row.evidenceIds)].sort();
    if (ids.length !== row.evidenceIds.length) throw invalidModelOutput();
    const refs = ids.map((id) => {
      const found = lookup.get(id);
      if (!found) throw invalidModelOutput();
      return found;
    });
    const sources = refs.map((ref) => ref.item.proposal);
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
      (row.matterId &&
        (!matters.has(row.matterId) ||
          refs.some((ref) => ref.item.proposal.projectId && !ref.matter))) ||
      (row.documentId &&
        (documents.size !== 1 || !documents.has(row.documentId)))
    )
      throw invalidModelOutput();
    const policy = refs.find(
      (ref) =>
        ref.matter?.id === matterId &&
        (!row.projectId || ref.item.proposal.projectId === row.projectId),
    )?.rules;
    if (
      !Object.hasOwn(timeActivities, row.activity) &&
      !Object.hasOwn(policy?.activityLabels ?? {}, row.activity)
    )
      throw invalidModelOutput();

    const documentActivity = row.activity === "DFT" || row.activity === "MOD";
    const document = refs.find(
      (ref) =>
        ref.item.proposal.documentId === row.documentId &&
        ref.item.proposal.source === "documents" &&
        (!documentActivity || ref.item.proposal.activity === row.activity),
    );
    if (documentActivity && !document) throw invalidModelOutput();

    let clocks: Interval | undefined;
    if ((row.startAt === null) !== (row.endAt === null))
      throw invalidModelOutput();
    if (row.startAt && row.endAt) {
      clocks = { from: Date.parse(row.startAt), to: Date.parse(row.endAt) };
      if (
        clocks.to <= clocks.from ||
        clocks.to - clocks.from > 1440 * 60_000 ||
        dayInZone(row.startAt, zone) !== date ||
        dayInZone(new Date(clocks.to - 1).toISOString(), zone) !== date
      )
        throw invalidModelOutput();
    }
    const claims: EvidenceClaim[] = [];
    const measured: Interval[] = [];
    for (const { item } of refs) {
      const span = humanInterval(item.proposal);
      if (clocks && span && !intervalsOverlap(span, clocks))
        throw invalidModelOutput();
      // A stopped timer is one source occurrence. It may be used whole or left available.
      if (
        item.proposal.source === "stopwatch" &&
        (!span || !clocks || span.from !== clocks.from || span.to !== clocks.to)
      )
        throw invalidModelOutput();
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
      throw invalidModelOutput();
    const measuredMinutes = Math.round(
      combined.reduce((total, { from, to }) => total + to - from, 0) / 60_000,
    );
    if (
      measuredMinutes > 1440 ||
      (row.workedMinutes !== null && row.workedMinutes !== measuredMinutes) ||
      (clocks && row.workedMinutes !== (measuredMinutes || null)) ||
      (clocks &&
        !measuredMinutes &&
        !sources.some((proposal) => proposal.source === "stopwatch"))
    )
      throw invalidModelOutput();
    if (
      claims.some((claim) =>
        claimed.some((previous) => claimsOverlap(claim, previous)),
      )
    )
      throw invalidModelOutput();
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
    const requestedTitle = row.documentTitle;
    const scopedDocument = document && (document.matter?.id ?? null) === matterId ? document : undefined;
    const correctedTitle =
      requestedTitle &&
      chatCorrections.some((text) =>
        text.toLocaleLowerCase().includes(requestedTitle.toLocaleLowerCase()),
      )
        ? requestedTitle
        : undefined;
    const wording = scopedDocument
      ? documentWording(
          row.narrative,
          scopedDocument,
          correctedTitle,
        )
      : row.narrative;
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
      activity: row.activity,
      narrative: wording.slice(0, 2000),
      startAt: clocks ? new Date(clocks.from).toISOString() : null,
      endAt: clocks ? new Date(clocks.to).toISOString() : null,
      workedMinutes: row.workedMinutes,
    };
    proposal.chargeMinutes = proposedWorkdayCharge(proposal, policy);
    proposal.digest = proposalCommitment(proposal);
    return {
      eventKey,
      proposal,
      claims,
      generated: true,
      sourceDocumentTitle: scopedDocument?.sourceDocumentTitle?.slice(0, 500),
    } satisfies WorkdayEvidence;
  });
}
