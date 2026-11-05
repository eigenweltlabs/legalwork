import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginImportPreview } from "@legalwork/types/plugin-import";
import { PluginImportWorkflowChoice } from "../src/react-app/domains/settings/pages/plugin-import-dialog";

const preview: PluginImportPreview = {
  id: "review-kit", name: "review-kit", version: "1.0", description: "Document review", format: "claude", root: "", digest: "reviewed",
  fileCount: 4, bytes: 1000, warnings: [], components: [
    { type: "skill", name: "review", installedName: "review-installed", sourcePath: "skills/review/SKILL.md", asWorkflow: false },
    { type: "skill", name: "summarize", installedName: "summarize-installed", sourcePath: "skills/summarize/SKILL.md", asWorkflow: false },
  ],
};
const apply = async () => true;

test("workflow imports offer a picker for one or many plugin skills, excluding connectors", () => {
  for (const components of [[preview.components[0]], [...preview.components, { type: "mcp", name: "docs", installedName: "docs-installed" }] satisfies PluginImportPreview["components"]]) {
    const html = renderToStaticMarkup(<PluginImportWorkflowChoice preview={{ ...preview, components }} available onChange={apply} />);
    expect(html).toContain("Convert skills to workflows");
    expect(html).toContain("Review");
    expect(html).not.toContain("Docs");
  }
});

test("ordinary integrations, connector-only plugins and standalone skills do not show plugin conversion", () => {
  expect(renderToStaticMarkup(<PluginImportWorkflowChoice preview={preview} available={false} onChange={apply} />)).toBe("");
  expect(renderToStaticMarkup(<PluginImportWorkflowChoice preview={{ ...preview, format: "skills" }} available onChange={apply} />)).toBe("");
  expect(renderToStaticMarkup(<PluginImportWorkflowChoice preview={{ ...preview, components: [{ type: "mcp", name: "docs", installedName: "docs-installed" }] }} available onChange={apply} />)).toBe("");
});

test("a reviewed subset shows each skill's actual destination and allows changing the selection", () => {
  const converted: PluginImportPreview = {
    ...preview,
    provenance: { provider: "claude", kind: "folder", location: "/plugins/review-kit", root: "", digest: "reviewed", version: "1.0", asWorkflow: true, convertPluginSkills: true, workflowSkillPaths: ["skills/review/SKILL.md"] },
    components: [{ ...preview.components[0], installedName: "workflow-assistant-review", asWorkflow: true }, preview.components[1]],
  };
  const html = renderToStaticMarkup(<PluginImportWorkflowChoice preview={converted} available onChange={apply} />);
  expect(html).toContain("Change selection");
  expect(html).toContain(">Workflow<");
  expect(html).toContain(">Skill<");
  expect(html.match(/lucide-workflow/g)).toHaveLength(2);
  expect(html).not.toContain("These skills will appear in Workflows.");
});

test("legacy whole-plugin conversion remains visible without silently selecting new skills for a saved subset", () => {
  const provenance: NonNullable<PluginImportPreview["provenance"]> = { provider: "claude", kind: "folder", location: "/plugin", root: "", digest: "reviewed", version: null, asWorkflow: true, convertPluginSkills: true };
  const legacy = renderToStaticMarkup(<PluginImportWorkflowChoice preview={{ ...preview, components: preview.components.map(item => ({ ...item, asWorkflow: undefined })), provenance }} available onChange={apply} />);
  expect(legacy.match(/>Workflow</g)).toHaveLength(2);
  const none = renderToStaticMarkup(<PluginImportWorkflowChoice preview={{ ...preview, provenance: { ...provenance, workflowSkillPaths: [] } }} available onChange={apply} />);
  expect(none).not.toContain(">Workflow<");
  expect(none).toContain("Convert skills to workflows");
});
