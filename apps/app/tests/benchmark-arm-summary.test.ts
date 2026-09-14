import { describe, expect, test } from "bun:test";
import {
  armRestrictions,
  armSummaryLine,
  isUnrestricted,
} from "../src/react-app/domains/benchmark/arm-summary";

/**
 * These mirror the server's normalization in apps/server/src/benchmarks/ablation.ts.
 * They must agree: the UI describing a restriction the run did not apply (or
 * hiding one it did) is worse than showing nothing.
 */
describe("armRestrictions", () => {
  test("the baseline arm restricts nothing", () => {
    expect(isUnrestricted({})).toBe(true);
    expect(isUnrestricted(undefined)).toBe(true);
    expect(armSummaryLine({})).toBe("everything available");
  });

  test("lists only the tools actually switched off", () => {
    const { tools } = armRestrictions({ tools: { bash: false, webfetch: true, edit: false } });
    // An enabled tool is not a restriction and must not be listed as one.
    expect(tools).toEqual(["bash", "edit"]);
    expect(armSummaryLine({ tools: { bash: false } })).toBe("no bash");
  });

  test("an allow-list of nothing means no skills, not 'only nothing'", () => {
    expect(armRestrictions({ skills: { mode: "allow", names: [] } }).skills).toEqual({ kind: "none" });
    expect(armSummaryLine({ skills: { mode: "allow", names: [] } })).toBe("no skills or workflows");
  });

  test("a deny-list of nothing denies nothing", () => {
    expect(armRestrictions({ skills: { mode: "deny", names: [] } }).skills).toEqual({ kind: "all" });
    expect(isUnrestricted({ skills: { mode: "deny", names: [] } })).toBe(true);
  });

  test("named policies survive normalization", () => {
    expect(armRestrictions({ skills: { mode: "allow", names: ["tabular-review"] } }).skills).toEqual({
      kind: "allow",
      names: ["tabular-review"],
    });
    expect(armRestrictions({ skills: { mode: "deny", names: ["tabular-review"] } }).skills).toEqual({
      kind: "deny",
      names: ["tabular-review"],
    });
  });

  test("mode 'all' and 'none' pass through", () => {
    expect(armRestrictions({ skills: { mode: "all" } }).skills).toEqual({ kind: "all" });
    expect(armRestrictions({ skills: { mode: "none" } }).skills).toEqual({ kind: "none" });
  });

  test("a tool and a skill ablation read as one line", () => {
    expect(armSummaryLine({ tools: { bash: false }, skills: { mode: "none" } })).toBe(
      "no bash; no skills or workflows",
    );
  });

  test("an arm with any restriction is not unrestricted", () => {
    expect(isUnrestricted({ tools: { bash: false } })).toBe(false);
    expect(isUnrestricted({ skills: { mode: "none" } })).toBe(false);
    expect(isUnrestricted({ skills: { mode: "allow", names: ["x"] } })).toBe(false);
  });
});
