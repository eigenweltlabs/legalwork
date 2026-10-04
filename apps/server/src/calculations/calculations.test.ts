import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CalendarStore } from "../calendar/store.js";
import { calculateDeadline } from "../calendar/deadline-rules.js";
import { presentCalculation, validatePresentationSources } from "./present.js";
import { executePython } from "./python-runner.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { quoteRange } from "../document-preparation/highlights.js";

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "calculation-test-"));
  return { store: await CalendarStore.open(join(path, "db.sqlite")), workspace: { id: "project", name: "Demo", path, preset: "starter", workspaceType: "local" as const } };
}
const input = { rule: "de-zpo-period", region: "BE", triggerDate: "2026-01-12", duration: 2, unit: "weeks", source: "Personal service record" };
const signal = new AbortController().signal;

test("confirmation saves immutable receipts once, links sources, blocks background writes and crosses no projects", async () => {
  const { store, workspace } = await fixture();
  const calculation = store.recordCalculation(workspace.id, calculateDeadline(input), "code");
  const card = await presentCalculation(store, workspace, { title: "Ordinary response period", selection: "Two-week diary entry, not the absolute objection cutoff.", calculationIds: [calculation.id] }, signal);
  expect(card.runs[0].results[0].date).toBe("2026-01-26");
  expect(card.runs[0].steps.map(step => step.reason)).toEqual(calculation.trace);
  expect(() => store.create(workspace.id, { title: "Bypass", start: "2026-01-26", timeZone: "Europe/Berlin" }, calculation.id)).toThrow("requires review");
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
  const card = await presentCalculation(store, workspace, { title: "Check", selection: "Check", calculationIds: [calculation.id] }, signal);
  store.decidePresentation(workspace.id, card.id, "reject");
  expect(() => store.decidePresentation(workspace.id, card.id, "save")).toThrow("closed");
  const missing = store.recordPresentation({ ...card, id: crypto.randomUUID(), state: "pending", runs: [{ ...card.runs[0], origin: "assessment", status: "needs_information", results: [], steps: [], missingFacts: ["Whether and when a Vollstreckungsbescheid was ordered."] }] });
  expect(() => store.decidePresentation(workspace.id, missing.id, "save")).toThrow("Missing information");
  expect(store.list(workspace.id)).toHaveLength(0);
});

test("multiple independent clocks save atomically; altered and foreign receipts are refused", async () => {
  const { store, workspace } = await fixture();
  const receipts = [1, 2].map(duration => store.recordCalculation(workspace.id, calculateDeadline({ ...input, duration, unit: "months", triggerDate: "2026-01-31" }), "code"));
  const card = await presentCalculation(store, workspace, { title: "Appeal clocks", selection: "Independent periods from original anchor", calculationIds: receipts.map(item => item.id) }, signal);
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
});

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
  const first = await presentCalculation(store, workspace, { title: "Response", selection: "Initial selection", calculationIds: [receipt.id] }, signal);
  const next = await presentCalculation(store, workspace, { title: "Ordinary response", selection: "Corrected selection", calculationIds: [receipt.id], supersedes: first.id }, signal);
  expect(store.presentation(workspace.id, first.id).state).toBe("rejected");
  expect(() => store.decidePresentation(workspace.id, first.id, "save")).toThrow("closed");
  expect(store.decidePresentation(workspace.id, next.id, "save").itemIds).toHaveLength(1);
});
