/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantResourceOptions } from "../src/react-app/domains/settings/pages/assistant-resource-picker";
import { AssistantSettingsEditor } from "../src/react-app/domains/settings/pages/assistant-view";
import { AssistantProjectOptions } from "../src/react-app/domains/settings/pages/assistant-project-picker";
import { AssistantBehaviorFields } from "../src/react-app/domains/settings/pages/assistant-behavior-settings";
import { AssistantBrowserModelField } from "../src/react-app/domains/settings/pages/assistant-browser-model";
import type { ModelOption } from "../src/app/types";
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


test("Assistant settings render without workspace context and autosave without Save or Cancel", () => {
  const query = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={query}><AssistantSettingsEditor profile={{ name: "Johannes", icon: "bird" }} settings={settings} catalog={catalog} browserModelPicker={{ options: [], open: false, onOpenChange: () => {} }} notifications onModels={() => {}} onSave={async () => {}} /></QueryClientProvider>);
  query.clear();
  expect(html).toContain("Browser model");
  expect(html).toContain("Automatic");
  expect(html).toContain("Terra, Sonnet, Gemini Flash, Sol, Opus, Argon, Luna, DeepSeek, GLM, then Mistral");
  expect(html).toContain("independently of your chat model");
  expect(html).not.toContain('type="submit"');
  expect(html).not.toContain("<form");
  expect(html).not.toContain(">Save<");
  expect(html).not.toContain(">Cancel<");
  expect(html).toContain('aria-label="Desktop notifications"');
});

test("Assistant settings use supplied model names without workspace context", () => {
  const option: ModelOption = {
    providerID: "connected-provider", modelID: "browser-model", title: "Connected browser model", description: "Connected provider",
    behaviorTitle: "Reasoning", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false, isConnected: true,
  };
  const html = renderToStaticMarkup(<AssistantSettingsEditor profile={{ name: "Assistant", icon: "bird" }}
    settings={{ ...settings, browserModel: { providerID: option.providerID, modelID: option.modelID } }} catalog={catalog}
    browserModelPicker={{ options: [option], open: false, onOpenChange: () => {} }} notifications onModels={() => {}} onSave={async () => {}} />);
  expect(html).toContain("Connected browser model");
});

test("automatic browser settings show the resolved subscription model and preserve manual choices", () => {
  const option = (modelID: string, title: string, providerID = "eigenwelt"): ModelOption => ({
    providerID, modelID, title, behaviorTitle: "Reasoning", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false, isConnected: true,
  });
  const own = option("gpt-6.1-terra", "GPT-6.1 Terra (own account)", "openai");
  const terra = option("terra", "GPT-6.1 Terra (EU)");
  const sonnet = option("sonnet", "Claude Sonnet 5.5 (EU)");
  const flash = option("flash", "Gemini 3.8 Flash (EU)");
  const render = (options: ModelOption[], value?: AssistantSettings["browserModel"]) => renderToStaticMarkup(<AssistantBrowserModelField
    value={value} onChange={() => {}} picker={{ options, open: false, onOpenChange: () => {} }} />);
  expect(render([flash, sonnet, own])).toContain("Claude Sonnet 5.5 (EU)");
  expect(render([flash, sonnet, own])).toContain(">Automatic<");
  expect(render([sonnet, terra])).toContain("GPT-6.1 Terra (EU)");
  expect(render([{ ...terra, disabled: true }, { ...sonnet, isConnected: false }, flash])).toContain("Gemini 3.8 Flash (EU)");
  expect(render([own])).toContain("No available default");
  const manual = render([sonnet, terra], { providerID: sonnet.providerID, modelID: sonnet.modelID });
  expect(manual).toContain("Claude Sonnet 5.5 (EU)");
  expect(manual).not.toContain(">Automatic<");
  expect(manual).toContain("Use automatic browser model");
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
