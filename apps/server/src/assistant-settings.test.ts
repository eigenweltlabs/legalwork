import { expect, test } from "bun:test";
import { assistantSettingsContext } from "./assistant-settings.js";
import type { AssistantResource, AssistantSettings } from "@legalwork/types/main-assistant";

test("selected resources contribute routing metadata without leaking denied projects or unselected packages", () => {
  const resource = (id: string, projectId: string | null, kind: AssistantResource["kind"]): AssistantResource => ({ id, projectId, kind,
    name: `Name ${id}`, description: `Description ${id}`, reference: `/resources/${id}/SKILL.md`, projectName: null });
  const settings: AssistantSettings = { systemPromptAddition: "Respond in German.", resourceIds: ["skill", "workflow", "plugin", "blocked"], projectAccess: { mode: "exclude", projectIds: ["private"] } };
  const text = assistantSettingsContext(settings, [resource("skill", null, "skill"), resource("workflow", "allowed", "workflow"), resource("plugin", null, "plugin"), resource("blocked", "private", "skill"), resource("unused", null, "skill")], id => id !== "private");
  expect(text).toContain(settings.systemPromptAddition);
  for (const id of ["skill", "workflow", "plugin"]) expect(text).toContain(`/resources/${id}/SKILL.md`);
  expect(text).not.toContain("Name blocked");
  expect(text).not.toContain("Name unused");
  expect(text).toContain("Delegate their execution");
  expect(text).toContain("Selection does not install");
});
