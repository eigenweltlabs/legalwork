#!/usr/bin/env node
// Generates apps/server/src/core-skills.ts from the canonical core skill/agent files.
// These are the "bundled-core" files seeded into every workspace by ensureWorkspaceFiles
// including document tools and the isolated review inference agent.
//
// Run from the repo root:  node scripts/gen-core-skills.mjs
// Re-run after editing any source file below so the seeded copy stays in sync.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateHelpI18n, generateHelpScreens, helpDocFiles, readNormalizedText } from "./help-docs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const sourceRoot = "apps/server/resources/core-opencode";

const FILES = [
  { source: "skills/legalwork-help/SKILL.md", path: ".opencode/skills/legalwork-help/SKILL.md" },
  { source: "skills/legalwork-help/scripts/lookup-label.mjs", path: ".opencode/skills/legalwork-help/scripts/lookup-label.mjs" },
  { source: "skills/author-review-prompts/SKILL.md", path: ".opencode/skills/author-review-prompts/SKILL.md" },
  { source: "skills/start-tabular-review/SKILL.md", path: ".opencode/skills/start-tabular-review/SKILL.md" },
  { source: "agents/document-extractor.md", path: ".opencode/agents/document-extractor.md" },
  { source: "agents/fusion-candidate.md", path: ".opencode/agents/fusion-candidate.md" },
  // docx-edit: agentic Word reading + editing (self-contained vendored OOXML engine).
  { source: "skills/docx-edit/SKILL.md", path: ".opencode/skills/docx-edit/SKILL.md" },
  { source: "skills/docx-edit/assets/docx-agent.mjs", path: ".opencode/skills/docx-edit/assets/docx-agent.mjs" },
  { source: "skills/docx-edit/assets/populate-template.py", path: ".opencode/skills/docx-edit/assets/populate-template.py" },
  { source: "skills/docx-edit/assets/verify-evidence.py", path: ".opencode/skills/docx-edit/assets/verify-evidence.py" },
  { source: "skills/docx-edit/assets/report-from-reviews.py", path: ".opencode/skills/docx-edit/assets/report-from-reviews.py" },
  { source: "skills/docx-edit/assets/vendor/docx-engine.mjs", path: ".opencode/skills/docx-edit/assets/vendor/docx-engine.mjs" },
  { source: "agents/docx-redliner.md", path: ".opencode/agents/docx-redliner.md" },
  { source: "commands/edit-docx.md", path: ".opencode/commands/edit-docx.md" },
  // pdf-tools: agentic PDF text / annotate / fill-form / sign (self-contained vendored
  // pdf-lib and PDF.js for text extraction).
  { source: "skills/pdf-tools/assets/vendor/pdf.min.js", path: ".opencode/skills/pdf-tools/assets/vendor/pdf.min.js" },
  { source: "skills/pdf-tools/assets/vendor/pdf.worker.min.js", path: ".opencode/skills/pdf-tools/assets/vendor/pdf.worker.min.js" },
  { source: "skills/pdf-tools/SKILL.md", path: ".opencode/skills/pdf-tools/SKILL.md" },
  { source: "skills/pdf-tools/assets/pdf-agent.mjs", path: ".opencode/skills/pdf-tools/assets/pdf-agent.mjs" },
  { source: "skills/pdf-tools/assets/pdf-ops.mjs", path: ".opencode/skills/pdf-tools/assets/pdf-ops.mjs" },
  { source: "skills/pdf-tools/assets/pdf-text.mjs", path: ".opencode/skills/pdf-tools/assets/pdf-text.mjs" },
  { source: "skills/pdf-tools/assets/vendor/pdf-lib.mjs", path: ".opencode/skills/pdf-tools/assets/vendor/pdf-lib.mjs" },
  { source: "commands/open.md", path: ".opencode/commands/open.md" },
  { source: "commands/annotate.md", path: ".opencode/commands/annotate.md" },
  { source: "commands/fill-form.md", path: ".opencode/commands/fill-form.md" },
  { source: "commands/sign.md", path: ".opencode/commands/sign.md" },
  // benchmark-task: create a LegalWork benchmark task from chat (uses the benchmark_create_task tool).
  { source: "skills/benchmark-task/SKILL.md", path: ".opencode/skills/benchmark-task/SKILL.md" },
];

