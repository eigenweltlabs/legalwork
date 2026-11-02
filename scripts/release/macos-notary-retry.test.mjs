import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../../apps/desktop/scripts/electron-after-sign.cjs", import.meta.url), "utf8");

function signingFixture(failures = {}) {
  const calls = [];
  const delays = [];
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    require(name) {
      if (name === "node:child_process") return {
        spawnSync(command, args) {
          calls.push([command, ...args]);
          return { status: failures[args[1]]?.shift() ?? 0 };
        },
      };
      if (name === "node:timers/promises") return { setTimeout: async (ms) => { delays.push(ms); } };
      if (name === '../../../scripts/ci/timing.cjs') return { recordSpan() {} };
      return require(name);
    },
    process: { env: {
      MACOS_NOTARIZE: "true", APPLE_API_KEY_PATH: "/test/key.p8",
      APPLE_API_KEY: "test-key-id", APPLE_API_ISSUER: "test-issuer",
    } },
    console: { warn() {} },
  });
  const sign = () => module.exports({
    electronPlatformName: "darwin", appOutDir: "/test/mac",
    packager: { appInfo: { productFilename: "LegalWork" } },
  });
  return { sign, calls, delays };
}

test("recovers Apple ticket connection failures during both staple and validation without resubmitting", async () => {
  const fixture = signingFixture({ staple: [68, 0], validate: [68, 68, 0] });
  await fixture.sign();
  assert.equal(fixture.calls.filter((call) => call[1] === "notarytool").length, 1);
  assert.deepEqual(fixture.calls.filter((call) => call[1] === "stapler").map((call) => call[2]),
    ["staple", "staple", "validate", "validate", "validate"]);
  assert.deepEqual(fixture.delays, [15_000, 15_000, 30_000]);
});

for (const action of ["staple", "validate"]) {
  test(`fails closed after five Apple ticket service failures in ${action}`, async () => {
    const fixture = signingFixture({ [action]: [68, 68, 68, 68, 68, 0] });
    await assert.rejects(fixture.sign(), new RegExp(`stapler ${action} .*status 68`));
    assert.equal(fixture.calls.filter((call) => call[1] === "stapler" && call[2] === action).length, 5);
    assert.equal(fixture.calls.filter((call) => call[1] === "notarytool").length, 1);
    assert.deepEqual(fixture.delays, [15_000, 30_000, 60_000, 60_000]);
    if (action === "staple") assert.ok(!fixture.calls.some((call) => call[2] === "validate"));
  });
}

test("permanent validation errors fail immediately", async () => {
  const fixture = signingFixture({ validate: [65, 0] });
  await assert.rejects(fixture.sign(), /stapler validate .*status 65/);
  assert.equal(fixture.calls.filter((call) => call[2] === "validate").length, 1);
  assert.deepEqual(fixture.delays, []);
});

test("successful notarization still staples and validates without waiting", async () => {
  const fixture = signingFixture();
  await fixture.sign();
  assert.deepEqual(fixture.calls.map((call) => call.slice(0, 3)), [
    ["ditto", "-c", "-k"], ["xcrun", "notarytool", "submit"],
    ["xcrun", "stapler", "staple"], ["xcrun", "stapler", "validate"],
  ]);
  assert.deepEqual(fixture.delays, []);
});
