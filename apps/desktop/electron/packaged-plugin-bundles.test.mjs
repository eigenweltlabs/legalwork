import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
    "shared.js": 'import { createHash } from "crypto";\nexport const x = 1;\n',
  });
  assert.deepEqual(findUnresolvableImports(dir), []);
});

test("dynamic imports of a bare specifier are reported", () => {
  const dir = fixture({ "a.js": 'await import("zod");\n' });
  assert.deepEqual(findUnresolvableImports(dir), [{ file: "a.js", imports: ["zod"] }]);
});

test("multi-line imports and re-exports are reported", () => {
  const dir = fixture({
    "a.js": 'import {\n  a,\n  b as c\n} from "zod";\nexport * from "yaml";\nexport { d } from "./d.js";\n',
  });
  assert.deepEqual(findUnresolvableImports(dir), [{ file: "a.js", imports: ["yaml", "zod"] }]);
});

// The task tools read a mail's sender under "from"; reading that string as an
// import failed the alpha build.
test('a string that reads "from" is not an import', () => {
  const dir = fixture({
    "a.js": 'const sender = pick(a, ["submitter", "from"]) || pick(b, ["from", "sender"]);\n',
  });
  assert.deepEqual(findUnresolvableImports(dir), []);
});

// electron-builder filters these out, so they must not fail the build.
test("compiled test files are ignored", () => {
  const dir = fixture({ "a.test.js": 'import { test } from "bun:test";\n' });
  assert.deepEqual(findUnresolvableImports(dir), []);
});

test("native plugin host modules and their subpaths remain external in nested entrypoints", () => {
  const dir = fixture({});
  const plugin = join(dir, "native");
  mkdirSync(plugin);
  writeFileSync(join(plugin, "index.js"), 'import { Plugin } from "@opencode/plugin";\nimport { Effect } from "effect";\nimport "@opencode/plugin/effect/tool";\nimport("effect/Schema");\n');
  assert.deepEqual(findUnresolvableImports(dir), []);
  writeFileSync(join(plugin, "index.js"), 'import { Plugin } from "@opencode/plugin";\nimport { z } from "zod";\n');
  assert.deepEqual(findUnresolvableImports(dir), [{ file: join("native", "index.js"), imports: ["zod"] }]);
});

// A developer's complete dependency tree can hide missing optional peers in
// the normal packaged app. Load the real transport with Redis unavailable.
function browserHttpImport(specifier) {
  const require = createRequire(import.meta.url);
  const transport = pathToFileURL(require.resolve(specifier)).href;
  const loader = `export async function resolve(specifier, context, next) {
    if (specifier === "redis" || specifier.startsWith("redis/")) {
      throw Object.assign(new Error("Redis is intentionally unavailable in the packaged browser closure"), {code:"ERR_MODULE_NOT_FOUND"});
    }
    return next(specifier, context);
  }`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { register } from "node:module";
    import assert from "node:assert/strict";
    register(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(loader).toString("base64")}`)});
    const transport = await import(${JSON.stringify(transport)});
    assert.ok((transport.NodeHttpClient ?? transport).layerNodeHttp);
  `], { encoding: "utf8" });
}

test("the packaged browser HTTP transport loads without unrelated optional peers", () => {
  const upstream = readFileSync(new URL("./browser-native/upstream/pane.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./browser-native/runtime/pane.mjs", import.meta.url), "utf8");
  const sourceSpecifier = /from "(@effect\/platform-node[^\"]*)"/.exec(upstream)?.[1];
  const runtimeSpecifier = /from "(@effect\/platform-node[^\"]*)"/.exec(runtime)?.[1];
  assert.equal(sourceSpecifier, "@effect/platform-node/NodeHttpClient");
  assert.equal(runtimeSpecifier, sourceSpecifier);
  const result = browserHttpImport(runtimeSpecifier);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the former browser barrel import reproduces the missing-peer failure", () => {
  const result = browserHttpImport("@effect/platform-node");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Redis is intentionally unavailable in the packaged browser closure/);
});
