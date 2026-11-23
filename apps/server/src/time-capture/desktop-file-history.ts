import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { missingFile } from "../connectors/storage-state.js";
import { type WorkdayEvidence, workdayEvidenceSchema } from "./private-workday.js";

// Earlier desktop builds imported file-use metadata into the private profile.
const pathFor = (profile: string, date: string) => join(profile + ".file-history", date + ".json");
export async function readFileHistory(profile: string, date: string): Promise<WorkdayEvidence[]> {
  try { return z.array(workdayEvidenceSchema).parse(JSON.parse(await readFile(pathFor(profile, date), "utf8"))); }
  catch (error) { if (missingFile(error)) return []; throw error; }
}
