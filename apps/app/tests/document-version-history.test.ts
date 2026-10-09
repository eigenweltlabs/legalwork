import { expect, test } from "bun:test";
import { appendDocxVersion } from "../src/react-app/domains/session/artifacts/docx-recovery";

test("rapid autosaves retain the original and manual saves; long sessions retain bounded checkpoints", () => {
  const original = new ArrayBuffer(1), edited = new ArrayBuffer(2), manual = new ArrayBuffer(3);
  let versions = appendDocxVersion([], original, false, 0);
  for (let second = 1; second < 300; second++) versions = appendDocxVersion(versions, edited, true, second * 1000);
  expect(versions.map((version) => version.buffer)).toEqual([edited, original]);
  expect(versions[0].savedAt).toBe(1000);
  versions = appendDocxVersion(versions, edited, true, 301_000);
  expect(versions).toHaveLength(3);
  versions = appendDocxVersion(versions, manual, false, 302_000);
  versions = appendDocxVersion(versions, edited, true, 303_000);
  expect(versions.map((version) => version.buffer)).toEqual([edited, manual, edited, edited, original]);
  versions = appendDocxVersion(versions, edited, true, 304_000);
  expect(versions[1].buffer).toBe(manual);
  versions = appendDocxVersion(versions, edited, true, 603_000);
  expect(versions).toHaveLength(5);
  expect(versions.some((version) => version.buffer === original)).toBe(false);
});
