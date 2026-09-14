import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findUnresolvableImports } from "../scripts/check-plugin-bundles.mjs";

const fixture = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-bundles-"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source, "utf8");
  return dir;
};

// The packaged plugins sit outside every node_modules tree, so a bare import
// makes the engine skip the plugin silently and its tools never register.
test("a bare dependency import is reported", () => {
  const dir = fixture({ "a.js": 'import { z } from "zod";\nexport const A = async () => ({});\n' });
  assert.deepEqual(findUnresolvableImports(dir), [{ file: "a.js", imports: ["zod"] }]);
});

test("node: builtins and relative imports are fine", () => {
  const dir = fixture({
    "a.js": 'import { join } from "node:path";\nimport { x } from "./shared.js";\nimport("node:fs/promises");\n',
    "shared.js": "export const x = 1;\n",
  });
  assert.deepEqual(findUnresolvableImports(dir), []);
});

test("dynamic imports of a bare specifier are reported", () => {
  const dir = fixture({ "a.js": 'await import("zod");\n' });
  assert.deepEqual(findUnresolvableImports(dir), [{ file: "a.js", imports: ["zod"] }]);
});

// electron-builder filters these out, so they must not fail the build.
test("compiled test files are ignored", () => {
  const dir = fixture({ "a.test.js": 'import { test } from "bun:test";\n' });
  assert.deepEqual(findUnresolvableImports(dir), []);
});
