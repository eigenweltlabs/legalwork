import { describe, expect, test } from "bun:test";
import { parseEigenweltCheckoutSelection } from "@legalwork/types/eigenwelt-checkout";

describe("native checkout choices", () => {
  test("accepts billing choices without trusting a client price or trial", () => {
    expect(parseEigenweltCheckoutSelection({ interval: "month", seats: 4, modelRegions: ["EU"], price: 0, trial: true }))
      .toEqual({ interval: "month", seats: 4 });
  });
  test.each([0, -1, 501, 1.5, "2", null])("rejects an invalid seat count: %s", seats => {
    expect(parseEigenweltCheckoutSelection({ interval: "year", seats })).toBeNull();
  });
  test("rejects incomplete choices and unsupported intervals", () => {
    for (const input of [{}, { interval: "week", seats: 1 }]) {
      expect(parseEigenweltCheckoutSelection(input)).toBeNull();
    }
  });
});
