import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("keyboard entry, revision edits and a fresh whole-row clipboard draft in the Back Office grid", () => {
  const fixture = fileURLToPath(new URL("./fixtures/timesheet-ledger.tsx", import.meta.url));
  const result = Bun.spawnSync([process.execPath, fixture], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Timesheet ledger passed");
}, 30_000);
