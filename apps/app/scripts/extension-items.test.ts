import { describe, expect, test } from "bun:test";
import { buildExtensionItems } from "../src/react-app/domains/settings/extension-items";

describe("installed extension items", () => {
  test("keeps installed skills discoverable with their original nested resource paths", () => {
    const result = buildExtensionItems({
      quickConnect: [],
      platform: "darwin",
      mcpServers: [],
      installedSkills: [
        {
          name: "brief-builder",
          description: "Use for creative briefs",
          path: "/workspace/project/.opencode/skills/creative-brief-plugin/brief-builder/SKILL.md",
        },
      ],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    expect(result.items.map((item) => item.id)).toEqual(["skill:brief-builder"]);
    expect(result.items[0]).toMatchObject({
      source: "skill", installState: "installed", setupState: "ready", active: true,
    });
    expect(result.installedSkills).toEqual([result.items[0]?.skill]);
    expect(result.items[0]?.resources).toEqual([
      {
        id: "brief-builder",
        type: "skill",
        title: "brief-builder",
        path: "/workspace/project/.opencode/skills/creative-brief-plugin/brief-builder/SKILL.md",
      },
    ]);
  });
});
