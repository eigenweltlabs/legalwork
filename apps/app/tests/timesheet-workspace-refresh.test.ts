import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("invoice editing survives transient Back Office read failures and clears on revoked access", () => {
  const fixture = fileURLToPath(new URL("./fixtures/timesheet-workspace-refresh.tsx", import.meta.url));
  const result = Bun.spawnSync([process.execPath, fixture], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Timesheet workspace refresh regressions passed");
}, 30_000);
