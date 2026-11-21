import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("time record sheet keeps drafts private, preserves write revisions and copies between dates", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/time-record-sheet.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Time record sheet regressions passed");
}, 30_000);
