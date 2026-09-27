import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CorpusService, discoverCorpus, validateDocumentQuestion } from "./service.js";
import { CorpusQuerySchema } from "./schema.js";
import type { WorkspaceInfo } from "../types.js";
import type { SystemOneRequest, SystemOneResponse } from "../systemone-schema.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), "corpus-")); roots.push(root);
  for (let n = 0; n < count; n++) await writeFile(join(root, `${String(n).padStart(3, "0")}.txt`), "Evidence");
  const workspace: WorkspaceInfo = { id: "corpus", name: "Corpus", path: root, preset: "starter", workspaceType: "local" };
  return { root, workspace };
}
const binary = (value: number): SystemOneResponse => ({ model: "jev", answers: { answer: { type: "noul", noul: value } } });
const selection = async () => ({ providerId: "configured", model: "jev" });
const extract = async (_root: string, path: string) => ({ text: `Evidence for ${path}`, pages: [{ page: 1, text: `Evidence for ${path}` }], complete: true, extraction: "native" as const, hash: "source" });

test("fans the same question out to each file with sixteen simultaneous calls and compact filtered pagination", async () => {
  const f = await fixture(40); let active = 0, peak = 0, calls = 0;
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: SystemOneRequest[] = [];
  const service = new CorpusService({ selection, extract, infer: async request => {
    requests.push(request); calls++; active++; peak = Math.max(peak, active);
    if (active === 16) release(); await gate; await Bun.sleep(2); active--;
    return binary(.97);
  } });
  const question = "Does this document contain an assignment clause?";
  const result = await service.query(f.workspace, { paths: ["."], question, answers: ["Yes"], limit: 10 }, "once");
  expect(result.status).toBe("complete"); expect(peak).toBe(16); expect(calls).toBe(40);
  expect(result.counts).toEqual({ Yes: 40 }); expect(result.results).toHaveLength(10); expect(result.nextOffset).toBe(10);
  expect(requests.every(request => typeof request.questions.answer.instructions === "object" && JSON.stringify(request.questions.answer.instructions).includes(question))).toBe(true);
  expect(new Set(requests.map(request => request.state)).size).toBe(40);
  expect(JSON.stringify(result)).not.toContain("Evidence for");
  const next = await service.query(f.workspace, { jobId: result.jobId, answers: ["Yes"], offset: 10, limit: 10 });
  expect(next.results?.[0].path).not.toBe(result.results?.[0].path); expect(calls).toBe(40);
  await service.query(f.workspace, { paths: ["."], question }, "once"); expect(calls).toBe(40);
  await expect(service.query({ ...f.workspace, path: f.root + "/other" }, { jobId: result.jobId })).rejects.toThrow("not found");
});

test("uncertainty, unsupported sources and errors are not negative answers", async () => {
  const f = await fixture(3); await writeFile(join(f.root, "image.psd"), "unsupported");
  const service = new CorpusService({ selection, extract: async (root, path) => {
    if (path === "001.txt") throw new Error("Unreadable source");
    const value = await extract(root, path); return { ...value, complete: path !== "002.txt" };
  }, infer: async () => binary(.51) });
  const result = await service.query(f.workspace, { paths: ["."], question: "Does this document contain X?" });
  expect(result.counts).toEqual({ uncertain: 2, error: 1, unsupported: 1 });
  expect(result.results?.some(row => row.answer === "No")).toBe(false);
});

test("classification includes fallbacks and does not choose between conflicting passages", async () => {
  const f = await fixture(); let index = 0;
  const service = new CorpusService({ selection, extract: async () => ({ text: "Clause. ".repeat(18000), pages: [{ page: 1, text: "Clause. ".repeat(18000) }], complete: true, extraction: "native", hash: "source" }), infer: async request => {
    const question = request.questions.answer;
    if (question.type !== "choice") throw new Error("Expected classification");
    expect(Object.keys(question.criteria)).toContain("Not found"); expect(Object.keys(question.criteria)).toContain("Unclear");
    const choice = index++ === 0 ? "Germany" : "France";
    return { model: "jev", answers: { answer: { type: "choice", choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) } } };
  } });
  const result = await service.query(f.workspace, { paths: ["."], question: "Which governing law applies to this document?", kind: "classification", options: ["Germany", "France"] });
  expect(result.results?.[0].answer).toBe("Unclear"); expect(index).toBeGreaterThan(1);
});

test("folder resolution deduplicates, skips hidden entries, and rejects project escape", async () => {
  const f = await fixture(); await mkdir(join(f.root, "nested")); await writeFile(join(f.root, "nested", "other.txt"), "text");
  await writeFile(join(f.root, ".private"), "hidden"); await symlink(tmpdir(), join(f.root, "escape"));
  const result = await discoverCorpus(f.root, [".", "000.txt"]);
  expect(result.files).toHaveLength(2); expect(result.skipped).toBe(2);
  await expect(discoverCorpus(f.root, ["../"])).rejects.toThrow("project");
  await expect(discoverCorpus(f.root, ["escape"])).rejects.toThrow("symbolic");
});

test("question phrasing is guidance only, with no programmatic wording rejection", () => {
  for (const question of ["Which files contain X?", "Does this document contain X?", "Welche Dateien enthalten X?"])
    expect(() => validateDocumentQuestion(CorpusQuerySchema.parse({ paths: ["."], question }))).not.toThrow();
});

test("large jobs return a reference and cancellation drains unfinished documents", async () => {
  const f = await fixture(20);
  const service = new CorpusService({ selection, extract, infer: async (_request, _selection, signal) => {
    await new Promise<void>((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); });
    return binary(.99);
  } });
  const start = await service.query(f.workspace, { paths: ["."], question: "Does this document contain X?", waitSeconds: 0 });
  expect(start.status).toBe("running"); expect(start.results).toHaveLength(0);
  const cancelled = await service.query(f.workspace, { jobId: start.jobId, cancel: true });
  expect(cancelled.status).toBe("cancelled"); expect(cancelled.processed).toBe(20);
});
