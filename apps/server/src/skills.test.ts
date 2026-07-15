import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSkill, listSkills, resolveHubSkillKind } from "./skills.js";
import { exists } from "./utils.js";

let workspace: string;

async function writeSkill(dir: string, name: string, metadata = "") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n${metadata}---\n\nBody\n`, "utf8");
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "legalwork-skills-"));
  await mkdir(join(workspace, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("deleteSkill", () => {
  test("deletes a flat skill", async () => {
    const dir = join(workspace, ".opencode", "skills", "flat-skill");
    await writeSkill(dir, "flat-skill");
    await deleteSkill(workspace, "flat-skill");
    expect(await exists(dir)).toBe(false);
  });

  test("deletes a plugin-namespaced (nested) skill", async () => {
    // Marketplace plugin bundles install skills under skills/<plugin>/<name>/
    const dir = join(workspace, ".opencode", "skills", "bio-research-plugin", "instrument-data-to-allotrope");
    await writeSkill(dir, "instrument-data-to-allotrope");

    const listed = await listSkills(workspace, false);
    expect(listed.map((s) => s.name)).toContain("instrument-data-to-allotrope");

    await deleteSkill(workspace, "instrument-data-to-allotrope");
    expect(await exists(dir)).toBe(false);
  });

  test("404s for unknown skills", async () => {
    await expect(deleteSkill(workspace, "does-not-exist")).rejects.toThrow("Skill not found");
  });
});

describe("listSkills", () => {
  test("preserves workflow metadata used by firm Hub sharing", async () => {
    await writeSkill(
      join(workspace, ".opencode", "skills", "asset-review"),
      "asset-review",
      "kind: workflow\nworkflow_type: assistant\n",
    );

    const [workflow] = await listSkills(workspace, false);

    expect(workflow).toMatchObject({
      name: "asset-review",
      kind: "workflow",
      workflowType: "assistant",
    });
  });

  test("classifies workflow metadata even when an older client requests skill", () => {
    expect(resolveHubSkillKind(
      {
        name: "asset-review",
        path: "/skills/asset-review/SKILL.md",
        description: "Review assets",
        scope: "project",
        kind: "workflow",
      },
      "skill",
      "asset-review",
    )).toBe("workflow");
    expect(resolveHubSkillKind(undefined, "skill", "workflow-legacy-review")).toBe("workflow");
    expect(resolveHubSkillKind(undefined, "skill", "ordinary-skill")).toBe("skill");
  });
});
