/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalculationPresentation, CalculationRun } from "@legalwork/types/calculation";
import { CalculationSheet } from "../src/components/chat/calculation/calculation-sheet";
import { calculationSources, calculationSteps, cutoffText } from "../src/components/chat/calculation/calculation-display";

const run: CalculationRun = {
  id: "run", skill: "de-civil-deadlines", version: "2026.10.04.1", codeHash: "secret-hash", createdAt: "2026-10-04T00:00:00Z", origin: "skill", status: "calculated",
  inputs: { rule: "de-zpo-period", triggerDate: "2024-07-17", triggerType: "service", duration: 4, unit: "weeks", region: "NW", direction: "after", source: "gerichtliche-verfuegung.pdf" },
  steps: [
    { title: "1", reason: "Start on 2024-07-18, excluding the event day (§187(1)).", inputs: {}, output: null },
    { title: "2", reason: "4 weeks from 2024-07-17; nominal end 2024-08-14 (§188).", inputs: {}, output: null },
    { title: "3", reason: "Weekend and statutory-holiday check passed for 2024-08-14 (NW).", inputs: {}, output: null },
    { title: "4", reason: "End of day 2024-08-14 (Europe/Berlin); exclusive boundary at midnight on 2024-08-15.", inputs: {}, output: null },
  ],
  results: [{ title: "de-zpo-period", date: "2024-08-14", cutoff: "2024-08-14T22:00:00.000Z", timeZone: "Europe/Berlin", calculationId: "result" }],
  missingFacts: [], sources: [], code: "var ZodObject = secret_dependency_bundle;",
};
const source = { path: "gerichtliche-verfuegung.pdf", hash: "hash", page: 1, quote: "First passage", source: "ocr" } satisfies CalculationPresentation["sources"][number];
const card: CalculationPresentation = { id: "card", workspaceId: "project", title: "Klageerwiderung", selection: "Vier Wochen ab Zustellung gemäß gerichtlicher Verfügung.", mode: "confirm", state: "pending", runs: [run], sources: [source, { ...source, path: "./gerichtliche-verfuegung.pdf", quote: "Second passage" }, { ...source, page: 2, quote: "Third passage" }], itemIds: [], createdAt: "2026-10-04T00:00:00Z" };
function render(value = card) { return renderToStaticMarkup(<CalculationSheet card={value} onSource={() => {}} onDecision={() => {}} />); }

test("court-order card retains the executed dates and checks without exposing bundles or machine timestamps", () => {
  const html = render();
  expect(html).toContain("4 weeks");
  expect(html).toContain("Jul 18");
  expect(html).toContain("Aug 14");
  expect(html).toContain("Check weekends and holidays");
  expect(html).toContain("Nordrhein-Westfalen");
  expect(html).toContain("24:00");
  for (const technical of ["ZodObject", "secret-hash", "secret_dependency_bundle", "2024-08-14T22", "de-zpo-period", "exclusive boundary"]) expect(html).not.toContain(technical);
  expect(html).toContain("Save to calendar");
  expect(html).toContain(">Change<");
  expect(html).not.toContain(">Correct<");
});
test("three passages in one file use one source button, with all highlights preserved", () => {
  const groups = calculationSources(card.sources);
  expect(groups).toHaveLength(1);
  expect(groups[0].sources).toHaveLength(3);
  expect(render().match(/gerichtliche-verfuegung.pdf/g)).toHaveLength(1);
  expect(render()).toContain("3 passages");
  expect(calculationSources([...card.sources, source])[0].sources).toHaveLength(3);
  expect(calculationSources([source, { ...source, path: "another/gerichtliche-verfuegung.pdf" }])).toHaveLength(2);
});
test("a timed cutoff stays timed, and a next-day midnight is shown as end of the deadline day", () => {
  expect(cutoffText(run.results[0])).toContain("24:00");
  expect(cutoffText({ ...run.results[0], cutoff: "2024-08-14T14:00:00Z" })).toMatch(/4:00 PM|16:00/);
  expect(cutoffText({ ...run.results[0], cutoff: "2024-08-14T00:00:00Z" })).not.toContain("24:00");
});
test("unrecognized custom decisions stay visible while raw intermediate inputs do not", () => {
  const custom = { ...run, steps: [{ title: "Court-ordered suspension", reason: "Exclude the suspension ending 2024-08-01; the resumed period ends 2024-08-14.", inputs: { elapsedMilliseconds: 1209600000 }, output: "2024-08-14" }] };
  const html = render({ ...card, runs: [custom] });
  expect(html).toContain("Court-ordered suspension");
  expect(html).toContain("Aug 1");
  expect(html).toContain("Aug 14");
  expect(html).not.toContain("1209600000");
  expect(calculationSteps(custom)).toHaveLength(1);
});
test("missing service evidence cannot present a calendar save action", () => {
  const html = render({ ...card, runs: [{ ...run, status: "needs_information", origin: "assessment", steps: [], results: [], missingFacts: ["The service date is missing."] }] });
  expect(html).toContain("The service date is missing.");
  expect(html).toContain("Clarify information");
  expect(html).not.toContain("Save to calendar");
});
test("show mode keeps evidence and necessary questions visible without approval buttons", () => {
  const shown = { ...card, mode: "show", state: "shown" } satisfies CalculationPresentation;
  const html = render(shown);
  expect(html).toContain("Aug 14");
  expect(html).toContain("gerichtliche-verfuegung.pdf");
  expect(html).not.toContain("Save to calendar");
  expect(html).not.toContain(">Change<");
  const missing = render({ ...shown, runs: [{ ...run, status: "needs_information", origin: "assessment", steps: [], results: [], missingFacts: ["When was the order served?"] }] });
  expect(missing).toContain("When was the order served?");
  expect(missing).not.toContain("Clarify information");
  expect(missing).not.toContain("Save to calendar");
});
test("a holiday rollover never ends with a misleading no-adjustment label", () => {
  const steps = calculationSteps({ ...run, steps: [
    { title: "1", reason: "2026-11-18 is not a working day; advance one day.", inputs: {}, output: null },
    { title: "2", reason: "Weekend and statutory-holiday check passed for 2026-11-19 (SN, Dresden).", inputs: {}, output: null },
  ] });
  expect(steps[0].reason).toContain("Nov 18");
  expect(steps[1].value).toBe("Adjusted date confirmed");
});
