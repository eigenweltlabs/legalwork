import { expect, test } from "bun:test";
import { ocrQuoteRegions, quoteRange } from "./highlights.js";

test("OCR highlights infer only the matching lines without model region IDs", () => {
  const regions = ["Unrelated clause", "Die Kündigungsfrist", "beträgt dreißig Tage.", "Another clause"].map((text, index) => ({ text, box: { x: .1, y: .1 + index * .1, width: .7, height: .05 } }));
  expect(ocrQuoteRegions(regions, "Die Kündigungsfrist\n beträgt dreißig Tage.")).toEqual([regions[1].box, regions[2].box]);
  expect(ocrQuoteRegions(regions, "Die Kündigungsfrist beträgt sechzig Tage.")).toEqual([]);
  expect(ocrQuoteRegions(regions, "")).toEqual([]);
  expect(ocrQuoteRegions([], "No position data")).toEqual([]);
});

test("quote locations preserve punctuation and only normalize layout whitespace", () => {
  const text = "Other. The fee is\n  EUR 1,000 (net). End.";
  const range = quoteRange(text, "The fee is EUR 1,000 (net).");
  expect(range && text.slice(range.start, range.end)).toBe("The fee is\n  EUR 1,000 (net).");
  expect(quoteRange(text, "The fee is EUR 2,000 (net).")).toBeNull();
  expect(quoteRange(text, "The fee is EUR 1,000 net.")).toBeNull();
});
