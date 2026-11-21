import { expect, test } from "bun:test";
import { z } from "zod";
import { generateModelJson } from "./model-json.js";
import { extractGuidelineRules } from "./guideline-rules.js";

test("a real-model style notes string is repaired without accepting it as reviewed rules", async () => {
  const text = "Bill in six-minute units.";
  let attempts = 0;
  const result = await extractGuidelineRules(text, async prompt => {
    attempts++;
    expect(prompt).toContain('"notes"');
    return JSON.stringify({ rules: { incrementMinutes: 6 }, evidence: { incrementMinutes: text },
      notes: attempts === 1 ? "No other numerical rules." : ["No other numerical rules."] });
  });
  expect(attempts).toBe(2);
  expect(result).toEqual({ rules: { incrementMinutes: 6 }, evidence: { incrementMinutes: text }, notes: ["No other numerical rules."] });
});

test("trailing commentary triggers one format repair with the original scoped request", async () => {
  const schema = z.strictObject({ wording: z.array(z.strictObject({ index: z.number().int(), narrative: z.string() })) });
  const value = { wording: [{ index: 0, narrative: "Entwerfen der Revision" }] };
  const prompts: string[] = [];
  const result = await generateModelJson("Only matter A and its approved guidance.", schema, async prompt => {
    prompts.push(prompt);
    return JSON.stringify(value) + (prompts.length === 1 ? "\n\nAn explanatory note." : "");
  }, () => Error("Invalid model output"));
  expect(result).toEqual(value);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Only matter A and its approved guidance.");
  expect(prompts[1]).not.toContain("An explanatory note.");
});

test("invalid output remains rejected after two attempts; provider and cancellation errors are not retried", async () => {
  const schema = z.strictObject({ value: z.number() });
  const invalid = new Error("Invalid model output");
  let attempts = 0;
  await expect(generateModelJson("Request", schema, async () => { attempts++; return '{"value":"wrong"}'; }, () => invalid)).rejects.toBe(invalid);
  expect(attempts).toBe(2);
  for (const error of [new Error("Provider unavailable"), new DOMException("Cancelled", "AbortError")]) {
    attempts = 0;
    await expect(generateModelJson("Request", schema, async () => { attempts++; throw error; }, () => invalid)).rejects.toBe(error);
    expect(attempts).toBe(1);
  }
});

test("a well-formed rule without supporting evidence is rejected without a model repair", async () => {
  let attempts = 0;
  await expect(extractGuidelineRules("Bill in six-minute units.", async () => {
    attempts++;
    return JSON.stringify({ rules: { incrementMinutes: 6 }, evidence: { incrementMinutes: "Invented source passage" }, notes: [] });
  })).rejects.toThrow("no matching source passage");
  expect(attempts).toBe(1);
});
