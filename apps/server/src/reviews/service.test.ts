import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "../types.js";
import { DocumentPreparation } from "../document-preparation/service.js";
import { OcrService } from "../ocr/service.js";
import { OcrManager } from "../ocr/manager.js";
import { ReviewService } from "./service.js";
import { ReviewDefaults, ReviewStore } from "./storage.js";
import { columnBackend } from "./policy.js";
import type { ReviewCapabilities, ReviewColumn, ReviewResult, SavedReview } from "./schema.js";
import type { ReviewEvidence } from "./evidence.js";
import { ReviewScheduler } from "./scheduler.js";
import { builtinReviewLibrary } from "./builtin-library.js";

const roots: string[] = [];
const services: ReviewService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const column: ReviewColumn = { key: "assign", label: "Assignment", question: "Is assignment permitted?", kind: "yes_no", options: [], hint: "" };
const caps: ReviewCapabilities = { settings: { mode: "mixed", jev: { providerId: "firm", model: "jev" }, llm: { providerId: "firm", model: "chat" } }, allowedKinds: ["yes_no", "classification", "text"], errors: [], models: [
  { backend: "systemone", providerId: "firm", model: "jev", name: "JEV", providerName: "Firm" },
  { backend: "llm", providerId: "firm", model: "chat", name: "Chat", providerName: "Firm" },
] };
async function fixture(options: { capabilities?: ReviewCapabilities; scheduler?: ReviewScheduler; beforeExecute?: (review: SavedReview, column: ReviewColumn, evidence: ReviewEvidence, signal: AbortSignal) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "saved-review-")); roots.push(root);
  const workspace: WorkspaceInfo = { id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" };
  await writeFile(join(root, "contract.md"), "Assignment is permitted with consent.");
  const calls: Array<{ column: ReviewColumn; mode: string }> = [];
  let hold = false;
  const service = new ReviewService({ models: async () => structuredClone(options.capabilities ?? caps), execute: async (_workspace: WorkspaceInfo, review: SavedReview, question: ReviewColumn, evidence: ReviewEvidence, signal: AbortSignal): Promise<ReviewResult> => {
    calls.push({ column: question, mode: review.settings.mode });
    await options.beforeExecute?.(review, question, evidence, signal);
    if (hold) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return { value: "Yes", reason: "", citations: [], confidence: null, evidence: "uncited", backend: columnBackend(review.settings.mode, question), providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: evidence.hash, prompt: question, completedAt: Date.now(), chunks: [] };
  } }, new DocumentPreparation(new OcrManager(join(root, "ocr"))), new ReviewDefaults(join(root, "app-state")), options.scheduler);
  services.push(service);
  const create = () => service.create(workspace, { requestId: randomUUID(), name: "Contract review", files: ["contract.md"], columns: [column] });
  return { root, workspace, service, calls, create, hold: () => { hold = true; } };
}
async function settled(service: ReviewService, workspace: WorkspaceInfo, id: string) {
  for (let i = 0; i < 300; i++) { const value = await service.get(workspace, id); if (value.status !== "running") return value; await Bun.sleep(10); }
  throw new Error("Review did not settle");
}
test("saved reviews survive restart, create retries deduplicate, and revisions reject lost edits", async () => {
  const f = await fixture(); const review = await f.create();
  expect((await f.service.create(f.workspace, { requestId: review.id, name: review.name, files: ["contract.md"], columns: [column] })).id).toBe(review.id);
  expect(await f.service.list(f.workspace)).toHaveLength(1);
  await f.service.edit(f.workspace, review.id, { revision: review.revision, name: "Changed" });
  await expect(f.service.edit(f.workspace, review.id, { revision: review.revision, name: "Lost edit" })).rejects.toThrow("changed");
  expect((await new ReviewStore(f.root).read(review.id)).name).toBe("Changed");
});

