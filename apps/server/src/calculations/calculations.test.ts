import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CalendarStore } from "../calendar/store.js";
import { calculateDeadline } from "../calendar/deadline-rules.js";
import { presentCalculation, validatePresentationSources } from "./present.js";
import { executePython } from "./python-runner.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { quoteRange } from "../document-preparation/highlights.js";
import { DocumentPreparation } from "../document-preparation/service.js";
import { OcrManager } from "../ocr/manager.js";
import { OcrService } from "../ocr/service.js";

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "calculation-test-"));
  return { store: await CalendarStore.open(join(path, "db.sqlite")), workspace: { id: "project", name: "Demo", path, preset: "starter", workspaceType: "local" as const } };
}
const input = { rule: "de-zpo-period", region: "BE", triggerDate: "2026-01-12", duration: 2, unit: "weeks", source: "Personal service record" };
const signal = new AbortController().signal;

test("show is the default: evidence does not write or require approval, an explicit save retains the receipt", async () => {
  const { store, workspace } = await fixture();
  const calculation = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const card = await presentCalculation(store, workspace, { title: "Response", selection: "Ordinary response period", calculationIds: [calculation.id] }, signal);
  expect(card.mode).toBe("show");
  expect(card.state).toBe("shown");
  expect(store.list(workspace.id)).toHaveLength(0);
  const item = store.create(workspace.id, { kind: "deadline", title: "Response", start: calculation.deadlineDay, timeZone: calculation.timeZone }, calculation.id);
  expect(item.provenance.kind).toBe("calculated");
  expect(item.verified).toBe(false);
  expect(store.list(workspace.id)).toHaveLength(1);
});

test("confirmation saves immutable receipts once, links sources, blocks background writes and crosses no projects", async () => {
  const { store, workspace } = await fixture();
  const calculation = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const card = await presentCalculation(store, workspace, { mode: "confirm", title: "Ordinary response period", selection: "Two-week diary entry, not the absolute objection cutoff.", calculationIds: [calculation.id] }, signal);
  expect(card.runs[0].results[0].date).toBe("2026-01-26");
  expect(card.runs[0].steps.map(step => step.reason)).toEqual(calculation.trace);
  expect(() => store.create(workspace.id, { title: "Bypass", start: "2026-01-26", timeZone: "Europe/Berlin" }, calculation.id)).toThrow("requires review");
  await presentCalculation(store, workspace, { title: "Same evidence", selection: "Showing evidence is not approval", mode: "show", calculationIds: [calculation.id] }, signal);
  expect(() => store.create(workspace.id, { kind: "deadline", title: "Bypass", start: "2026-01-26", timeZone: "Europe/Berlin" }, calculation.id)).toThrow("requires review");
  const existing = store.create(workspace.id, { title: "Existing entry", start: "2026-01-20" });
  expect(() => store.patch(workspace.id, existing.id, { revision: existing.revision, calculationId: calculation.id, start: "2026-01-26" })).toThrow("requires review");
  store.remove(workspace.id, existing.id, existing.revision);
  expect(() => store.presentation("another", card.id)).toThrow();
  const saved = store.decidePresentation(workspace.id, card.id, "save");
  expect(saved.state).toBe("saved");
  expect(store.decidePresentation(workspace.id, card.id, "save").itemIds).toEqual(saved.itemIds);
  expect(store.list(workspace.id)).toHaveLength(1);
  expect(store.list(workspace.id)[0].verified).toBe(true);
  expect(() => store.decidePresentation(workspace.id, card.id, "reject")).toThrow("closed");
});

test("rejection prevents stale approval and missing information cannot create a date", async () => {
  const { store, workspace } = await fixture();
  const calculation = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const card = await presentCalculation(store, workspace, { mode: "confirm", title: "Check", selection: "Check", calculationIds: [calculation.id] }, signal);
  store.decidePresentation(workspace.id, card.id, "reject");
  expect(() => store.decidePresentation(workspace.id, card.id, "save")).toThrow("closed");
  const missing = store.recordPresentation({ ...card, id: crypto.randomUUID(), state: "pending", runs: [{ ...card.runs[0], origin: "assessment", status: "needs_information", results: [], steps: [], missingFacts: ["Whether and when a Vollstreckungsbescheid was ordered."] }] });
  expect(() => store.decidePresentation(workspace.id, missing.id, "save")).toThrow("Missing information");
  expect(store.list(workspace.id)).toHaveLength(0);
});

