import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Back Office and Project Home share simple creation and preserve named roles and inherited clients", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/back-office-simple-flow.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Simple Back Office flow passed");
}, 30_000);
