import { expect, test } from "bun:test";
import { dictationMeterLevel } from "../src/react-app/domains/recorder/dictation-meter";

test("quiet speech is visible and louder input increases the current level", () => {
  const quiet = dictationMeterLevel(new Float32Array(512).fill(0.005));
  const loud = dictationMeterLevel(new Float32Array(512).fill(0.05));
  expect(quiet).toBeGreaterThan(0.1);
  expect(quiet).toBeLessThan(0.25);
  expect(loud).toBeGreaterThan(quiet);
  expect(loud).toBeLessThanOrEqual(1);
  const alternating = Float32Array.from({ length: 512 }, (_, index) => index % 2 ? -0.005 : 0.005);
  expect(dictationMeterLevel(alternating)).toBeCloseTo(quiet);
});

test("silence and room noise rest at zero without a jump at the noise floor", () => {
  expect(dictationMeterLevel(new Float32Array(512))).toBe(0);
  expect(dictationMeterLevel(new Float32Array(512).fill(0.001))).toBe(0);
  expect(dictationMeterLevel(new Float32Array(0))).toBe(0);
  expect(dictationMeterLevel(new Float32Array(512).fill(0.001501))).toBeLessThan(0.02);
});
