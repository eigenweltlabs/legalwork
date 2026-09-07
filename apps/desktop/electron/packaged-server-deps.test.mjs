import { test } from "node:test";
import assert from "node:assert/strict";

import { findServerDepDrift } from "../scripts/check-server-deps.mjs";

// A missing mirror only surfaces after packaging -- the alpha/release workflows
// go straight from install to build:electron, so catch it here on every PR too.
test("desktop mirrors every server runtime dependency for the packaged asar", () => {
  const { missing, mismatched } = findServerDepDrift();
  assert.deepEqual(
    missing,
    [],
    `apps/desktop/package.json is missing server runtime deps: ${missing.join(", ")}`,
  );
  assert.deepEqual(mismatched, [], `Version ranges drifted from apps/server: ${mismatched.join(", ")}`);
});