test("multiple independent clocks save atomically; altered and foreign receipts are refused", async () => {
  const { store, workspace } = await fixture();
  const receipts = [1, 2].map(duration => store.recordCalculation(workspace.id, calculateDeadline({ ...input, duration, unit: "months", triggerDate: "2026-01-31" }), "code"));
  const card = await presentCalculation(store, workspace, { mode: "confirm", title: "Appeal clocks", selection: "Independent periods from original anchor", calculationIds: receipts.map(item => item.id) }, signal);
  expect(card.runs.map(run => run.results[0].date)).toEqual(["2026-03-02", "2026-03-31"]);
  store.recordPresentation({ ...card, id: crypto.randomUUID(), runs: [card.runs[0], { ...card.runs[1], results: [{ ...card.runs[1].results[0], date: "2026-04-01" }] }] });
  const invalid = store.recordPresentation({ ...card, id: crypto.randomUUID(), runs: [card.runs[0], { ...card.runs[1], results: [{ ...card.runs[1].results[0], calculationId: crypto.randomUUID() }] }] });
  expect(() => store.decidePresentation(workspace.id, invalid.id, "save")).toThrow();
  expect(store.list(workspace.id)).toHaveLength(0);
  const saved = store.decidePresentation(workspace.id, card.id, "save");
  expect(saved.itemIds).toHaveLength(2);
});

test("PDF evidence verifies literal text, highlights uniquely and invalidates on change", async () => {
  const { store, workspace } = await fixture();
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Personally served 12 January 2026. Reply within two weeks.", { x: 30, y: 700, size: 12, font });
  await writeFile(join(workspace.path, "order.pdf"), await pdf.save());
  const calculation = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const raw = { title: "Response", selection: "Ordinary response period", calculationIds: [calculation.id], sources: [{ path: "order.pdf", page: 1, quote: "Personally served 12 January 2026." }] };
  const card = await presentCalculation(store, workspace, raw, signal);
  expect(card.sources[0].hash).toHaveLength(64);
  await expect(presentCalculation(store, workspace, { ...raw, sources: [{ ...raw.sources[0], quote: "Reply within four weeks." }] }, signal)).rejects.toThrow();
  expect(quoteRange("Due tomorrow. Due tomorrow.", "Due tomorrow.")).toBeNull();
  await writeFile(join(workspace.path, "order.pdf"), "changed");
  await expect(validatePresentationSources(workspace, card.sources)).rejects.toThrow("source changed");
});

test("the original DeadlineBench Cologne scan prepares OCR once for multiple verified passages", async () => {
  const { store, workspace } = await fixture();
  const bytes = await readFile(new URL("../../../../docs/demos/deadlinebench/koeln/gerichtliche-verfuegung.pdf", import.meta.url));
  await writeFile(join(workspace.path, "order.pdf"), bytes);
  let calls = 0;
  const quotes = ["innerhalb einer Frist von weiteren zwei Wochen", "Diese Erwiderungsfrist läuft also vier Wochen nach Zustellung dieser Verfügung ab."];
  const preparation = new DocumentPreparation(new OcrManager(join(workspace.path, "ocr")), {
    layout: { fingerprint: "test", async detect() { return { model: "test", regions: [] }; } },
    snapshot: async () => ({ fingerprint: "test", service: new OcrService([{ info: { id: "test", label: "Test OCR", execution: "local", model: "test", languages: null, regions: true, warnings: [] }, async recognize() {
      calls++;
      return { text: quotes.join("\n"), regions: quotes.map((text, index) => ({ text, box: { x: 0.1, y: 0.5 + index / 10, width: 0.8, height: 0.05 } })), truncated: false };
    } }], "test") }),
  });
  const calculation = store.recordCalculation(workspace.id, calculateDeadline({ ...input, triggerDate: "2024-07-17", duration: 4, region: "NW" }), "code");
  const card = await presentCalculation(store, workspace, { title: "Klageerwiderung", selection: "Four weeks from evidenced service", calculationIds: [calculation.id], sources: quotes.map(quote => ({ path: "order.pdf", page: 1, quote })) }, signal, preparation);
  expect(card.runs[0].results[0].date).toBe("2024-08-14");
  expect(card.sources).toHaveLength(2);
  expect(card.sources[0].source).toBe("ocr");
  expect(card.sources[0].preparationPath).toBeTruthy();
  expect(card.sources[0].preparationPath).toBe(card.sources[1].preparationPath);
  expect(card.sources[0].hash).toBe("095c1570fb02523ba67ccd302b47a5e7e3f95401c26b4270d0546d7637d2b6e9");
  expect(calls).toBe(2); // The two original pages, not a new OCR run for each quote.
}, 15000);

