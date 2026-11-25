import type { BackOfficeValue } from "@legalwork/types/back-office";
import { captureChargeMinutes, draftRules, effectiveWorkdayGuidelines, workdayBillableMinutes, type WorkdayGuideline, type CaptureProposal } from "@legalwork/types/time-capture";
import { proposedCharge, resolveTimePolicy, soleMatterClient, type TimesheetState } from "@legalwork/types/timesheet";
import { suggestBillingNarrative } from "@legalwork/types/billing-narrative";
import { currentLocale, t } from "@/i18n";
import { CalendarDaySchema } from "@legalwork/types/calendar";
import { calendarDay } from "../calendar/calendar-format";

type Values = Record<string, BackOfficeValue>;

/** Date-only records must never shift to the preceding day in western time zones. */
export function timeRecordDate(value: BackOfficeValue | undefined, serviceDate?: BackOfficeValue): string {
  const day = CalendarDaySchema.safeParse(serviceDate);
  if (day.success) return day.data;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  if (CalendarDaySchema.safeParse(value).success || /[+-]\d{2}:\d{2}$/.test(value)) return value.slice(0, 10);
  return calendarDay(new Date(value));
}

/** Older directories derive their service date from the first ten characters of the start time. */
export function localRecordInstant(value: string) {
  const instant = new Date(value);
  const offset = -instant.getTimezoneOffset();
  const local = new Date(instant.getTime() + offset * 60_000).toISOString().slice(0, -1);
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return local + (offset >= 0 ? "+" : "-") + hours + ":" + minutes;
}

export function proposalAssignment(proposal: CaptureProposal, state: TimesheetState) {
  const project = proposal.source === "stopwatch" ? undefined : state.projects.find(project => project.id === proposal.projectId);
  const matter = state.matters.find(matter => matter.id === proposal.matterId)
    ?? (project?.matterIds.length === 1 ? state.matters.find(matter => matter.id === project.matterIds[0]) : undefined);
  const clientId = soleMatterClient(matter, state.clients);
  const policy = resolveTimePolicy(state.policies, clientId, matter?.id ?? "", proposal.date, project?.id);
  return { project, matter, clientId, policy };
}

export function documentDraftWording(proposal: CaptureProposal, generated: Pick<CaptureProposal, "narrative" | "activity"> | undefined, state: TimesheetState) {
  const { activity } = proposal;
  if (proposal.source !== "documents") return generated;
  if (proposal.parentDigest) return undefined;
  if (activity !== "DFT" && activity !== "MOD") return generated;
  // A raw project save provides a title and an action. It supplies no evidence about specific edits.
  const title = proposal.narrative.replace(/\.(?:docx?|odt|rtf|md|txt|xlsx?|ods|pptx?|odp|pdf)$/i, "");
  const { policy } = proposalAssignment(proposal, state);
  const candidate = generated?.activity === activity ? generated.narrative.trim() : "";
  let narrative = candidate || proposal.narrative;
  if (title !== proposal.narrative && title.trim()) {
    const language = policy.language.trim().toLowerCase() || currentLocale();
    const locale = /^(de|german)/.test(language) ? "de" : /^en/.test(language) ? "en" : undefined;
    const defaultWord = locale && t(activity === "DFT" ? "timesheets.ledger.activity.DFT" : "timesheets.ledger.activity.MOD", locale);
    const verb = policy.actionWords[activity] || defaultWord;
    if (verb) {
      const opening = [verb, defaultWord].find(word => word && candidate.toLowerCase().startsWith(word.toLowerCase() + " "));
      const subject = opening ? candidate.slice(opening.length).trim() : title.replace(/_/g, " ").trim();
      narrative = verb + " " + subject;
    }
  }
  const result = { activity, narrative };
  return { activity, narrative: suggestBillingNarrative(result, policy) ?? narrative };
}

export function proposalValues(proposal: CaptureProposal, state: TimesheetState, guidelines: WorkdayGuideline[] = []): Values {
  const { matter, clientId, policy } = proposalAssignment(proposal, state);
  const duration = captureChargeMinutes(proposal);
  const stopwatch = proposal.source === "stopwatch";
  let charge = proposal.chargeMinutes ?? (duration === null ? null : proposedCharge(duration, policy));
  if (stopwatch) {
    charge = null;
    if (matter && duration !== null) {
      const date = proposal.date;
      const rules = draftRules(state, guidelines, matter, date, undefined, clientId);
      const localGuidance = effectiveWorkdayGuidelines(state, guidelines, { date, clientId, matterId: matter.id });
      charge = (localGuidance.length ? undefined : proposal.chargeMinutes) ?? workdayBillableMinutes(duration, rules, proposal.activity, true) ?? null;
    }
  }
  const narrative = isUntitledStopwatch(proposal) ? "" : proposal.narrative;
  return { name: narrative.slice(0, 240), billingNarrative: narrative, status: "Draft", matter: matter?.id ?? null, client: clientId || null,
    serviceDate: proposal.date, startedAt: proposal.startAt ?? proposal.date, endedAt: proposal.endAt,
    recordedMinutes: stopwatch && duration !== null ? Math.round(duration) : proposal.workedMinutes ?? proposal.estimatedMinutes ?? null,
    billableMinutes: charge,
  };
}

export function isUntitledStopwatch(proposal: CaptureProposal) {
  return proposal.source === "stopwatch" && !proposal.suggested && !proposal.activity && !proposal.parentDigest && (!proposal.narrative.trim() || proposal.narrative === "Stopwatch");
}
