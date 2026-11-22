import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dayInZone } from "../calendar/dates.js";
import { atomicPrivateFile, missingFile } from "../connectors/storage-state.js";
import { ApiError } from "../errors.js";
import { digest, type WorkdayEvidence, workdayEvidenceSchema } from "./private-workday.js";

const name = z.string().min(1).max(240)
  .regex(/^(?!\.|~\$)[^\\/:\p{Cc}\p{Cf}]+\.(?:docx?|odt|rtf|pdf|txt|md|xlsx?|ods|csv|pptx?|odp|pages|numbers|key)$/iu);
export const fileHistoryInput = z.strictObject({
  epoch: z.number().int().nonnegative(), date: z.iso.date(), limited: z.boolean(),
  platform: z.enum(["darwin", "win32"]), entries: z.array(z.strictObject({ name, observedAt: z.iso.datetime() })).max(200),
});
const pathFor = (profile: string, date: string) => join(profile + ".file-history", date + ".json");
export async function readFileHistory(profile: string, date: string): Promise<WorkdayEvidence[]> {
  try { return z.array(workdayEvidenceSchema).parse(JSON.parse(await readFile(pathFor(profile, date), "utf8"))); }
  catch (error) { if (missingFile(error)) return []; throw error; }
}
/** Caller holds the private profile lock and has rechecked host identity and both feature switches. */
export async function importFileHistory(profile: string, data: z.infer<typeof fileHistoryInput>, zone: string, now = Date.now()) {
  if (data.date > dayInZone(new Date(now).toISOString(), zone) ||
      data.entries.some(row => dayInZone(row.observedAt, zone) !== data.date || Date.parse(row.observedAt) > now))
    throw new ApiError(400, "desktop_history_date", "Choose a past or current date with existing use records.");
  const existing = await readFileHistory(profile, data.date);
  const known = new Set(existing.map(row => row.eventKey));
  let imported = 0;
  const fileUseSource = data.platform === "darwin" ? "spotlight-last-used" : "windows-shell-recent";
  for (const row of data.entries) {
    const eventKey = digest([fileUseSource, data.date, row.name, row.observedAt]);
    if (known.has(eventKey)) continue;
    const facts = { source: "desktop" as const, date: data.date, fileUseSource, projectId: null,
      narrative: row.name, observedAt: row.observedAt, activity: "", startAt: null, endAt: null, workedMinutes: null };
    existing.push({ eventKey, proposal: { ...facts, fileUseSource, key: randomUUID(), digest: digest([eventKey, facts]), dismissed: false } });
    known.add(eventKey);
    imported++;
  }
  if (imported) await atomicPrivateFile(pathFor(profile, data.date), JSON.stringify(existing));
  return { imported, revision: existing.length ? digest(existing.map(row => row.eventKey)) : null };
}
