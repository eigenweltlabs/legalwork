import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("project fields can be defined, filled and left empty without losing their identity", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/project-field-flow.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Project field flow passed");
}, 30_000);