test("deleting a review removes results and history, expires result pages, and keeps sources and other reviews", async () => {
  const f = await fixture(), review = await f.create(), other = await f.create();
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  const finished = await settled(f.service, f.workspace, review.id);
  const page = await f.service.queryResults(f.workspace, review.id, { view: "evidence", limit: 1 });
  expect(page.nextCursor).not.toBeNull();
  await f.service.remove(f.workspace, review.id, finished.revision);
  await expect(f.service.get(f.workspace, review.id)).rejects.toThrow("Review not found");
  await expect(f.service.queryResults(f.workspace, review.id, { cursor: page.nextCursor })).rejects.toThrow("snapshot expired");
  expect((await f.service.list(f.workspace)).map(item => item.id)).toEqual([other.id]);
  expect(await readFile(join(f.root, "contract.md"), "utf8")).toBe("Assignment is permitted with consent.");
  expect((await readdir(join(await new ReviewStore(f.root).directory(), "history"))).some(name => name.startsWith(review.id))).toBe(false);
  await expect(new ReviewStore(f.root).archive(finished)).rejects.toThrow("Review not found");
});

test("deleting rejects a stale revision and an active run; a stopped review can be deleted", async () => {
  const f = await fixture(), review = await f.create();
  const changed = await f.service.edit(f.workspace, review.id, { revision: review.revision, name: "Changed" });
  await expect(f.service.remove(f.workspace, review.id, review.revision)).rejects.toThrow("changed");
  f.hold();
  await f.service.start(f.workspace, review.id, { revision: changed.revision });
  await waitFor(() => f.calls.length === 1);
  const running = await f.service.get(f.workspace, review.id);
  await expect(f.service.remove(f.workspace, review.id, running.revision)).rejects.toThrow("Stop the review");
  await f.service.cancel(f.workspace, review.id);
  const stopped = await settled(f.service, f.workspace, review.id);
  await f.service.remove(f.workspace, review.id, stopped.revision);
  await expect(f.service.get(f.workspace, review.id)).rejects.toThrow("Review not found");
});

test("global defaults apply to new reviews across projects, persist and reset without changing existing reviews", async () => {
  const f = await fixture(), existing = await f.create();
  const other = { ...f.workspace, id: "other", path: join(f.root, "other") };
  await mkdir(other.path);
  // Old per-project defaults no longer override the app-wide preference.
  await writeFile(join(await new ReviewStore(other.path).directory(), "settings.json"), JSON.stringify({ ...caps.settings, mode: "llm" }));
  expect((await f.service.capabilities(other)).settings).toEqual(caps.settings);
  const defaults: ReviewCapabilities["settings"] = { ...caps.settings, mode: "jev", minDecisionProbability: .9 };
  await f.service.saveSettings(f.workspace, defaults);
  expect((await f.service.capabilities(other)).settings).toEqual(defaults);
  expect(await new ReviewDefaults(join(f.root, "app-state")).settings(caps.settings)).toEqual(defaults);
  const created = await f.service.create(other, { requestId: randomUUID(), name: "Global defaults", files: [], columns: [column] });
  expect(created.settings).toEqual(defaults);
  expect((await f.service.get(f.workspace, existing.id)).settings).toEqual(existing.settings);
  await f.service.resetDefaults(other);
  expect((await f.service.capabilities(f.workspace)).settings).toEqual(caps.settings);
  expect((await f.service.capabilities(other)).settings).toEqual(caps.settings);
  expect((await f.service.get(other, created.id)).settings).toEqual(defaults);
});

test("saved builtin prompts gain fallback options once, preserve results as stale and leave customized prompts untouched", async () => {
  const f = await fixture(), store = new ReviewStore(f.root);
  const old = builtinReviewLibrary("en", 2).find(entry => entry.id === "builtin-assignment-en")!.columns[0];
  const custom = { ...old, key: "custom", question: "Is assignment forbidden under my own policy?" };
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Upgrade", files: ["contract.md"], columns: [old, custom] });
  const original = await store.update(review.id, current => {
    current.runId = randomUUID();
    current.cells[0] = { ...current.cells[0], status: "complete", result: { value: "No", reason: "", confidence: null, citations: [], evidence: "uncited", backend: "systemone", providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: "old-source", prompt: old, completedAt: 1, chunks: [] } };
  });
  review = await f.service.get(f.workspace, review.id);
  expect(review.columns[0].libraryVersion).toBe(3);
  expect(review.columns[0].options).toContain("Not found");
  expect(review.columns[1]).toEqual(custom);
  expect(review.cells[0].status).toBe("stale");
  expect(review.cells[0].result).toEqual(original.cells[0].result);
  const history = JSON.parse(await readFile(join(await store.directory(), "history", `${review.id}-${original.runId}.json`), "utf8"));
  expect(history.columns[0]).toEqual(old);
  expect((await f.service.get(f.workspace, review.id)).revision).toBe(review.revision);
});

