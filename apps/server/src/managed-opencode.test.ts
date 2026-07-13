import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManagedOpencodeServer } from "./managed-opencode.js";

// A stand-in for the opencode binary: it fails the first
// FAKE_OPENCODE_FAIL_UNTIL starts with the same "database is locked" message a
// not-yet-reaped predecessor produces, then comes up healthy. Invocation count
// is tracked in a file so the test can assert how many attempts happened.
const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require("node:fs");
const counter = process.env.FAKE_OPENCODE_COUNTER;
const failUntil = Number(process.env.FAKE_OPENCODE_FAIL_UNTIL || "0");
let n = 0;
try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
n += 1;
fs.writeFileSync(counter, String(n));
const portIdx = process.argv.indexOf("--port");
const port = portIdx >= 0 ? process.argv[portIdx + 1] : "0";
if (n <= failUntil) {
  process.stderr.write("Error: Unexpected error\\n\\ndatabase is locked\\n");
  process.exit(1);
}
process.stdout.write("opencode server listening on http://127.0.0.1:" + port + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function fakeBin(failUntil: number): { bin: string; counter: string } {
  dir = mkdtempSync(join(tmpdir(), "managed-opencode-"));
  const bin = join(dir, "fake-opencode");
  const counter = join(dir, "counter");
  writeFileSync(bin, FAKE_OPENCODE, "utf8");
  chmodSync(bin, 0o755);
  return { bin, counter };
}

test("retries the engine spawn while the DB is locked, then succeeds", async () => {
  const { bin, counter } = fakeBin(2); // fail twice, succeed on the 3rd
  const server = await createManagedOpencodeServer({
    bin,
    cwd: dir!,
    env: { FAKE_OPENCODE_COUNTER: counter, FAKE_OPENCODE_FAIL_UNTIL: "2" },
  });
  try {
    expect(server.url).toContain("http://127.0.0.1:");
    expect(Number(readFileSync(counter, "utf8"))).toBe(3); // 2 locked + 1 healthy
  } finally {
    await server.close();
  }
}, 20000);

test("does NOT retry a non-lock start failure (fails fast)", async () => {
  // fail "forever" but with a lock message would retry; use a bin that exits
  // with a different error so the loop must give up on the first attempt.
  dir = mkdtempSync(join(tmpdir(), "managed-opencode-"));
  const bin = join(dir, "fake-opencode");
  const counter = join(dir, "counter");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const counter = process.env.FAKE_OPENCODE_COUNTER;
let n = 0; try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
fs.writeFileSync(counter, String(n + 1));
process.stderr.write("Error: config parse failed\\n");
process.exit(1);
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  await expect(
    createManagedOpencodeServer({ bin, cwd: dir, env: { FAKE_OPENCODE_COUNTER: counter } }),
  ).rejects.toThrow(/config parse failed/);
  expect(Number(readFileSync(counter, "utf8"))).toBe(1); // exactly one attempt
}, 20000);
