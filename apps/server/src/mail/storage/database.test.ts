import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("encrypted mail database contract runs in an actual Node subprocess", () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Actual Node is required for the encrypted database contract");
  const runner = fileURLToPath(new URL("../../../scripts/mail-acceptance.mjs", import.meta.url));
  const result = spawnSync(node, [runner, "--suite", "storage/database"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.status).toBe(0);
}, 65_000);
