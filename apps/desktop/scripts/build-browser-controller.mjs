import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(desktop, "../server/package.json"));
const ts = require("typescript");
const source = resolve(desktop, "electron/browser-native/upstream");
const target = resolve(desktop, "electron/browser-native/runtime");
const check = process.argv.includes("--check");
if (!check) mkdirSync(target, { recursive: true });
for (const name of readdirSync(source).filter(name => name.endsWith(".ts"))) {
  const code = ts.transpileModule(readFileSync(resolve(source, name), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false },
    fileName: name,
  }).outputText.replace(/(from\s+|import\()(["'])(\.\.?\/[^"']+)\2/g, (whole, prefix, quote, path) =>
    /\.[cm]?js$/.test(path) ? whole : `${prefix}${quote}${path}.mjs${quote}`);
  const filename = resolve(target, name.replace(/\.ts$/, ".mjs"));
  const generated = `// @ts-nocheck\n// Generated from ../upstream/${name}; OpenCode v2.1.4, MIT. Run scripts/build-browser-controller.mjs.\n${code}`;
  if (check) { if (readFileSync(filename, "utf8") !== generated) throw new Error(`Browser controller is stale: ${filename}. Run scripts/build-browser-controller.mjs.`); }
  else writeFileSync(filename, generated);
}
