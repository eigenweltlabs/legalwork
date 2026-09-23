import { describe, expect, test } from "bun:test";

import { describeImportFailures } from "../src/react-app/domains/settings/state/import-failures";

describe("describeImportFailures", () => {
  test("names the folder and the reason of a single failure", () => {
    expect(
      describeImportFailures([{ name: "skills/arbitration-clause-review", reason: "Description must be 1-1024 characters" }]),
    ).toBe("1 failed: arbitration-clause-review – Description must be 1-1024 characters");
  });

  test("summarises several failures behind the first one", () => {
    expect(
      describeImportFailures([
        { name: "skills/nda-review", reason: "No SKILL.md in that folder." },
        { name: "workflow-assistant-lease-review", reason: "EACCES: permission denied" },
        { name: "skills/dpa-check", reason: "EACCES: permission denied" },
      ]),
    ).toBe("3 failed: nda-review – No SKILL.md in that folder, and 2 more");
  });

  test("cuts a long reason short", () => {
    const line = describeImportFailures([{ name: "skills/a", reason: `Failed to read from GitHub (403): ${"x".repeat(400)}` }]);
    expect(line).toStartWith("1 failed: a – Failed to read from GitHub (403): xxx");
    expect(line).toEndWith("…");
    expect(line?.length).toBeLessThan(200);
  });

  test("returns null when nothing failed", () => {
    expect(describeImportFailures([])).toBeNull();
  });
});