test("original benchmark text evidence is verified without pretending it is a PDF page", async () => {
  const { store, workspace } = await fixture();
  const text = await readFile(new URL("../../../../docs/demos/deadlinebench/mahnbescheid/Mahnbescheid.txt", import.meta.url), "utf8");
  await writeFile(join(workspace.path, "Mahnbescheid.txt"), text);
  const calculation = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const raw = { title: "Evidence", selection: "Ordinary response only", calculationIds: [calculation.id], sources: [{ path: "Mahnbescheid.txt", quote: "Die spätere Verfahrensakte liegt nicht bei." }] };
  const card = await presentCalculation(store, workspace, raw, signal);
  expect(card.sources[0].page).toBeNull();
  expect(card.sources[0].source).toBe("native");
  await expect(presentCalculation(store, workspace, { ...raw, sources: [{ ...raw.sources[0], quote: "Die spätere Verfahrensakte ist vollständig." }] }, signal)).rejects.toThrow("exact, unique");
  await writeFile(join(workspace.path, "Mahnbescheid.txt"), text + text);
  await expect(presentCalculation(store, workspace, raw, signal)).rejects.toThrow("exact, unique");
});

const python = `from datetime import date, timedelta

def end(trigger, weeks):
    return (date.fromisoformat(trigger) + timedelta(weeks=weeks)).isoformat()

def calculate(inputs, recorder):
    if inputs["purpose"] == "absolute_cutoff":
        return {"status": "needs_information", "missingFacts": ["Whether and when a Vollstreckungsbescheid was ordered (§694(1) ZPO)."]}
    day = recorder.step("Two-week response period", "Count weeks from the service event", end, inputs["service"], 2)
    return {"status": "calculated", "results": [{"title": "Ordinary response", "date": day, "cutoff": "2026-01-26T23:00:00Z", "timeZone": "Europe/Berlin"}]}
`;
test("community code records actual function inputs/outputs; payment-order selection refuses a fabricated longstop", async () => {
  const ordinary = await executePython(python, { purpose: "ordinary_response", service: "2026-01-12" });
  expect(ordinary.result.results[0].date).toBe("2026-01-26");
  expect(ordinary.steps[0].inputs).toEqual({ trigger: "2026-01-12", weeks: 2 });
  expect(ordinary.steps[0].output).toBe("2026-01-26");
  expect(ordinary.steps[0].code).toContain("timedelta(weeks=weeks)");
  const absolute = await executePython(python, { purpose: "absolute_cutoff", service: "2026-01-12" });
  expect(absolute.result.status).toBe("needs_information");
  expect(absolute.result.results).toEqual([]);
  await expect(executePython(`def calculate(inputs, recorder):\n return {"status":"needs_information", "results":[{"title":"Wrong", "date":"2026-01-26", "cutoff":"2026-01-26T23:00:00Z", "timeZone":"Europe/Berlin"}]}`, {})).rejects.toThrow("Missing-information");
// Allow the shared VM cold boot and three isolated commands under software emulation.
}, 600000);

test("chat card envelopes cannot include executable bundles or grow past engine truncation limits", async () => {
  const { CalculationCardSchema } = await import("./schema.js");
  const { store, workspace } = await fixture();
  const receipt = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const card = await presentCalculation(store, workspace, { title: "Response", selection: "Ordinary response", calculationIds: [receipt.id] }, signal);
  const envelope = CalculationCardSchema.parse({ presentation: { ...card, runs: [{ ...card.runs[0], code: "x".repeat(300000) }] } });
  expect(JSON.stringify(envelope).length).toBeLessThan(1024);
  expect(envelope.presentation.id).toBe(card.id);
});

test("a replacement card retires the previous confirmation without changing its receipt", async () => {
  const { store, workspace } = await fixture();
  const receipt = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const first = await presentCalculation(store, workspace, { mode: "confirm", title: "Response", selection: "Initial selection", calculationIds: [receipt.id] }, signal);
  const next = await presentCalculation(store, workspace, { mode: "confirm", title: "Ordinary response", selection: "Corrected selection", calculationIds: [receipt.id], supersedes: first.id }, signal);
  expect(store.presentation(workspace.id, first.id).state).toBe("rejected");
  expect(() => store.decidePresentation(workspace.id, first.id, "save")).toThrow("closed");
  expect(store.decidePresentation(workspace.id, next.id, "save").itemIds).toHaveLength(1);
});
