import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("encrypted mail database contract runs in an actual Node subprocess", () => {
  const result = spawnSync("node", ["--experimental-strip-types", "--test", fileURLToPath(new URL("./database.node-test.mjs", import.meta.url))], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.status).toBe(0);
}, 65_000);