test("legacy low-probability results are flagged on load and raising the user threshold takes effect", async () => {
  const f = await fixture(), store = new ReviewStore(f.root);
  let review = await f.create();
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  await store.update(review.id, current => {
    const cell = current.cells[0];
    cell.result = { ...cell.result!, decision: { type: "noul", noul: .75 } };
  });
  review = await f.service.get(f.workspace, review.id);
  expect(review.cells[0].status).toBe("needs_review"); expect(review.cells[0].result!.value).toBe("Needs review");
  expect(review.cells[0].result!.decision).toEqual({ type: "noul", noul: .75 });
  expect((await f.service.get(f.workspace, review.id)).revision).toBe(review.revision);
  await store.update(review.id, current => {
    current.cells[0].result = { ...current.cells[0].result!, value: "Yes", evidence: "uncited", decision: { type: "noul", noul: .85 } };
    current.cells[0].status = "complete";
  });
  review = await f.service.get(f.workspace, review.id);
  await f.service.saveSettings(f.workspace, { ...review.settings, minDecisionProbability: .9 }, review.id, review.revision);
  review = await f.service.get(f.workspace, review.id);
  expect(review.cells[0].status).toBe("stale"); expect(review.cells[0].result!.value).toBe("Needs review");
  expect(review.cells[0].result!.decisionThreshold).toBe(.9);
});

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}
function latch() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("mixed reviews share sixteen cell workers across backends and queue a third review", async () => {
  const gate = latch(), active = { systemone: 0, llm: 0 };
  let peak = 0;
  const started = new Set<string>();
  const f = await fixture({ scheduler: new ReviewScheduler({ cells: 16, documents: 4 }), beforeExecute: async (review, question) => {
    const backend = columnBackend(review.settings.mode, question);
    started.add(review.id); active[backend]++; peak = Math.max(peak, active.systemone + active.llm);
    await gate.promise; await Bun.sleep(3); active[backend]--;
  } });
  const columns = Array.from({ length: 8 }, (_, i): ReviewColumn => ({ ...column, key: `c${i}`, kind: i < 4 ? "yes_no" : "text" }));
  const reviews = await Promise.all(Array.from({ length: 3 }, () => f.service.create(f.workspace, { requestId: randomUUID(), name: "Concurrent", files: ["contract.md"], columns })));
  await Promise.all(reviews.map(review => f.service.start(f.workspace, review.id, { revision: review.revision })));
  await waitFor(() => active.systemone + active.llm === 16);
  const snapshots = await Promise.all(reviews.map(review => f.service.get(f.workspace, review.id)));
  expect(snapshots.every(review => review.status === "running")).toBe(true);
  expect(snapshots.flatMap(review => review.cells).filter(cell => cell.status === "running")).toHaveLength(16);
  expect(snapshots.flatMap(review => review.cells).filter(cell => cell.status === "queued")).toHaveLength(8);
  gate.release();
  const finished = await Promise.all(reviews.map(review => settled(f.service, f.workspace, review.id)));
  expect(finished.every(review => review.status === "complete")).toBe(true);
  expect(peak).toBe(16); expect(started.size).toBe(3); expect(f.calls).toHaveLength(24);
});

