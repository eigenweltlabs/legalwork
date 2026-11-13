import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("record drafts survive failed saves and background refreshes", () => {
  // Isolate DOM globals from the other server-rendered component tests.
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/back-office-editing.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("All editing regressions passed");
}, 30_000);
