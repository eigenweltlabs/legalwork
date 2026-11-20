import { expect, test } from "bun:test";
import { reviewInvoiceWordingBatches } from "./timesheet-invoice-wording.js";

type ReviewLine = Parameters<typeof reviewInvoiceWordingBatches>[0][number];
function row(id: string): ReviewLine {
  return {
    id,
    narrative: "Drafing a memo",
    activity: "DFT",
    rules: {
      language: "English",
      narrativeExample: "",
      actionFirst: false,
      narrativeCorrections: {},
      uploaded: [],
    },
  };
}
function rowsFrom(prompt: string): ReviewLine[] {
  return JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2));
}

test("invoice wording checks every selected row in sequential bounded batches", async () => {
  const lines = Array.from({ length: 121 }, (_, i) => row(String(i)));
  const batchSizes: number[] = [];
  let active = false;
  let verifications = 0;
  const results = await reviewInvoiceWordingBatches(
    lines,
    async (prompt) => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      const batch = rowsFrom(prompt);
      batchSizes.push(batch.length);
      expect(prompt.length).toBeLessThanOrEqual(50_000);
      active = false;
      return JSON.stringify({
        suggestions: batch.map(({ id }) => ({
          id,
          narrative: "Drafting a memo",
          rule: "spelling",
        })),
      });
    },
    async () => {
      verifications++;
    },
    new AbortController().signal,
  );
  expect(batchSizes).toEqual([50, 50, 21]);
  expect(verifications).toBe(6);
  expect(results.map(({ id }) => id)).toEqual(lines.map(({ id }) => id));
});

test("long uploaded directives keep source scope and are reviewed in bounded passes", async () => {
  const line = row("1");
  line.rules.uploaded = ["firm", "client", "matter"].map((scope) => ({
    name: scope,
    scope,
    text: (scope + " ").repeat(2600),
  }));
  const returned = new Map<string, string>();
  const initial = line.narrative;
  const replacement = "Drafting memorandum";
  let passes = 0;
  const results = await reviewInvoiceWordingBatches(
    [line],
    async (prompt) => {
      expect(prompt.length).toBeLessThanOrEqual(50_000);
      const [part] = rowsFrom(prompt);
      for (const source of part.rules.uploaded)
        returned.set(
          source.scope,
          (returned.get(source.scope) ?? "") + source.text,
        );
      passes++;
      if (passes === 1) {
        expect(part.narrative).toBe(initial);
        return JSON.stringify({
          suggestions: [
            { id: line.id, narrative: replacement, rule: "uploadedGuideline" },
          ],
        });
      }
      expect(part.narrative).toBe(replacement);
      return '{"suggestions":[]}';
    },
    async () => {},
    new AbortController().signal,
  );
  expect(passes).toBeGreaterThan(1);
  for (const { scope, text } of line.rules.uploaded)
    expect(returned.get(scope)).toBe(text);
  expect(results.map(({ narrative }) => narrative)).toEqual([replacement]);
});

test("a later rejected model batch or changed snapshot cannot return partial advice", async () => {
  const lines = Array.from({ length: 51 }, (_, i) => row(String(i)));
  let pass = 0;
  const good = JSON.stringify({
    suggestions: [{ id: "0", narrative: "Drafting a memo", rule: "spelling" }],
  });
  const failed = reviewInvoiceWordingBatches(
    lines,
    async () => (++pass === 1 ? good : "invalid batch"),
    async () => {},
    new AbortController().signal,
  );
  await expect(failed).rejects.toThrow(/invalid wording suggestions/);
  expect(pass).toBe(2);
  pass = 0;
  let verifies = 0;
  const stale = reviewInvoiceWordingBatches(
    lines,
    async () => {
      pass++;
      return good;
    },
    async () => {
      if (++verifies === 3) throw new Error("The invoice draft changed");
    },
    new AbortController().signal,
  );
  await expect(stale).rejects.toThrow(/draft changed/);
  expect(pass).toBe(1);
});
