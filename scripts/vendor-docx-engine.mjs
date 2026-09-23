// Rebuild the offline Word engine from the same patched dependencies as the UI.
// Run after updating document-parser dependencies, then regenerate core skills.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRequire = createRequire(path.join(root, "apps/app/package.json"));
const { build } = appRequire("esbuild");
await build({
  absWorkingDir: root,
  entryPoints: ["apps/app/node_modules/@eigenpal/docx-editor-agents/dist/index.mjs"],
  outfile: "apps/server/resources/core-opencode/skills/docx-edit/assets/vendor/docx-engine.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
});
const generated = spawnSync(process.execPath, ["scripts/gen-core-skills.mjs"], { cwd: root, stdio: "inherit" });
if (generated.error) throw generated.error;
process.exit(generated.status ?? 1);
