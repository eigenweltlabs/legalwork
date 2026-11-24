import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { captureFileSource, captureAccountSchema, type CaptureAccount } from "../back-office/timesheet-schema.js";
import { atomicPrivateFile, missingFile } from "../connectors/storage-state.js";
import { digest, workdayEvidenceSchema, type WorkdayEvidence } from "./private-workday.js";

const snapshotSchema = z.object({
  date: z.iso.date(),
  timeZone: z.string(),
  collectedAt: z.iso.datetime(),
  observations: z.array(workdayEvidenceSchema),
  failedAccounts: z.array(captureAccountSchema.extend({ reason: z.string() })).default([]),
  superseded: z.array(z.object({
    replacedAt: z.iso.datetime(),
    observation: workdayEvidenceSchema,
  })).default([]),
});

export async function readWorkdayLog(profilePath: string, date: string) {
  return snapshotSchema.parse(JSON.parse(await readFile(join(profilePath + ".day-log", date + ".json"), "utf8")));
}

function sourceIdentity(row: WorkdayEvidence) {
  // Two calendar feeds can witness the same meeting. Keep each feed's original in the local log.
  return JSON.stringify([row.eventKey, row.proposal.source, row.proposal.account, row.claims?.[1]?.id, row.proposal.mailDirection]);
}

function sourceRevision(row: WorkdayEvidence) {
  // Each provider read allocates a prospective proposal UUID. Only the observed facts identify a source revision.
  const normalized = workdayEvidenceSchema.parse(row);
  const { key, digest: proposalDigest, ...facts } = normalized.proposal;
  return digest([normalized.eventKey, facts, normalized.claims]);
}

/** Called under the profile lock. Unavailable accounts retain their last successful observations. */
export async function saveWorkdayLog(profilePath: string, date: string, timeZone: string, collectedAt: string, rows: WorkdayEvidence[],
  failedAccounts: (CaptureAccount & { reason: string })[] = [], scannedAccounts: CaptureAccount[] = []) {
  const file = join(profilePath + ".day-log", date + ".json");
  let previous: z.infer<typeof snapshotSchema> | undefined;
  try { previous = snapshotSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) { if (!missingFile(error)) throw error; }

  const previousById = new Map(previous?.observations.map(observation => [sourceIdentity(observation), observation]));
  const superseded = previous?.superseded ?? [];
  const observations = rows.map(row => {
    const old = previousById.get(sourceIdentity(row));
    if (old && sourceRevision(old) === sourceRevision(row)) {
      previousById.delete(sourceIdentity(old));
      return old;
    }
    return row;
  });
  const retained = [];
  const activeIds = new Set(rows.map(sourceIdentity));
  for (const observation of previousById.values()) {
    if (failedAccounts.some(({ provider, account }) => observation.proposal.source === provider && observation.proposal.account === account))
      retained.push(observation);
    else if (!activeIds.has(sourceIdentity(observation)) && captureFileSource(observation.proposal.source) &&
        scannedAccounts.some(({ provider, account }) => observation.proposal.source === provider && observation.proposal.account === account))
      // These APIs expose only the latest self-edit. Preserve earlier edits the app actually witnessed.
      observations.push(observation);
    else superseded.push({ replacedAt: collectedAt, observation });
  }
  const order = (a: WorkdayEvidence, b: WorkdayEvidence) => (a.proposal.startAt ?? a.proposal.observedAt ?? "")
    .localeCompare(b.proposal.startAt ?? b.proposal.observedAt ?? "") || a.eventKey.localeCompare(b.eventKey);
  observations.sort(order);
  await atomicPrivateFile(file, JSON.stringify({ date, timeZone, collectedAt, failedAccounts, observations: [...observations, ...retained].sort(order), superseded }));
  return observations;
}
