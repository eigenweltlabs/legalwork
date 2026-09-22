import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("action journal ambiguity and retry contract runs on encrypted SQLite in actual Node", () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Actual Node is required for the encrypted mail contract");
  const runner = fileURLToPath(new URL("../../../scripts/mail-acceptance.mjs", import.meta.url));
  const result = spawnSync(node, [runner, "--suite", "storage/action-journal"], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.status).toBe(0);
}, 185_000);
