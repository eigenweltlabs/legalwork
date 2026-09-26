import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { SavedReviewSchema, ReviewSettingsSchema, type SavedReview, type ReviewSettings } from "./schema.js";

const locks = new Map<string, Promise<unknown>>();
export async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}
export function missing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
export function within(root: string, path: string) {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}
export async function atomicJson(path: string, data: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  if (await realpath(path) !== path) throw new ApiError(403, "review_path", "Review storage must not use symbolic links.");
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new ApiError(413, "review_size", "Review storage exceeds the size limit.");
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}
export class ReviewStore {
  constructor(readonly workspace: string) {}
  async directory() {
    const root = await realpath(this.workspace);
    let directory = root;
    for (const segment of [".opencode", "legalwork", "reviews"]) {
      directory = join(directory, segment);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!within(root, await realpath(directory))) throw new ApiError(403, "review_path", "Review storage is outside the project.");
    }
    return directory;
  }
  async path(id: string) { return join(await this.directory(), `${z.string().uuid().parse(id)}.json`); }
  async read(id: string) {
    try { return await readJson(await this.path(id), SavedReviewSchema); }
    catch (error) { if (missing(error)) throw new ApiError(404, "review_not_found", "Review not found in this project."); throw error; }
  }
  async list() {
    const directory = await this.directory();
    const names = (await readdir(directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const rows = await Promise.all(names.map(async name => {
      try { return await this.read(name.slice(0, -5)); }
      catch (error) { if (error instanceof ApiError && error.code === "review_not_found") return null; throw error; }
    }));
    return rows.filter(row => row !== null);
  }
  async create(value: SavedReview) {
    return serialized(await this.path(value.id), async () => {
      try { return await this.read(value.id); }
      catch (error) { if (!(error instanceof ApiError && error.code === "review_not_found")) throw error; }
      await atomicJson(await this.path(value.id), SavedReviewSchema.parse(value));
      return value;
    });
  }
  async update(id: string, change: (review: SavedReview) => SavedReview | void, revision?: number) {
    return serialized(await this.path(id), async () => {
      const current = await this.read(id);
      if (revision !== undefined && current.revision !== revision) throw new ApiError(409, "review_conflict", "This review has changed. Reload it before saving.");
      const result = change(current) ?? current;
      result.revision++; result.updatedAt = Date.now();
      await atomicJson(await this.path(id), SavedReviewSchema.parse(result));
      return result;
    });
  }
  async archive(review: SavedReview) {
    if (!review.runId) return;
    return serialized(await this.path(review.id), async () => {
      await this.read(review.id); // A concurrent delete must not recreate history.
      const directory = join(await this.directory(), "history");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await realpath(directory) !== directory) throw new ApiError(403, "review_path", "Invalid review history path.");
      await atomicJson(join(directory, `${review.id}-${review.runId}.json`), review);
    });
  }
  async remove(id: string, revision: number) {
    const path = await this.path(id);
    return serialized(path, async () => {
      const current = await this.read(id);
      if (current.status === "running") throw new ApiError(409, "review_delete_running", "Stop the review before deleting it.");
      if (current.revision !== revision) throw new ApiError(409, "review_conflict", "This review has changed. Reload it before deleting.");
      const history = join(await this.directory(), "history");
      try {
        if (await realpath(history) !== history) throw new ApiError(403, "review_path", "Invalid review history path.");
        for (const name of await readdir(history)) {
          if (name.startsWith(`${id}-`) && name.endsWith(".json")) await rm(join(history, name));
        }
      } catch (error) { if (!missing(error)) throw error; }
      await rm(path);
    });
  }
}

/** User defaults live with application state, never inside an individual project. */
export class ReviewDefaults {
  constructor(private root: string) {}
  private async path() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return join(await realpath(this.root), "review-defaults.json");
  }
  async settings(fallback: ReviewSettings) {
    try { return await readJson(await this.path(), ReviewSettingsSchema); }
    catch (error) { if (missing(error)) return fallback; throw error; }
  }
  async saveSettings(settings: ReviewSettings) {
    const path = await this.path();
    await serialized(path, () => atomicJson(path, ReviewSettingsSchema.parse(settings)));
    return settings;
  }
  async reset() {
    const path = await this.path();
    await serialized(path, () => rm(path, { force: true }));
  }
}
