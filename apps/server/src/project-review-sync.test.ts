import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkCondition, conflict, entry, type StorageAdapter } from "./file-storage/common.js";
import {
  mergeReviews,
  pendingReviewChanges,
  REVIEW_SYNC_PREFIX,
  reviewSyncPath,
  sharedReview,
  syncProjectReviews,
  type ReviewBase,
  type ReviewBaseStore,
} from "./project-review-sync.js";
import { reviewRunningElsewhere, type ReviewCell, type ReviewColumn, type ReviewResult, type SavedReview } from "./reviews/schema.js";
import { ReviewStore } from "./reviews/storage.js";
import { resourceStorage } from "./cloud-sync/platform.js";

/**
 * Two computers (Anna's and Ben's) and the firm's copy of one project, in
 * memory: each computer has its project folder and its own record of what it
 * last agreed on with the firm.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const ID = "7a1f3c2e-5b4d-4e6f-8a9b-0c1d2e3f4a5b";
const RUN = "0f9e8d7c-6b5a-4c3d-9e1f-2a3b4c5d6e7f";
const assign: ReviewColumn = { key: "assign", label: "Abtretung", question: "Ist eine Abtretung erlaubt?", kind: "yes_no", options: [], hint: "" };
const term: ReviewColumn = { key: "term", label: "Laufzeit", question: "Wie lange läuft der Vertrag?", kind: "text", options: [], hint: "" };
const documents: SavedReview["documents"] = [
  { id: "doc-klage", path: "Klage.pdf", name: "Klage.pdf", sourceHash: "h-klage", status: "ready", completedPages: 2, pageCount: 2, error: null, preparationPath: "/Users/anna/cache/klage" },
  { id: "doc-vertrag", path: "Vertrag.pdf", name: "Vertrag.pdf", sourceHash: "h-vertrag", status: "ready", completedPages: 1, pageCount: 1, error: null },
];

function answer(column: ReviewColumn, value: string, completedAt: number): ReviewResult {
  return {
    value, reason: "", citations: [], confidence: null, evidence: "uncited", backend: "llm", providerId: "firm", model: "chat",
    requestedModel: "chat", sourceHash: "h-klage", prompt: column, completedAt, chunks: [], preparationPath: "/Users/anna/cache/klage",
  };
}

function cell(documentId: string, column: ReviewColumn, result: ReviewResult | null = null): ReviewCell {
  return { documentId, columnKey: column.key, status: result ? "complete" : "pending", result, error: null };
}

function review(overrides: Partial<SavedReview> = {}): SavedReview {
  const columns = overrides.columns ?? [assign];
  return {
    id: ID, name: "Due Diligence", sessionId: "ses_anna", revision: 3, createdAt: 1_000, updatedAt: 1_000,
    settings: { mode: "llm", jev: null, llm: { providerId: "firm", model: "chat" } },
    columns, documents, cells: documents.flatMap((document) => columns.map((column) => cell(document.id, column))),
    status: "draft", runId: null, error: null, ...overrides,
  };
}

function firm() {
  const files = new Map<string, Buffer>();
  const version = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const adapter: StorageAdapter = {
    list: async () => ({ entries: [] }),
    listFiles: async (prefix) => ({
      entries: [...files].filter(([path]) => path.startsWith(`${prefix}/`)).map(([path, bytes]) => ({ ...entry(path, "file", bytes.byteLength, null), version: version(bytes) })),
    }),
    stat: async () => null,
    read: async () => {
      throw new Error("not used");
    },
    download: async (path, destination) => {
      const bytes = files.get(path);
      if (!bytes || destination === undefined) throw new Error(`no ${path}`);
      await writeFile(destination, bytes, { flag: "wx" });
      return { size: bytes.byteLength, version: version(bytes), sha256: version(bytes) };
    },
    write: async (path, data, _contentType, condition) => {
      const current = files.get(path);
      checkCondition(current ? { size: current.byteLength, version: version(current) } : null, condition);
      files.set(path, data);
    },
    upload: async () => {
      throw new Error("not used");
    },
    mkdir: async () => {},
    deleteFile: async (path, condition) => {
      const current = files.get(path);
      if (current && condition?.version && condition.version !== version(current)) conflict();
      files.delete(path);
    },
  };
  const read = (path: string): SavedReview => JSON.parse(files.get(path)?.toString("utf8") ?? "null");
  return { adapter, files, read };
}

async function computer(firmCopy: ReturnType<typeof firm>, userId: string, name: string) {
  const root = await mkdtemp(join(tmpdir(), `legalwork-reviews-${userId}-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agreed = new Map<string, ReviewBase>();
  const base: ReviewBaseStore = { entries: () => new Map(agreed), put: (path, value) => agreed.set(path, value), drop: (path) => agreed.delete(path) };
  const store = new ReviewStore(root);
  let running = false;
  return {
    root,
    store,
    base,
    run: (on: boolean) => {
      running = on;
    },
    sync: (reconcile = true) =>
      syncProjectReviews({ root, remote: firmCopy.adapter, base, reconcile, runningHere: () => running, runner: { userId, name } }),
    read: () => store.read(ID),
  };
}

const livePath = `${REVIEW_SYNC_PREFIX}/${ID}.json`;

describe("Tabular Reviews with a synced project", () => {
  test("private cloud reviews reuse the review engine under an isolated storage prefix", async () => {
    const at = firm();
    const adapter = resourceStorage(at.adapter, "resources/ws_private/reviews", REVIEW_SYNC_PREFIX);
    const desktop = await computer({ ...at, adapter }, "owner", "Computer");
    const vm = await computer({ ...at, adapter }, "owner", "Cloud VM");
    await desktop.store.create(review());
    expect((await desktop.sync()).uploaded).toBe(1);
    expect(at.files.has(`resources/ws_private/reviews/${ID}.json`)).toBe(true);
    expect(at.files.has(livePath)).toBe(false);
    expect((await vm.sync()).downloaded).toBe(1);
    expect((await vm.read()).id).toBe(ID);
    expect((await vm.read()).columns).toEqual([assign]);
  });

  test("only review data counts as review paths", () => {
    expect(reviewSyncPath(livePath)).toBe(true);
    expect(reviewSyncPath(`${REVIEW_SYNC_PREFIX}/history/${ID}-${RUN}.json`)).toBe(true);
    for (const path of [".legalwork/project.json", `${REVIEW_SYNC_PREFIX}/../x.json`, `${REVIEW_SYNC_PREFIX}/notes.json`, `Akte/${livePath}`]) {
      expect(reviewSyncPath(path)).toBe(false);
    }
  });

  test("a review and its earlier runs reach a colleague, without what only makes sense on this computer", async () => {
    const at = firm();
    const anna = await computer(at, "user_anna", "Anna");
    const ben = await computer(at, "user_ben", "Ben");
    const done = review({ status: "complete", runId: RUN, cells: [cell("doc-klage", assign, answer(assign, "Ja", 2_000)), cell("doc-vertrag", assign)] });
    await anna.store.create(done);
    await anna.store.archive(done);

    expect((await anna.sync()).uploaded).toBe(2);
    const shared = at.read(livePath);
    expect(shared.sessionId).toBeNull();
    expect(shared.documents[0].preparationPath).toBeUndefined();
    expect(shared.cells[0].result?.preparationPath).toBeUndefined();

    expect((await ben.sync()).downloaded).toBe(2);
    const arrived = await ben.read();
    expect(arrived.cells[0].result?.value).toBe("Ja");
    expect(arrived.sessionId).toBeNull();
    expect(await readdir(join(ben.root, ".opencode", "legalwork", "reviews", "history"))).toEqual([`${ID}-${RUN}.json`]);

    // Nothing changed: nothing moves, and nothing is read again.
    for (const side of [anna, ben]) {
      expect(await side.sync()).toMatchObject({ uploaded: 0, downloaded: 0, pending: 0 });
      expect(await pendingReviewChanges(side.root, side.base)).toBe(0);
    }
    // A time that moved alone is no change.
    const later = new Date(Date.now() + 5_000);
    await utimes(join(ben.root, ".opencode", "legalwork", "reviews", `${ID}.json`), later, later);
    expect(await pendingReviewChanges(ben.root, ben.base)).toBe(0);
    // This computer's chat link and prepared documents stay as they were here.
    const own = await anna.read();
    expect(own.sessionId).toBe("ses_anna");
    expect(own.documents[0].preparationPath).toBe("/Users/anna/cache/klage");
  });

  test("changes on both computers merge: every answer kept, the later answer to a cell wins", async () => {
    const at = firm();
    const anna = await computer(at, "user_anna", "Anna");
    const ben = await computer(at, "user_ben", "Ben");
    await anna.store.create(review());
    await anna.sync();
    await ben.sync();

    // Anna answers the contract and renames the review; Ben answers both
    // documents, one of them earlier than Anna, and adds a column.
    await anna.store.update(ID, (current) => {
      current.name = "DD Kaufvertrag";
      current.cells[1] = cell("doc-vertrag", assign, answer(assign, "Nein", 5_000));
    });
    await Bun.sleep(5);
    await ben.store.update(ID, (current) => {
      current.columns = [assign, term];
      current.cells = [
        cell("doc-klage", assign, answer(assign, "Ja", 4_000)),
        cell("doc-klage", term),
        cell("doc-vertrag", assign, answer(assign, "Ja", 3_000)),
        cell("doc-vertrag", term),
      ];
    });
    await anna.sync();
    const merge = await ben.sync();
    expect(merge).toMatchObject({ downloaded: 1, uploaded: 1, stale: false });
    await anna.sync();

    for (const side of [anna, ben]) {
      const merged = await side.read();
      expect(merged.name).toBe("DD Kaufvertrag");
      expect(merged.columns.map((column) => column.key)).toEqual(["assign", "term"]);
      const value = (documentId: string, key: string) => merged.cells.find((item) => item.documentId === documentId && item.columnKey === key)?.result?.value;
      expect(value("doc-klage", "assign")).toBe("Ja");
      expect(value("doc-vertrag", "assign")).toBe("Nein");
      expect(merged.cells).toHaveLength(4);
    }
    // Each keeps its own chat link through the merge: Anna's, and none on Ben's copy.
    expect((await anna.read()).sessionId).toBe("ses_anna");
    expect((await ben.read()).sessionId).toBeNull();
    expect(await anna.sync()).toMatchObject({ uploaded: 0, downloaded: 0 });
    expect(await ben.sync()).toMatchObject({ uploaded: 0, downloaded: 0 });
  });

  test("an answer to a question changed meanwhile is out of date", () => {
    const base = sharedReview(review());
    const edited = { ...assign, question: "Ist eine Abtretung ohne Zustimmung erlaubt?" };
    const local = sharedReview(review({ updatedAt: 3_000, columns: [edited] }));
    const remote = sharedReview(review({ updatedAt: 2_000, cells: [cell("doc-klage", assign, answer(assign, "Ja", 2_000)), cell("doc-vertrag", assign)] }));
    const merged = mergeReviews(local, remote, base);
    expect(merged.columns[0].question).toBe(edited.question);
    expect(merged.cells[0]).toMatchObject({ status: "stale", result: { value: "Ja" } });
  });

  test("a review deleted on one computer leaves the other, into its sync trash", async () => {
    const at = firm();
    const anna = await computer(at, "user_anna", "Anna");
    const ben = await computer(at, "user_ben", "Ben");
    await anna.store.create(review());
    await anna.sync();
    await ben.sync();

    const current = await anna.read();
    await anna.store.remove(ID, current.revision);
    expect((await anna.sync()).removedRemote).toBe(1);
    expect(at.files.has(livePath)).toBe(false);
    expect((await ben.sync()).removedLocal).toBe(1);
    await expect(ben.read()).rejects.toMatchObject({ code: "review_not_found" });
    const trash = await readdir(join(ben.root, ".legalwork", "sync-trash"));
    expect(await readdir(join(ben.root, ".legalwork", "sync-trash", trash[0], ".opencode", "legalwork", "reviews"))).toEqual([`${ID}.json`]);
  });

  test("a review running here is watched elsewhere, and takes a colleague's change once its run has ended", async () => {
    const at = firm();
    const anna = await computer(at, "user_anna", "Anna");
    const ben = await computer(at, "user_ben", "Ben");
    await anna.store.create(review());
    await anna.sync();
    await ben.sync();

    // Ben renames it just before Anna's run reaches the firm.
    await ben.store.update(ID, (current) => {
      current.name = "Umbenannt";
    });
    await ben.sync();
    anna.run(true);
    await anna.store.update(ID, (current) => {
      current.status = "running";
      current.cells[0] = { ...current.cells[0], status: "running" };
    });
    await anna.sync();

    // The firm (and Ben) see Anna's run, with Ben's name; Anna's file is her run's.
    expect(at.read(livePath)).toMatchObject({ name: "Umbenannt", status: "running", runner: { userId: "user_anna", name: "Anna" } });
    expect((await anna.read()).name).toBe("Due Diligence");
    await ben.sync();
    expect(reviewRunningElsewhere(await ben.read())).toBe(true);

    anna.run(false);
    await anna.store.update(ID, (current) => {
      current.status = "complete";
      current.cells[0] = cell("doc-klage", assign, answer(assign, "Ja", Date.now()));
    });
    await anna.sync();
    await ben.sync();
    for (const side of [anna, ben]) {
      const ended = await side.read();
      expect(ended).toMatchObject({ name: "Umbenannt", status: "complete" });
      expect(ended.runner ?? null).toBeNull();
      expect(ended.cells[0].result?.value).toBe("Ja");
    }
  });

  test("a review folder gone from this computer brings the reviews back rather than deleting them for everyone", async () => {
    const at = firm();
    const anna = await computer(at, "user_anna", "Anna");
    await anna.store.create(review());
    await anna.sync();
    await rm(join(anna.root, ".opencode"), { recursive: true, force: true });
    expect(await anna.sync()).toMatchObject({ removedRemote: 0, downloaded: 1 });
    expect(at.files.has(livePath)).toBe(true);
    expect((await anna.read()).name).toBe("Due Diligence");
  });

  test("a file that is no review is left alone", async () => {
    const at = firm();
    const anna = await computer(at, "user_anna", "Anna");
    const folder = join(anna.root, ".opencode", "legalwork", "reviews");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${ID}.json`), "{ not json");
    expect(await anna.sync()).toMatchObject({ uploaded: 0, removedRemote: 0 });
    expect(await readFile(join(folder, `${ID}.json`), "utf8")).toBe("{ not json");
  });
});