test("parallel cancellation drains running cells, removes queued cells/documents and resumes only unfinished work", async () => {
  let block = true;
  const running = new Set<string>();
  const f = await fixture({ scheduler: new ReviewScheduler({ cells: 2, documents: 1 }), beforeExecute: async (_review, question, evidence, signal) => {
    if (!block || question.key === "finished") return;
    running.add(`${evidence.hash}:${question.key}`);
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  await writeFile(join(f.root, "second.md"), "Assignment is allowed.");
  const columns = ["finished", "waiting1", "waiting2", "queued"].map(key => ({ ...column, key }));
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Cancel", files: ["contract.md", "second.md"], columns });
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  await waitFor(() => running.size === 2);
  await f.service.cancel(f.workspace, review.id); review = await settled(f.service, f.workspace, review.id);
  expect(review.status).toBe("cancelled"); expect(f.calls).toHaveLength(3);
  expect(review.cells.filter(cell => cell.status === "complete")).toHaveLength(1);
  expect(review.cells.filter(cell => cell.status === "pending")).toHaveLength(7);
  const saved = review.cells.find(cell => cell.status === "complete")!.result;
  block = false;
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  expect(review.status).toBe("complete"); expect(f.calls).toHaveLength(10);
  expect(review.cells[0].result).toEqual(saved);
});

test("one cell failure does not cancel siblings or finalize before their results are saved", async () => {
  const gate = latch(); let siblingRunning = false;
  const f = await fixture({ beforeExecute: async (_review, question) => {
    if (question.key === "bad") throw new Error("Invalid model answer");
    siblingRunning = true; await gate.promise;
  } });
  const review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Partial", files: ["contract.md"], columns: [{ ...column, key: "bad" }, { ...column, key: "good" }] });
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  await waitFor(() => siblingRunning);
  expect((await f.service.get(f.workspace, review.id)).status).toBe("running");
  gate.release(); const final = await settled(f.service, f.workspace, review.id);
  expect(final.status).toBe("needs_review"); expect(final.cells.map(cell => cell.status)).toEqual(["error", "complete"]);
});

test("JEV-only configuration runs decisions and blocks every LLM extraction type before scheduling", async () => {
  const capabilities = structuredClone(caps);
  capabilities.settings.llm = null; capabilities.models = capabilities.models.filter(model => model.backend === "systemone");
  const f = await fixture({ capabilities });
  const extraction: ReviewColumn[] = ["text", "date", "number", "currency", "percentage", "multi_select"].map(kind => {
    if (kind !== "text" && kind !== "date" && kind !== "number" && kind !== "currency" && kind !== "percentage" && kind !== "multi_select") throw new Error("Unknown kind");
    return { ...column, key: kind, kind, options: kind === "multi_select" ? ["A", "B"] : [] };
  });
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "JEV available", files: ["contract.md"], columns: [column, ...extraction] });
  const started = await f.service.start(f.workspace, review.id, { revision: review.revision });
  expect(started.cells.filter(cell => cell.status === "blocked")).toHaveLength(6);
  review = await settled(f.service, f.workspace, review.id);
  expect(f.calls.map(call => call.column.key)).toEqual([column.key]);
  expect(review.cells.slice(1).every(cell => cell.status === "blocked" && cell.blockedBy === "llm")).toBe(true);
  // A changed source must not bypass the availability gate.
  await writeFile(join(f.root, "contract.md"), "Assignment now requires approval.");
  await f.service.start(f.workspace, review.id, { revision: review.revision }); review = await settled(f.service, f.workspace, review.id);
  expect(f.calls).toHaveLength(2); expect(review.cells.slice(1).every(cell => cell.status === "blocked")).toBe(true);
  // Connecting the missing backend resumes blocked cells without rerunning JEV.
  capabilities.settings.llm = caps.settings.llm; capabilities.models = caps.models;
  await f.service.saveSettings(f.workspace, caps.settings, review.id, review.revision);
  review = await f.service.get(f.workspace, review.id);
  await f.service.start(f.workspace, review.id, { revision: review.revision }); review = await settled(f.service, f.workspace, review.id);
  expect(review.status).toBe("complete"); expect(f.calls).toHaveLength(8);
});

test("a saved but disconnected LLM is blocked and a selected JEV column can still run", async () => {
  const capabilities = structuredClone(caps); capabilities.models = capabilities.models.filter(model => model.backend === "systemone");
  const f = await fixture({ capabilities });
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Disconnected LLM", files: ["contract.md"], columns: [column, { ...column, key: "text", kind: "text" }] });
  await expect(f.service.start(f.workspace, review.id, { revision: review.revision, columnKeys: ["text"] })).rejects.toThrow("required by these columns");
  expect(f.calls).toHaveLength(0);
  await f.service.start(f.workspace, review.id, { revision: review.revision }); review = await settled(f.service, f.workspace, review.id);
  expect(review.cells.map(cell => cell.status)).toEqual(["complete", "blocked"]);
  expect(f.calls).toHaveLength(1);
});
test("switching a mixed table to Only JEV retains incompatible columns but never schedules them", async () => {
  const f = await fixture();
  const columns: ReviewColumn[] = [column, { ...column, key: "date", kind: "date" }, { ...column, key: "text", kind: "text" }];
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Mode switch", files: ["contract.md"], columns });
  await f.service.saveSettings(f.workspace, { ...caps.settings, mode: "jev" }, review.id, review.revision);
  review = await f.service.get(f.workspace, review.id);
  expect(review.columns).toEqual(columns);
  await expect(f.service.start(f.workspace, review.id, { revision: review.revision, columnKeys: ["text"] })).rejects.toThrow("Only JEV mode");
  expect(f.calls).toHaveLength(0);
  // Retained inactive columns must not prevent reordering or removing columns.
  review = await f.service.edit(f.workspace, review.id, { revision: review.revision, columns: [...columns].reverse() });
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  expect(f.calls.map(call => call.column.key)).toEqual([column.key]);
  expect(review.cells.filter(cell => cell.columnKey !== column.key).every(cell => cell.status === "blocked" && cell.blockedBy === "jev_mode")).toBe(true);
  // Availability is irrelevant: even a configured LLM cannot bypass Only JEV.
  await writeFile(join(f.root, "contract.md"), "Assignment now requires approval.");
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  expect(f.calls).toHaveLength(2);
  await f.service.saveSettings(f.workspace, caps.settings, review.id, review.revision);
  review = await f.service.get(f.workspace, review.id);
  expect(review.cells.filter(cell => cell.columnKey !== column.key).every(cell => cell.status === "pending" && !cell.blockedBy)).toBe(true);
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  expect(review.status).toBe("complete"); expect(f.calls).toHaveLength(4);
  const saved = review.cells.find(cell => cell.columnKey === "text")!.result;
  await f.service.saveSettings(f.workspace, { ...caps.settings, mode: "jev" }, review.id, review.revision);
  review = await f.service.get(f.workspace, review.id);
  await f.service.start(f.workspace, review.id, { revision: review.revision, rerun: true });
  review = await settled(f.service, f.workspace, review.id);
  expect(f.calls).toHaveLength(5);
  expect(review.cells.find(cell => cell.columnKey === "text")!.result).toEqual(saved);
});
test("Only JEV rejects text through both creation and editing; saved mode is enforced", async () => {
  const f = await fixture(); await f.service.saveSettings(f.workspace, { ...caps.settings, mode: "jev" });
  const review = await f.create(); expect(review.settings.mode).toBe("jev");
  const text = { ...column, kind: "text" };
  await expect(f.service.create(f.workspace, { requestId: randomUUID(), name: "Invalid", files: ["contract.md"], columns: [text] })).rejects.toThrow("LLM");
  await expect(f.service.edit(f.workspace, review.id, { revision: review.revision, columns: [text] })).rejects.toThrow("LLM");
  expect(f.calls).toHaveLength(0);
});
test("Only JEV rejects explicit free-text instructions relabeled as yes/no or classification in English and German", async () => {
  const f = await fixture(); await f.service.saveSettings(f.workspace, { ...caps.settings, mode: "jev" });
  for (const question of ["Extract all party names.", "Explain the termination provisions.", "Bitte beschreibe die Kündigungsrechte.", "Liste alle Vertragsparteien auf."]) {
    await expect(f.service.create(f.workspace, { requestId: randomUUID(), name: "Invalid", files: ["contract.md"], columns: [{ ...column, kind: "classification", options: ["Present", "Absent"], question }] })).rejects.toThrow("LLM");
  }
  await expect(f.service.create(f.workspace, { requestId: randomUUID(), name: "Valid", files: ["contract.md"], columns: [{ ...column, kind: "classification", options: ["Mutual", "One-way", "Absent"], question: "How are confidentiality obligations allocated?" }] })).resolves.toHaveProperty("status", "draft");
  expect(f.calls).toHaveLength(0);
});
test("runs cells once, keeps prompt snapshots, rejects stale sources, and reruns just the selected column", async () => {
  const f = await fixture(); let review = await f.create();
  review = await f.service.edit(f.workspace, review.id, { revision: review.revision, columns: [column, { ...column, key: "other" }] });
  await f.service.start(f.workspace, review.id, { revision: review.revision }); review = await settled(f.service, f.workspace, review.id);
  expect(review.status).toBe("complete"); expect(f.calls).toHaveLength(2);
  expect(review.cells[0].result?.prompt).toEqual(column);
  const oldHash = review.cells[1].result!.sourceHash;
  await writeFile(join(f.root, "contract.md"), "Assignment is forbidden.");
  await expect(f.service.verifySource(f.workspace, review.id, review.documents[0].id)).rejects.toThrow("changed");
  review = await f.service.get(f.workspace, review.id); expect(review.cells.every(cell => cell.status === "stale")).toBe(true);
  await f.service.start(f.workspace, review.id, { revision: review.revision, columnKeys: [column.key], rerun: true }); review = await settled(f.service, f.workspace, review.id);
  expect(f.calls).toHaveLength(3); expect(review.cells[0].status).toBe("complete"); expect(review.cells[1].status).toBe("stale");
  await expect(f.service.verifySource(f.workspace, review.id, review.documents[0].id, oldHash)).rejects.toThrow("changed");
});
test("concurrent starts deduplicate, running reviews cannot be edited, cancellation preserves progress", async () => {
  const f = await fixture(); f.hold(); const review = await f.create();
  const [a, b] = await Promise.all([f.service.start(f.workspace, review.id, { revision: review.revision }), f.service.start(f.workspace, review.id, { revision: review.revision })]);
  expect(a.runId).toBe(b.runId);
  await expect(f.service.edit(f.workspace, review.id, { revision: a.revision, name: "No" })).rejects.toThrow("Stop");
  for (let i = 0; i < 100 && !f.calls.length; i++) await Bun.sleep(10);
  expect(f.calls).toHaveLength(1); await f.service.cancel(f.workspace, review.id);
  const stopped = await settled(f.service, f.workspace, review.id); expect(stopped.status).toBe("cancelled"); expect(stopped.cells[0].status).toBe("pending");
});
test("a restart marks persisted running cells interrupted rather than claiming success", async () => {
  const f = await fixture(); const review = await f.create();
  await new ReviewStore(f.root).update(review.id, value => { value.status = "running"; value.cells[0].status = "running"; });
  const recovered = await f.service.get(f.workspace, review.id); expect(recovered.status).toBe("interrupted"); expect(recovered.cells[0].status).toBe("pending");
});
test("source selection cannot escape a project through a symlink or absolute path", async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), "outside-review-")); roots.push(outside);
  await writeFile(join(outside, "secret.txt"), "private"); await symlink(join(outside, "secret.txt"), join(f.root, "link.txt"));
  for (const file of ["link.txt", join(outside, "secret.txt")]) await expect(f.service.create(f.workspace, { requestId: randomUUID(), name: "No", files: [file], columns: [column] })).rejects.toThrow("inside this project");
});

