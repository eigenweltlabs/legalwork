import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "../types.js";
import { DocumentPreparation } from "../document-preparation/service.js";
import { OcrService } from "../ocr/service.js";
import { OcrManager } from "../ocr/manager.js";
import { ReviewService } from "./service.js";
import { ReviewStore } from "./storage.js";
import { columnBackend } from "./policy.js";
import type { ReviewCapabilities, ReviewColumn, ReviewResult, SavedReview } from "./schema.js";
import type { ReviewEvidence } from "./evidence.js";

const roots: string[] = [];
const services: ReviewService[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.stop()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const column: ReviewColumn = { key: "assign", label: "Assignment", question: "Is assignment permitted?", kind: "yes_no", options: [], hint: "" };
const caps: ReviewCapabilities = { settings: { mode: "mixed", jev: { providerId: "firm", model: "jev" }, llm: { providerId: "firm", model: "chat" } }, allowedKinds: ["yes_no", "classification", "text"], errors: [], models: [
  { backend: "systemone", providerId: "firm", model: "jev", name: "JEV", providerName: "Firm" },
  { backend: "llm", providerId: "firm", model: "chat", name: "Chat", providerName: "Firm" },
] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "saved-review-")); roots.push(root);
  const workspace: WorkspaceInfo = { id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" };
  await writeFile(join(root, "contract.md"), "Assignment is permitted with consent.");
  const calls: Array<{ column: ReviewColumn; mode: string }> = [];
  let hold = false;
  const service = new ReviewService({ models: async () => structuredClone(caps), execute: async (_workspace: WorkspaceInfo, review: SavedReview, question: ReviewColumn, evidence: ReviewEvidence, signal: AbortSignal): Promise<ReviewResult> => {
    calls.push({ column: question, mode: review.settings.mode });
    if (hold) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return { value: "Yes", reason: "", citations: [], confidence: null, evidence: "uncited", backend: columnBackend(review.settings.mode, question), providerId: "firm", model: "jev", requestedModel: "jev", sourceHash: evidence.hash, prompt: question, completedAt: Date.now(), chunks: [] };
  } }, new DocumentPreparation(new OcrManager(join(root, "ocr"))));
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
  } }, preparation); services.push(service);
  const review = await service.create(workspace, { requestId: randomUUID(), name: "Pinned OCR", files: ["one.png", "two.png"], columns: [column] });
  await service.start(workspace, review.id, { revision: review.revision });
  expect((await settled(service, workspace, review.id)).status).toBe("complete");
  expect(snapshots).toBe(1); expect(recognized).toEqual(["A", "A"]); expect(inferred).toEqual(["Recognized with A", "Recognized with A"]);
});
