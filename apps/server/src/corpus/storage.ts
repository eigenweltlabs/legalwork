import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { atomicJson, missing, readJson, serialized, within } from "../reviews/storage.js";
import { SavedCorpusJobSchema, type SavedCorpusJob } from "./schema.js";

/** Keep job history in the project, alongside reviews, without storing document text. */
export class CorpusStore {
  constructor(private workspace: string) {}
  private async path(id: string) {
    const root = await realpath(this.workspace);
    let directory = root;
    for (const segment of [".opencode", "legalwork", "jev-search"]) {
      directory = join(directory, segment);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!within(root, await realpath(directory))) throw new ApiError(403, "corpus_path", "Search history must stay in the project.");
    }
    return join(directory, `${z.string().uuid().parse(id)}.json`);
  }
  async read(id: string) {
    try { return await readJson(await this.path(id), SavedCorpusJobSchema); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async write(job: SavedCorpusJob) {
    const path = await this.path(job.id);
    // Snapshot before waiting for another writer; a later checkpoint cannot be overwritten by an older one.
    const snapshot = SavedCorpusJobSchema.parse(job);
    await serialized(path, () => atomicJson(path, snapshot));
  }
}
