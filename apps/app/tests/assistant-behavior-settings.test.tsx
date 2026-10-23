/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResourceOptions } from "../src/react-app/domains/settings/pages/assistant-resource-picker";
import { AssistantSettingsEditor } from "../src/react-app/domains/settings/pages/assistant-view";
import { AssistantProjectOptions } from "../src/react-app/domains/settings/pages/assistant-project-picker";
import { AssistantBehaviorFields } from "../src/react-app/domains/settings/pages/assistant-behavior-settings";
import type { AssistantSettings, AssistantSettingsCatalog } from "@legalwork/types/main-assistant";

const settings: AssistantSettings = { systemPromptAddition: "Reply in German.", resourceIds: ["skill"], projectAccess: { mode: "include", projectIds: ["allowed"] } };
const catalog: AssistantSettingsCatalog = { projects: [{ id: "allowed", name: "Allowed matter" }, { id: "private", name: "Private matter" }], unavailable: [], resources: [
  { id: "skill", kind: "skill", name: "Evidence research", description: "Search evidence carefully.", reference: "/research/SKILL.md", projectId: null, projectName: null },
  { id: "workflow", kind: "workflow", name: "Prepare report", description: "Prepare a report.", reference: "/report/SKILL.md", projectId: "private", projectName: "Private matter" },
] };
test("Assistant settings show resource summaries and removable selections without mounting the library", () => {
  const html = renderToStaticMarkup(<AssistantBehaviorFields settings={settings} catalog={catalog} onChange={() => {}} />);
  for (const text of ["Reply in German.", "Plugins", "Workflows", "Skills", "Evidence research", "Allowed matter"]) expect(html).toContain(text);
  for (const label of ["Choose: Plugins", "Choose: Workflows", "Choose: Skills", "Remove: Evidence research"]) expect(html).toContain(label);
  expect(html).toContain("No resources selected");
  expect(html).toContain("1 selected");
  expect(html).not.toContain("Search evidence carefully.");
  expect(html).not.toContain("Prepare report");
  expect(html).not.toContain("<details");
  expect(html).not.toContain("/research/SKILL.md");
  expect(html).toContain("preferred resources");
  expect(html).not.toContain("Private matter");
});

test("project access exposes every mode and a compact chooser without mounting the library", () => {
  const html = renderToStaticMarkup(<AssistantBehaviorFields settings={settings} catalog={catalog} onChange={() => {}} />);
  for (const label of ["All projects", "Only selected projects", "All except selected projects", "No projects", "Projects the assistant can use"]) expect(html).toContain(label);
  expect(html.match(/role="radio"/g)).toHaveLength(4);
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain("Choose projects");
  expect(html).not.toContain('aria-label="Search projects…"');
});

test("project exclusions explain their inverse meaning and all/none modes hide project checkboxes", () => {
  const excluded = renderToStaticMarkup(<AssistantBehaviorFields settings={{ ...settings, projectAccess: { mode: "exclude", projectIds: ["private"] } }} catalog={catalog} onChange={() => {}} />);
  expect(excluded).toContain("Projects the assistant cannot use");
  for (const mode of ["all", "none"] satisfies AssistantSettings["projectAccess"]["mode"][]) {
    const html = renderToStaticMarkup(<AssistantBehaviorFields settings={{ ...settings, projectAccess: { mode, projectIds: ["private"] } }} catalog={catalog} onChange={() => {}} />);
    expect(html).not.toContain('aria-label="Search projects…"');
    expect(html).not.toContain('role="checkbox"');
  }
});
test("the resource picker shows descriptions and project restrictions when opened", () => {
  const html = renderToStaticMarkup(<AssistantResourceOptions resources={catalog.resources} selectedIds={settings.resourceIds} projectAllowed={id => id !== "private"} onToggle={() => {}} />);
  expect(html).toContain("Search evidence carefully.");
  expect(html).toContain("Prepare report");
  expect(html).toContain("Available after you allow access to this project.");
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('aria-checked="false"');
  expect(html).not.toContain("/research/SKILL.md");
});
test("unavailable selections remain visible and removable instead of silently granting access or losing settings", () => {
  const html = renderToStaticMarkup(<AssistantBehaviorFields settings={{ ...settings, resourceIds: ["removed"], projectAccess: { mode: "include", projectIds: ["removed"] } }} catalog={catalog} onChange={() => {}} />);
  expect(html).toContain("Selected resource unavailable");
  expect(html).toContain("Selected project unavailable");
});


test("Assistant settings autosave without a Save or Cancel action", () => {
  const html = renderToStaticMarkup(<AssistantSettingsEditor profile={{ name: "Johannes", icon: "bird" }} settings={settings} catalog={catalog} notifications onModels={() => {}} onSave={async () => {}} />);
  expect(html).not.toContain('type="submit"');
  expect(html).not.toContain("<form");
  expect(html).not.toContain(">Save<");
  expect(html).not.toContain(">Cancel<");
  expect(html).toContain('aria-label="Desktop notifications"');
});

test("the project picker presents selected state and an empty-search state", () => {
  const html = renderToStaticMarkup(<AssistantProjectOptions projects={catalog.projects} selectedIds={["allowed"]} onToggle={() => {}} />);
  expect(html).toContain("Allowed matter");
  expect(html).toContain("Private matter");
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('aria-checked="false"');
  const empty = renderToStaticMarkup(<AssistantProjectOptions projects={[]} selectedIds={["allowed"]} onToggle={() => {}} />);
  expect(empty).toContain("No matching projects.");
});
