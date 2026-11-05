import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pluginNames = [
  "legalwork-managed-config", "legalwork-legalmemory", "legalwork-commands", "legalwork-project-admission", "legalwork-product-scope", "legalwork-sandbox", "legalwork-extensions-preview",
  "legalwork-capabilities-knowledge", "legalwork-legalmemory-knowledge", "legalwork-digest-tools", "legalwork-history-image-tools", "legalwork-tool-image-original-capture", "legalwork-tool-image-originals",
  "legalwork-anthropic-adaptive-thinking", "legalwork-anthropic-tool-schema", "legalwork-openai-tool-call-ids",
  "legalwork-word-tools", "legalwork-excel-tools", "legalwork-powerpoint-tools", "legalwork-benchmark-tools",
  "legalwork-skill-tools", "legalwork-storage-tools", "legalwork-task-tools", "legalwork-calendar-tools",
  "legalwork-assistant-tools", "legalwork-draft-tools", "legalwork-scheduled-task-tools", "legalwork-project-tools", "legalwork-tool-output",
  "legalwork-review-tools", "legalwork-org-policy-guard", "legalwork-wiki-tools",
];
const output = join(server, "dist", "opencode-plugins");
// tsc's loose modules and retired plugins must never survive an incremental build.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of pluginNames) {
  const build = await Bun.build({
    entrypoints: [join(server, "src", "opencode-plugins", `${name}.ts`)],
    outdir: join(output, name), naming: "index.js", target: "node", format: "esm",
    external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"],
  });
  if (!build.success) throw new AggregateError(build.logs, `Could not build native plugin ${name}`);
}
console.log(`Built ${pluginNames.length} native plugin directories; the released engine supplies @opencode/plugin and effect.`);