const i18n = generateHelpI18n();
const i18nReferencePath = ".opencode/skills/legalwork-help/references/i18n.json";
const screens = generateHelpScreens();
const files = [
  ...FILES.map((file) => ({
    path: file.path,
    content: readNormalizedText(join(repoRoot, sourceRoot, file.source)),
  })),
  ...helpDocFiles(),
  { path: i18nReferencePath, content: i18n },
  { path: ".opencode/skills/legalwork-help/references/screens.json", content: screens },
];
const entries = files.map((file) =>
  `  { path: ${JSON.stringify(file.path)}, content: ${file.path === i18nReferencePath ? "HELP_I18N_JSON" : JSON.stringify(file.content)} },`,
).join("\n");

// Shared workflows are installed once in the global library, where the desktop
// Workflows list and every workspace can discover them. Keep binary attachments.
const WORKFLOW_FILES = [
  "SKILL.md", "references/report.md", "references/template-fields.json", "resources/DD-Report-Template.docx",
].map((file) => ({ path: `workflow-assistant-due-diligence/${file}`, encoding: file.endsWith(".docx") ? "base64" : "utf8" }));
WORKFLOW_FILES.push({ path: "workflow-firm-knowledge/SKILL.md", encoding: "utf8" });
const workflowEntries = WORKFLOW_FILES.map((file) => {
  const path = join(repoRoot, sourceRoot, "skills", file.path);
  const content = file.encoding === "utf8" ? readNormalizedText(path) : readFileSync(path).toString(file.encoding);
  return `  { path: ${JSON.stringify(file.path)}, encoding: ${JSON.stringify(file.encoding)}, content: ${JSON.stringify(content)} },`;
}).join("\n");

const out = `// AUTO-GENERATED by scripts/gen-core-skills.mjs. DO NOT EDIT BY HAND.
// Sources: ${sourceRoot}/, docs/user-guide/, apps/app/src/i18n/.
// Regenerate with: node scripts/gen-core-skills.mjs
//
// "Bundled-core" skills/agents: seeded into every workspace by ensureWorkspaceFiles so
// document tools work without separate installation.

import { HELP_I18N_JSON } from "./help-i18n.generated.js";

export type CoreOpencodeFile = {
  /** Destination path, relative to the workspace root. */
  readonly path: string;
  readonly content: string;
};

export const CORE_OPENCODE_FILES: readonly CoreOpencodeFile[] = [
${entries}
];

export type BundledWorkflowFile = {
  /** Destination path, relative to the shared skills root. */
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
};

export const BUNDLED_WORKFLOW_FILES: readonly BundledWorkflowFile[] = [
${workflowEntries}
];
`;

const dest = join(repoRoot, "apps/server/src/core-skills.ts");
// Recreate ignored build inputs even in check mode, so fresh-checkout tests can
// import the bundle. Only the versioned outputs below are checked for staleness.
const buildInputs = [
  { path: join(repoRoot, "docs/user-guide/i18n.json"), content: i18n },
  { path: join(repoRoot, "apps/server/src/help-i18n.generated.ts"), content: `// Generated by scripts/gen-core-skills.mjs. Do not commit.\nexport const HELP_I18N_JSON = ${JSON.stringify(i18n)};\n` },
];
for (const input of buildInputs) {
  if (!existsSync(input.path) || readFileSync(input.path, "utf8") !== input.content) {
    writeFileSync(input.path, input.content, "utf8");
  }
}
const outputs = [
  { path: join(repoRoot, "docs/user-guide/screens.json"), content: screens },
  { path: dest, content: out },
];
for (const output of outputs) {
  const current = existsSync(output.path) ? readNormalizedText(output.path) : null;
  if (current === output.content) continue;
  if (process.argv.includes("--check")) {
    console.error(`Out of date: ${output.path}. Run pnpm docs:generate.`);
    process.exitCode = 1;
  } else {
    writeFileSync(output.path, output.content, "utf8");
  }
}
if (!process.exitCode) console.log(`Bundled core resources ${process.argv.includes("--check") ? "verified" : "generated"} (${files.length} files).`);
