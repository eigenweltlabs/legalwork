import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, rename, rm, stat } from "node:fs/promises";

/** Local support staging and connected documents can live on different disks.
 * Publish through a sibling on the destination disk, preserving the source if
 * copying fails or it changes while the copy is being made. */
export async function moveFileAcrossVolumes(source: string, destination: string): Promise<void> {
  try { await rename(source, destination); return; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error; }
  const before = await stat(source);
  const temporary = `${destination}.legalwork-${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const after = await stat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("The file changed during cross-volume publication; its original was preserved.");
    await rename(temporary, destination);
    await rm(source);
  } finally { await rm(temporary, { force: true }); }
}
