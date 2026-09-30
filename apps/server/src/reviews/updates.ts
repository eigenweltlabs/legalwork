import { createHash } from "node:crypto";
import { SavedReviewSchema, reviewCellKey, type SavedReview, type ReviewUpdate } from "./schema.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("base64url");
type Snapshot = { metadata: Map<string, string>; cells: Map<string, string>; expires: number };
const metadataSchema = SavedReviewSchema.omit({ cells: true }).partial();

/** Bounded fingerprints, never another copy of document text or result evidence. */
export class ReviewUpdates {
  private snapshots = new Map<string, Snapshot>();
  constructor(private capacity = 16, private ttl = 5 * 60_000) {}
  read(scope: string, review: SavedReview, revision?: number): ReviewUpdate {
    const prefix = `${scope}\0${review.id}\0`;
    for (const [key, value] of this.snapshots) if (value.expires <= Date.now()) this.snapshots.delete(key);
    const previous = revision === undefined ? undefined : this.snapshots.get(`${prefix}${revision}`);
    const { cells, ...metadata } = review;
    const key = `${prefix}${review.revision}`;
    let current = this.snapshots.get(key);
    if (!current) {
      current = { metadata: new Map(Object.entries(metadata).map(([key, value]) => [key, digest(value)])), cells: new Map(cells.map(cell => [reviewCellKey(cell), digest(cell)])), expires: Date.now() + this.ttl };
      this.snapshots.set(key, current);
      while (this.snapshots.size > this.capacity) this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    if (revision === review.revision) return { type: "unchanged", revision };
    if (!previous || revision === undefined) return { type: "full", review };
    return { type: "patch", baseRevision: revision, revision: review.revision,
      metadata: metadataSchema.parse(Object.fromEntries(Object.entries(metadata).filter(([key]) => current.metadata.get(key) !== previous.metadata.get(key)))),
      cells: cells.filter(cell => current.cells.get(reviewCellKey(cell)) !== previous.cells.get(reviewCellKey(cell))),
      removed: [...previous.cells.keys()].filter(key => !current.cells.has(key)),
    };
  }
  forget(scope: string, id: string) {
    const prefix = `${scope}\0${id}\0`;
    for (const key of this.snapshots.keys()) if (key.startsWith(prefix)) this.snapshots.delete(key);
  }
}
