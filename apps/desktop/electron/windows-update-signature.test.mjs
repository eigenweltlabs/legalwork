import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createRequire } from "node:module";

// Exercise the installed dependency used by NsisUpdater. Only the Windows
// process boundary is simulated, so this also checks that pnpm applies our patch.
const { verifySignature } = createRequire(import.meta.url)("electron-updater/out/windowsExecutableCodeSignatureVerifier.js");
const publisher = "CN=Eigenwelt Labs UG (haftungsbeschränkt), O=Eigenwelt Labs UG (haftungsbeschränkt), C=DE";
const installer = "C:\\Users\\fixture\\pending\\LegalWork.exe";
const logger = { info() {}, warn() {}, error() {} };

function verification(t, { delay = 30_000, status = 0, subject = publisher, malformed = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls.push({ command, args, options });
    const deadline = setTimeout(() => {
      clearTimeout(completion);
      const error = Object.assign(new Error("Signature verification timed out"), { killed: true, signal: "SIGTERM" });
      callback(error, "", "");
    }, options.timeout);
    const completion = Number.isFinite(delay) ? setTimeout(() => {
      clearTimeout(deadline);
      callback(null, malformed ? "invalid JSON" : JSON.stringify({ Status: status, Path: installer, SignerCertificate: { Subject: subject } }), "");
    }, delay) : undefined;
    return {};
  });
  // Model modern PowerShell during the dependency's error-handling probe.
  t.mock.method(childProcess, "execFileSync", () => Buffer.from('"test"'));
  const result = verifySignature([publisher], installer, logger);
  let settled = false;
  result.then(() => { settled = true; }, () => { settled = true; });
  return { result, calls, settled: () => settled };
}

test("a valid Windows update can finish verification after the old 20-second limit", async t => {
  const check = verification(t);
  t.mock.timers.tick(20_001);
  await Promise.resolve();
  assert.equal(check.settled(), false, "a slow signature check must still be running");
  t.mock.timers.tick(9_999);
  assert.equal(await check.result, null);
  assert.equal(check.calls[0].options.timeout, 300_000);
});

test("a fast valid check completes immediately without waiting for the deadline", async t => {
  const check = verification(t, { delay: 1 });
  t.mock.timers.tick(1);
  assert.equal(await check.result, null);
});

for (const [status, reason] of [[2, "unsigned"], [3, "modified"], [4, "untrusted"]]) {
  test(`the longer deadline still rejects ${reason} installers`, async t => {
    const check = verification(t, { status });
    t.mock.timers.tick(30_000);
    assert.match(await check.result, /publisherNames:/);
  });
}

test("the longer deadline still rejects a different publisher", async t => {
  const check = verification(t, { subject: "CN=Unexpected publisher, C=DE" });
  t.mock.timers.tick(30_000);
  assert.match(await check.result, /Unexpected publisher/);
});

test("malformed signature output remains an error", async t => {
  const check = verification(t, { malformed: true });
  const rejected = assert.rejects(check.result, SyntaxError);
  t.mock.timers.tick(30_000);
  await rejected;
});

test("a hung Windows verifier still fails at the five-minute deadline", async t => {
  const check = verification(t, { delay: Infinity });
  const rejected = assert.rejects(check.result, /Signature verification timed out/);
  t.mock.timers.tick(299_999);
  await Promise.resolve();
  assert.equal(check.settled(), false);
  t.mock.timers.tick(1);
  await rejected;
});