test("a multi-document review pins one OCR configuration even when defaults change mid-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-pinned-ocr-")); roots.push(root);
  const workspace: WorkspaceInfo = { id: "ocr-test", name: "Test", path: root, preset: "starter", workspaceType: "local" };
  const bytes = await readFile(new URL("../ocr/fixtures/bilingual.png", import.meta.url));
  await writeFile(join(root, "one.png"), bytes); await writeFile(join(root, "two.png"), bytes);
  let currentModel = "A", snapshots = 0;
  const recognized: string[] = [], inferred: string[] = [];
  const preparation = new DocumentPreparation(new OcrManager(join(root, "ocr")), { snapshot: async () => {
    snapshots++; const model = currentModel;
    return { fingerprint: model, service: new OcrService([{ info: { id: "fixture", label: model, execution: "local", model, languages: null, regions: false, warnings: [] }, recognize: async () => {
      recognized.push(model); currentModel = "B"; return { text: `Recognized with ${model}`, regions: [], truncated: false };
    } }], "fixture") };
  } });
  const service = new ReviewService({ models: async () => caps, execute: async (_workspace, _review, prompt, evidence) => {
    inferred.push(evidence.pages.find(page => page.source === "ocr")!.text);
    return { value: "Yes", reason: "", citations: [], confidence: null, evidence: "uncited", backend: "systemone", providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: evidence.hash, preparationPath: evidence.preparationPath, prompt, completedAt: Date.now(), chunks: [] };
  } }, preparation, new ReviewDefaults(join(root, "app-state"))); services.push(service);
  const review = await service.create(workspace, { requestId: randomUUID(), name: "Pinned OCR", files: ["one.png", "two.png"], columns: [column] });
  await service.start(workspace, review.id, { revision: review.revision });
  expect((await settled(service, workspace, review.id)).status).toBe("complete");
  expect(snapshots).toBe(1); expect(recognized).toEqual(["A", "A"]); expect(inferred).toEqual(["Recognized with A", "Recognized with A"]);
});

