import { z } from "zod";
import { ApiError } from "../errors.js";
import { humanInterval } from "./private-workday.js";
import { applyWorkdayWording, validateWorkdayGroups, WorkdayGroupingError, type ModelEvidence } from "./reconstruct-workday.js";
import { chatWorkdayAction } from "./chat-workday-schema.js";

type Publish = Extract<z.infer<typeof chatWorkdayAction>, { action: "publish" }>;

export const workdayChatInstructions = [
  "Reconstruct the timekeeper's work from the whole day. Group observations by matter and the legal work they support. Use the completed task, sent communication, meeting subject or documented change to describe the work. File opens and application focus can corroborate its subject and duration.",
  "Write one plain billing sentence naming what the person did and what it concerned. Omit file extensions, app names, internal labels and placeholders. A filename alone cannot prove an edit or outcome. Leave activity with no identifiable work in the log.",
  "Consolidate related steps toward one deliverable. Count overlapping evidence for that work once and exclude breaks. Keep independent work separate even when its clock ranges overlap. Check existing entries and suggestions before publishing. Keep worker edits intact.",
  "Before publishing for a matter, call guidelines for its ID and date. Apply its current wording and time rules and include the receipt. Where there are no custom guidelines use its effective billing policy.",
  "Choose an activity code only when supported. Drafting (DFT) and amending (MOD) require a matching saved document and stable document ID. Omit the code when the evidence is insufficient.",
  "Publish each complete suggestion or related batch as you go. Use observation IDs from this read. The server infers supported matters and measured minutes. Omit clock fields to use all cited intervals. Use the returned revision on the next call. Set complete on the last publish, even if there are no new suggestions. Remove superseded unedited suggestions by key when needed. Never book time.",
].join("\n");

export function chatSuggestions(rows: Publish["suggestions"], evidence: ModelEvidence[], date: string, zone: string) {
  const lookup = new Map(evidence.map((ref, index) => ["e" + (index + 1), ref]));
  const prepared = rows.map(row => {
    const refs = row.evidence.map(id => {
      const ref = lookup.get(id);
      if (!ref) throw new ApiError(400, "workday_evidence", "Read the day and use its observation IDs.");
      return ref;
    });
    if (/\[(?:review fixture|timekeeping test|filename|application|placeholder)\]/i.test(row.narrative) ||
        /^(?:used|opened)\s+.+\.(?:docx?|xlsx?|pdf|pptx?)\b/i.test(row.narrative))
      throw new ApiError(400, "workday_wording", "Describe the work in client-facing language. Remove internal labels and raw filenames.");
    const spans = refs.flatMap(({ item }) => humanInterval(item.proposal) ?? []).sort((a,b) => a.from - b.from);
    let until = 0, duration = 0, contiguous = true;
    for (const span of spans) {
      if (until && span.from > until) contiguous = false;
      duration += Math.max(0, span.to - Math.max(span.from, until));
      until = Math.max(until, span.to);
    }
    const timed = row.startAt !== undefined || row.endAt !== undefined;
    const matter = refs.find(ref => ref.matter)?.matter;
    const projects = new Set(refs.flatMap(({ item }) => item.proposal.projectId ?? []));
    const documents = new Set(refs.flatMap(({ item }) => item.proposal.documentId ?? []));
    return {
      evidenceIds: refs.map(ref => ref.item.eventKey), narrative: row.narrative,
      matterId: matter?.id ?? null, projectId: projects.size === 1 ? [...projects][0] : null, documentId: documents.size === 1 ? [...documents][0] : null,
      activity: row.activity ?? null,
      startAt: timed ? row.startAt ?? null : contiguous && spans.length ? new Date(spans[0].from).toISOString() : null,
      endAt: timed ? row.endAt ?? null : contiguous && spans.length ? new Date(until).toISOString() : null,
      workedMinutes: !timed && !contiguous ? Math.round(duration / 60_000) || null : null,
      estimatedMinutes: row.estimatedMinutes, estimateReason: row.estimateReason,
    };
  });
  try {
    return validateWorkdayGroups(prepared, evidence, date, zone).map((group, i) => applyWorkdayWording(group, rows[i].narrative));
  } catch (error) {
    if (error instanceof WorkdayGroupingError) throw new ApiError(400, "workday_evidence", error.repair);
    throw error;
  }
}
