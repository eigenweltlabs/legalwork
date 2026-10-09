import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSignPathConfig } from "./validate-signpath-config.mjs";

const config = {
  SIGNPATH_API_TOKEN: "test-token",
  SIGNPATH_ORGANIZATION_ID: "organization",
  SIGNPATH_PROJECT_SLUG: "legalwork",
  SIGNPATH_SIGNING_POLICY_SLUG: "release-signing",
  SIGNPATH_ARTIFACT_CONFIGURATION_SLUG: "windows-installer",
};

test("release and isolated test modes require their own signing policies", () => {
  assert.doesNotThrow(() => validateSignPathConfig(config));
  assert.throws(() => validateSignPathConfig({ ...config, SIGNPATH_SIGNING_POLICY_SLUG: "test-signing" }), /must never be published/);
  assert.throws(() => validateSignPathConfig({ ...config, SIGNPATH_TEST: "true" }), /Expected SignPath policy test-signing/);
  assert.doesNotThrow(() => validateSignPathConfig({ ...config, SIGNPATH_TEST: "true", SIGNPATH_SIGNING_POLICY_SLUG: "test-signing" }));
});

test("partial configuration fails without exposing the API token", () => {
  for (const name of Object.keys(config)) {
    assert.throws(() => validateSignPathConfig({ ...config, [name]: " " }), (error) => {
      assert.match(error.message, new RegExp(name));
      assert.ok(!error.message.includes(config.SIGNPATH_API_TOKEN));
      return true;
    });
  }
});
