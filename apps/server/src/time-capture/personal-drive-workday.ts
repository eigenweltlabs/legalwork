import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CaptureAccount } from "@legalwork/types/time-capture";
import type { ConnectorRequest } from "../connectors/request.js";
import { atomicPrivateFile, missingFile } from "../connectors/storage-state.js";
import { ApiError } from "../errors.js";
import { withFileWriteLock } from "../file-write-lock.js";
import type { ServerConfig } from "../types.js";
import { personalDriveChanges } from "./file-workday.js";
import { workdayEvidenceSchema } from "./private-workday.js";
import { personalDriveConsent } from "./routes.js";

const saved = z.object({
  epoch: z.number(), cursor: z.string(), days: z.record(z.iso.date(), z.record(z.string(), workdayEvidenceSchema)),
});

/** Keep the opaque cursor and dated observations together. A retry cannot advance past a failed write. */
export async function observedPersonalDrive(config: ServerConfig, account: CaptureAccount, date: string, zone: string,
  request: ConnectorRequest, signal: AbortSignal, onName?: (name: string) => void) {
  const before = await personalDriveConsent(config, account);
  const file = join(before.path + ".drive-changes", account.account + ".json");
  return withFileWriteLock(file, async () => {
    let previous: z.infer<typeof saved> | undefined;
    try { previous = saved.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if (!missingFile(error)) throw error; }
    // A fresh opt-in begins at the next scan. Never backfill a disabled interval.
    const cursor = previous?.epoch === before.epoch ? previous.cursor : undefined;
    let expired = false;
    const delta = await personalDriveChanges(account, cursor, zone, request, signal, onName).catch(async error => {
      if (!cursor || !(error instanceof ApiError) || error.code !== "onedrive_cursor_expired") throw error;
      expired = true;
      return personalDriveChanges(account, undefined, zone, request, signal, onName);
    });
    const days = previous?.days ?? {};
    for (const row of delta.rows) (days[row.proposal.date] ??= {})[row.eventKey] = row;
    await withFileWriteLock(before.path, async () => {
      signal.throwIfAborted();
      const current = await personalDriveConsent(config, account);
      if (current.path !== before.path || current.epoch !== before.epoch)
        throw new ApiError(409, "private_workday_changed", "The personal drive source changed.");
      await atomicPrivateFile(file, JSON.stringify({ epoch: current.epoch, cursor: delta.cursor, days }));
    });
    if (expired) throw new ApiError(409, "onedrive_cursor_expired", "OneDrive Personal lost its change history. Tracking has restarted from this scan.");
    return Object.values(days[date] ?? {});
  });
}