test("empty drafts accept files later, preserve existing results, and refuse to run without documents", async () => {
  const f = await fixture();
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "New review", files: [], columns: [column] });
  await expect(f.service.start(f.workspace, review.id, { revision: review.revision })).rejects.toThrow("Add a document");
  review = await f.service.edit(f.workspace, review.id, { revision: review.revision, files: ["contract.md"] });
  expect(review.documents).toHaveLength(1); expect(review.cells).toHaveLength(1);
  await f.service.start(f.workspace, review.id, { revision: review.revision }); review = await settled(f.service, f.workspace, review.id);
  const result = review.cells[0].result;
  await writeFile(join(f.root, "second.txt"), "Assignment is permitted.");
  review = await f.service.edit(f.workspace, review.id, { revision: review.revision, files: ["contract.md", "second.txt"] });
  expect(review.cells[0].result).toEqual(result); expect(review.cells[1].status).toBe("pending");
});

test("agent review creation and first start retain the original session across reruns", async () => {
  const f = await fixture();
  const created = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Agent review", files: ["contract.md"], columns: [column], sessionId: "origin" });
  expect(created.sessionId).toBe("origin");
  const running = await f.service.start(f.workspace, created.id, { revision: created.revision, sessionId: "later-session" });
  expect(running.sessionId).toBe("origin");
  await settled(f.service, f.workspace, created.id);
  const manual = await f.create();
  expect(manual.sessionId).toBeNull();
  expect((await f.service.start(f.workspace, manual.id, { revision: manual.revision, sessionId: "started-here" })).sessionId).toBe("started-here");
  await settled(f.service, f.workspace, manual.id);
});

