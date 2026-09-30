import { expect, test } from "bun:test";
import { applyReviewUpdate, reviewRunAction, SavedReviewSchema } from "./schema.js";
import { ReviewUpdates } from "./updates.js";

function fixture(documents = 2, columns = 2) {
  return SavedReviewSchema.parse({ id: "37c7e52e-91b2-4a48-92f1-3699a6477045", name: "Review", revision: 0, createdAt: 1, updatedAt: 1,
    settings: { mode: "llm", jev: null, llm: { providerId: "test", model: "test" } }, status: "draft", runId: null,
    documents: Array.from({ length: documents }, (_, i) => ({ id: `d${i}`, name: `Contract ${i}.txt`, path: `${i}.txt`, sourceHash: null, status: "ready" })),
    columns: Array.from({ length: columns }, (_, i) => ({ key: `q${i}`, label: `Question ${i}`, question: "Is consent required?", kind: "yes_no" })),
    cells: Array.from({ length: documents * columns }, (_, i) => ({ documentId: `d${Math.floor(i / columns)}`, columnKey: `q${i % columns}`, status: "pending" })),
  });
}
test("incremental updates handle initial load, unchanged data, changed cells, removals and metadata", () => {
  const cache = new ReviewUpdates(), original = fixture();
  expect(applyReviewUpdate(undefined, cache.read("project", original))).toEqual(original);
  expect(applyReviewUpdate(original, cache.read("project", original, 0))).toBe(original);
  const next = structuredClone(original); next.revision++; next.updatedAt++; next.status = "running";
  next.cells[0].status = "running";
  const update = cache.read("project", next, 0);
  expect(update).toMatchObject({ type: "patch", cells: [next.cells[0]], metadata: { revision: 1, updatedAt: 2, status: "running" } });
  expect(JSON.stringify(update)).not.toContain('"question"');
  const merged = applyReviewUpdate(original, update);
  expect(merged).toEqual(next);
  expect(merged?.cells[1]).toBe(original.cells[1]);
  expect(applyReviewUpdate({ ...original, revision: 3 }, update)).toBeUndefined();
  const removed = structuredClone(next); removed.revision++; removed.columns.pop(); removed.cells = removed.cells.filter(cell => cell.columnKey !== "q1");
  expect(applyReviewUpdate(next, cache.read("project", removed, 1))).toEqual(removed);
  const added = structuredClone(removed); added.revision++; added.cells.push({ ...original.cells[1] });
  expect(applyReviewUpdate(removed, cache.read("project", added, 2))).toEqual(added);
});
test("restart, eviction, expiry and project boundaries safely return a full review", () => {
  const original = fixture(), next = { ...original, revision: 1 };
  expect(new ReviewUpdates().read("project", next, 0).type).toBe("full");
  const cache = new ReviewUpdates(1); cache.read("a", original); cache.read("b", original);
  expect(cache.read("a", next, 0).type).toBe("full");
  const expired = new ReviewUpdates(16, -1); expired.read("a", original);
  expect(expired.read("a", next, 0).type).toBe("full");
  const isolated = new ReviewUpdates(); isolated.read("a", original);
  expect(isolated.read("b", next, 0).type).toBe("full");
  isolated.forget("a", original.id); expect(isolated.read("a", next, 0).type).toBe("full");
});
test("a 6,000-cell review sends only the changed cell and clears old results on rerun", () => {
  const cache = new ReviewUpdates(), original = fixture(100, 60);
  const cell = original.cells[0];
  cell.status = "complete";
  cell.result = { value: "Yes", reason: "consent", citations: [], confidence: null, evidence: "uncited", backend: "llm", providerId: "test", model: "test", requestedModel: "test", sourceHash: "hash", prompt: original.columns[0], completedAt: 1, chunks: [] };
  const full = cache.read("project", original);
  const next = structuredClone(original); next.revision++; next.cells[0].result = null; next.cells[0].status = "queued";
  const patch = cache.read("project", next, 0);
  expect(patch).toMatchObject({ type: "patch", cells: [{ status: "queued", result: null }] });
  expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(full).length / 100);
  expect(applyReviewUpdate(original, patch)).toEqual(next);
});
test("run actions separate completed uncertainty/errors from unfinished or stale work", () => {
  const review = fixture(); review.runId = "f09b7dc5-643b-4888-b660-38e05fe50b78";
  for (const status of ["complete", "needs_review", "error"] satisfies Array<typeof review.cells[number]["status"]>) {
    review.cells.forEach(cell => { cell.status = status; }); review.status = "needs_review";
    expect(reviewRunAction(review)).toBe(status === "error" ? "retry_failed" : "rerun_all");
  }
  review.cells[0].status = "stale"; expect(reviewRunAction(review)).toBe("resume");
  review.cells[0].status = "pending"; expect(reviewRunAction(review)).toBe("resume");
  review.runId = null; expect(reviewRunAction(review)).toBe("run");
  review.status = "running"; expect(reviewRunAction(review)).toBe("stop");
  review.status = "needs_review"; review.settings.mode = "jev";
  review.columns[0].kind = "text";
  review.cells.forEach(cell => { cell.status = cell.columnKey === "q0" ? "blocked" : "complete"; });
  expect(reviewRunAction(review)).toBe("rerun_all");
});
