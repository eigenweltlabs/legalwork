import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { runtimeStorageDir } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import { ReviewLibraryEntrySchema, SaveReviewLibrarySchema, reviewLibraryKind, type ReviewLibraryEntry } from "./schema.js";
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
  async list(language: "en" | "de") { return [...builtinReviewLibrary(language), ...await this.personal()]; }
  async save(raw: unknown) {
    const input = SaveReviewLibrarySchema.parse(raw);
    return serialized(await this.path(), async () => {
      const entries = await this.personal();
      const existing = input.id ? entries.find(item => item.id === input.id) : undefined;
      if (input.id && !existing) throw new ApiError(404, "review_library_not_found", "Saved prompt not found.");
      if (existing && existing.version !== input.version) throw new ApiError(409, "review_library_conflict", "This saved prompt has changed. Reload it before saving.");
      const kind = input.kind ?? (existing ? reviewLibraryKind(existing) : reviewLibraryKind(input));
      if (kind === "prompt" && input.columns.length !== 1) throw new ApiError(400, "review_library_kind", "A prompt contains one column. Save multiple columns as a set.");
      const id = existing?.id ?? randomUUID(), version = (existing?.version ?? 0) + 1;
      const entry: ReviewLibraryEntry = { ...input, kind, id, version, source: "personal", updatedAt: Date.now(), columns: input.columns.map(column => ({ ...column, libraryId: id, libraryVersion: version, libraryColumnKey: column.key })) };
      await atomicJson(await this.path(), [...entries.filter(item => item.id !== id), entry]);
      return entry;
    });
  }
  async remove(id: string) {
    z.string().uuid().parse(id);
    await serialized(await this.path(), async () => atomicJson(await this.path(), (await this.personal()).filter(entry => entry.id !== id)));
  }
}