for (const mode of ["rerun", "reprocess", "changed source"]) test(`${mode} clears selected answers while queued/running and keeps other cells`, async () => {
  const gate = latch();
  let pause = false;
  const f = await fixture({ beforeExecute: async () => { if (pause) await gate.promise; } });
  await writeFile(join(f.root, "second.md"), "Assignment is allowed.");
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Rerun", files: ["contract.md", "second.md"], columns: [column, { ...column, key: "other" }] });
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  const previous = structuredClone(review.cells), documentId = review.documents[0].id;
  if (mode === "changed source") await writeFile(join(f.root, "contract.md"), "Assignment now requires prior consent.");
  pause = true;
  try {
    const started = await f.service.start(f.workspace, review.id, { revision: review.revision, documentIds: [documentId], columnKeys: [column.key], rerun: mode === "rerun", reprocess: mode === "reprocess" });
    if (mode !== "changed source") expect(started.cells[0]).toMatchObject({ status: "queued", result: null });
    await waitFor(() => f.calls.length === 5);
    const running = await f.service.get(f.workspace, review.id);
    expect(running.cells[0]).toMatchObject({ status: "running", result: null });
    expect(running.cells.slice(1).map(cell => cell.result)).toEqual(previous.slice(1).map(cell => cell.result));
  } finally { gate.release(); }
  const finished = await settled(f.service, f.workspace, review.id);
  expect(finished.cells[0].status).toBe("complete");
  expect(finished.cells[0].result?.value).toBe("Yes");
  expect(finished.cells[0].result?.completedAt).toBeGreaterThan(previous[0].result!.completedAt);
});

