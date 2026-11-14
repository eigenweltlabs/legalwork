import { TimeDraftSchema, type TimeDraft } from "@legalwork/types/timesheet";

// A versioned payload also travels as plain text on WebViews which drop custom MIME types.
export const timeRowMime = "application/x-legalwork-time-row+json";
const prefix = "LegalWork time entry v1\n";
const copiedRow = TimeDraftSchema.omit({ startAt: true, endAt: true, createWorkProduct: true }).strip();
export function encodeTimeRow(entry: TimeDraft) {
  // Schema parsing only copies the editable billing fields, including when the source is an approved record.
  const json = JSON.stringify(copiedRow.parse(entry));
  return { json, plain: prefix + json };
}
export function decodeTimeRow(json: string, plain: string): TimeDraft | undefined {
  const contents = json || (plain.startsWith(prefix) ? plain.slice(prefix.length) : "");
  if (!contents || contents.length > 100_000) return;
  try {
    const result = copiedRow.safeParse(JSON.parse(contents));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}
