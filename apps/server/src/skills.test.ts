import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSkill, listSkills, resolveHubSkillKind, skillsDirForScope, upsertSkill } from "./skills.js";
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

describe("upsertSkill", () => {
  let configHome: string;
  let savedConfigHome: string | undefined;

  beforeEach(async () => {
    savedConfigHome = process.env.XDG_CONFIG_HOME;
    configHome = await mkdtemp(join(tmpdir(), "legalwork-skills-config-"));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(async () => {
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
    await rm(configHome, { recursive: true, force: true });
  });

  test("defaults to the workspace's own skills dir", async () => {
    const result = await upsertSkill(workspace, {
      name: "matter-intake",
      description: "Use when opening a new matter.",
      content: "Body\n",
    });

    expect(result.scope).toBe("project");
    expect(result.path).toBe(join(workspace, ".opencode", "skills", "matter-intake", "SKILL.md"));
  });

  // The desktop Skills/Workflows screens list the global library only, so an
  // agent-created workflow has to land there to be visible in the app.
  test("writes into the global library when scoped global", async () => {
    const result = await upsertSkill(workspace, {
      name: "workflow-assistant-nda-review",
      description: "Use when reviewing an NDA.",
      content: "Body\n",
      scope: "global",
    });

    expect(result.scope).toBe("global");
    expect(result.path).toBe(
      join(configHome, "opencode", "skills", "workflow-assistant-nda-review", "SKILL.md"),
    );
    expect(skillsDirForScope(workspace, "global")).toBe(join(configHome, "opencode", "skills"));

    const [listed] = (await listSkills(workspace, true)).filter(
      (item) => item.name === "workflow-assistant-nda-review",
    );
    expect(listed).toMatchObject({ name: "workflow-assistant-nda-review", scope: "global" });
  });

  test("reports an overwrite of an existing global skill as an update", async () => {
    const payload = { name: "matter-intake", description: "Use when opening a new matter.", content: "Body\n", scope: "global" as const };
    expect((await upsertSkill(workspace, payload)).action).toBe("added");
    expect((await upsertSkill(workspace, payload)).action).toBe("updated");
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