test("failed and cancelled reruns do not restore the old answer", async () => {
  for (const outcome of ["error", "cancelled"]) {
    let fail = false;
    const f = await fixture({ beforeExecute: async () => { if (fail) throw new Error("Model unavailable"); } });
    let review = await f.create();
    await f.service.start(f.workspace, review.id, { revision: review.revision });
    review = await settled(f.service, f.workspace, review.id);
    expect(review.cells[0].result).not.toBeNull();
    if (outcome === "error") fail = true; else f.hold();
    await f.service.start(f.workspace, review.id, { revision: review.revision, rerun: true });
    await waitFor(() => f.calls.length === 2);
    if (outcome === "cancelled") await f.service.cancel(f.workspace, review.id);
    const finished = await settled(f.service, f.workspace, review.id);
    expect(finished.cells[0].status).toBe(outcome === "error" ? "error" : "pending");
    expect(finished.cells[0].result).toBeNull();
  }
});

test("retry failed cells preserves successful and uncertain answers and does not start pending cells", async () => {
  let fail = true;
  const f = await fixture({ beforeExecute: async (_review, question) => { if (fail && question.key === "failed") throw new Error("Provider unavailable"); } });
  let review = await f.service.create(f.workspace, { requestId: randomUUID(), name: "Recovery", files: ["contract.md"], columns: [column, { ...column, key: "uncertain" }, { ...column, key: "failed" }, { ...column, key: "pending" }] });
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  review = await new ReviewStore(f.root).update(review.id, current => {
    current.cells[1].status = "needs_review";
    current.cells[2].status = "error";
    current.cells[3].status = "pending"; current.cells[3].result = null;
  });
  const kept = structuredClone(review.cells.slice(0, 2));
  const before = f.calls.length; fail = false;
  await f.service.start(f.workspace, review.id, { revision: review.revision, retryFailed: true });
  review = await settled(f.service, f.workspace, review.id);
  expect(f.calls.slice(before).map(call => call.column.key)).toEqual(["failed"]);
  expect(review.cells.slice(0, 2)).toEqual(kept);
  expect(review.cells[2].status).toBe("complete"); expect(review.cells[3].status).toBe("pending");
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  expect(f.calls.slice(before).map(call => call.column.key)).toEqual(["failed", "pending"]);
  expect(review.cells.slice(0, 2)).toEqual(kept);
});

test("restart recovery resets OCR state and resumes unfinished cells without repeating completed answers", async () => {
  const f = await fixture(); let review = await f.create();
  await f.service.start(f.workspace, review.id, { revision: review.revision });
  review = await settled(f.service, f.workspace, review.id);
  const kept = structuredClone(review.cells[0]);
  await new ReviewStore(f.root).update(review.id, current => {
    current.status = "running"; current.documents[0].status = "preparing";
    current.columns.push({ ...column, key: "second" });
    current.cells.push({ ...kept, columnKey: "second", result: null, status: "running" });
  });
  const recovered = await f.service.get(f.workspace, review.id);
  expect(recovered.status).toBe("interrupted"); expect(recovered.documents[0].status).toBe("pending");
  expect(recovered.cells[1].status).toBe("pending");
  await f.service.start(f.workspace, review.id, { revision: recovered.revision });
  review = await settled(f.service, f.workspace, review.id);
  expect(review.cells[0]).toEqual(kept); expect(review.cells[1].status).toBe("complete");
  expect(f.calls.map(call => call.column.key)).toEqual(["assign", "second"]);
});
