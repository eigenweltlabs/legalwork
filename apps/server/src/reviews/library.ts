import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { runtimeStorageDir } from "../runtime-opencode-config-store.js";
import { firmHubPromptSets } from "../firm-hub.js";
import type { ServerConfig } from "../types.js";
import { ReviewLibraryEntrySchema, SaveReviewLibrarySchema, reviewLibraryKind, type ReviewLibraryEntry } from "./schema.js";

/** A prompt set as the firm's Team library carries it (payload `set`). */
export const SharedReviewSetSchema = SaveReviewLibrarySchema.pick({ name: true, description: true, tags: true, language: true, columns: true });
import { atomicJson, missing, readJson, serialized } from "./storage.js";

import { builtinReviewLibrary } from "./builtin-library.js";
export { builtinReviewLibrary } from "./builtin-library.js";

export class ReviewLibrary {
  constructor(private config: ServerConfig) {}
  private async path() {
    const root = join(runtimeStorageDir(this.config), "review-library");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return join(await realpath(root), "entries.json");
  }
  private async personal() {
    try { return await readJson(await this.path(), z.array(ReviewLibraryEntrySchema)); }
    catch (error) { if (missing(error)) return []; throw error; }
  }
  async list(language: "en" | "de") { return [...builtinReviewLibrary(language), ...await this.firm(), ...await this.personal()]; }
  /** The firm's prompt sets (firm-hub.ts): its own, like the built-in ones, customized only as a copy. */
  private async firm(): Promise<ReviewLibraryEntry[]> {
    return (await firmHubPromptSets(this.config)).flatMap(({ id, version, payload }) => {
      const shared = z.object({ set: SharedReviewSetSchema }).safeParse(payload);
      if (!shared.success) return [];
      const entryId = `firm:${id}`;
      return [{
        ...shared.data.set, kind: "set" as const, id: entryId, version, source: "firm" as const, updatedAt: 0, hubItemId: id,
        columns: shared.data.set.columns.map(column => ({ ...column, libraryId: entryId, libraryVersion: version, libraryColumnKey: column.key })),
      }];
    });
  }
  async save(raw: unknown) {
    const input = SaveReviewLibrarySchema.parse(raw);
    return serialized(await this.path(), async () => {
      const entries = await this.personal();
      const existing = input.id ? entries.find(item => item.id === input.id) : undefined;
      if (input.id && !existing) throw new ApiError(404, "review_library_not_found", "Saved prompt not found.");
      if (existing && existing.version !== input.version) throw new ApiError(409, "review_library_conflict", "This saved prompt has changed. Reload it before saving.");
      const kind = input.kind ?? (existing ? reviewLibraryKind(existing) : reviewLibraryKind(input));
      if (kind === "prompt" && input.columns.length !== 1) throw new ApiError(400, "review_library_kind", "A prompt contains one column. Save multiple columns as a set.");
      return this.write(entries, existing, { ...input, kind, hubItemId: existing?.hubItemId });
    });
  }
  /** A set from the firm's Team library (its payload), as the user's own copy; installed again, that copy is updated. */
  async installShared(hubItemId: string, payload: unknown) {
    const shared = z.object({ set: SharedReviewSetSchema }).safeParse(payload);
    if (!shared.success) throw new ApiError(400, "invalid_review_set", "The shared prompt set is not valid.");
    const input = shared.data.set;
    return serialized(await this.path(), async () => {
      const entries = await this.personal();
      return this.write(entries, entries.find(item => item.hubItemId === hubItemId), { ...input, kind: "set", hubItemId });
    });
  }
  private async write(entries: ReviewLibraryEntry[], existing: ReviewLibraryEntry | undefined, input: Omit<ReviewLibraryEntry, "id" | "version" | "source" | "updatedAt">) {
    const id = existing?.id ?? randomUUID(), version = (existing?.version ?? 0) + 1;
    const entry: ReviewLibraryEntry = { ...input, id, version, source: "personal", updatedAt: Date.now(), columns: input.columns.map(column => ({ ...column, libraryId: id, libraryVersion: version, libraryColumnKey: column.key })) };
    await atomicJson(await this.path(), [...entries.filter(item => item.id !== id), entry]);
    return entry;
  }
  /** One of the user's own sets, as it is shared with the firm: without this computer's ids. */
  async shareable(id: string) {
    const entry = (await this.personal()).find(item => item.id === id);
    if (!entry) throw new ApiError(404, "review_library_not_found", "Saved prompt not found.");
    if (reviewLibraryKind(entry) !== "set") throw new ApiError(400, "review_library_share_set", "Only prompt sets can be shared with the firm.");
    return SharedReviewSetSchema.parse({ ...entry, columns: entry.columns.map(({ libraryId: _id, libraryVersion: _version, libraryColumnKey: _key, ...column }) => column) });
  }
  async remove(id: string) {
    z.string().uuid().parse(id);
    await serialized(await this.path(), async () => atomicJson(await this.path(), (await this.personal()).filter(entry => entry.id !== id)));
  }
}
