import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyResourcesSection,
  deleteSkillResource,
  listSkillResources,
  readSkillResource,
  upsertSkillResource,
} from "./skill-resources.js";
import { upsertSkill } from "./skills.js";
import { exists } from "./utils.js";

let workspace: string;

const SKILL = "workflow-assistant-legal-response";
const skillDir = () => join(workspace, ".opencode", "skills", SKILL);
const skillMd = () => join(skillDir(), "SKILL.md");

async function createSkill(name = SKILL): Promise<void> {
  await upsertSkill(workspace, {
    name,
    content: `---\nname: ${name}\ndescription: Draft a legal response\n---\n\nFollow the firm's process.\n`,
  });
}

async function createNestedSkill(domain: string, name: string): Promise<string> {
  const dir = join(workspace, ".opencode", "skills", domain, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Nested skill\n---\n\nBody.\n`, "utf8");
  return dir;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "legalwork-skill-resources-"));
  await mkdir(join(workspace, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("skill resources CRUD", () => {
  test("404s when the skill does not exist", async () => {
    await expect(listSkillResources(workspace, "missing-skill")).rejects.toThrow("Skill not found");
    await expect(upsertSkillResource(workspace, "missing-skill", { name: "a.md", content: "x" })).rejects.toThrow(
      "Skill not found",
    );
  });

  test("lists an empty resources folder", async () => {
    await createSkill();
    expect(await listSkillResources(workspace, SKILL)).toEqual([]);
  });

  test("upserts, lists, reads, updates, and deletes a resource inside the skill folder", async () => {
    await createSkill();
    const created = await upsertSkillResource(workspace, SKILL, { name: "nda-playbook.md", content: "# NDA playbook\n" });
    expect(created.action).toBe("added");
    expect(created.path).toBe(join(skillDir(), "resources", "nda-playbook.md"));
    expect(created.skillPath).toBe(skillMd());

    const items = await listSkillResources(workspace, SKILL);
    expect(items.map((item) => item.name)).toEqual(["nda-playbook.md"]);
    expect(items[0]!.size).toBeGreaterThan(0);
    expect(items[0]!.updatedAt).toBeGreaterThan(0);

    const read = await readSkillResource(workspace, SKILL, "nda-playbook.md");
    expect(read.content).toBe("# NDA playbook\n");

    const updated = await upsertSkillResource(workspace, SKILL, { name: "nda-playbook.md", content: "# NDA playbook v2\n" });
    expect(updated.action).toBe("updated");
    expect((await readSkillResource(workspace, SKILL, "nda-playbook.md")).content).toBe("# NDA playbook v2\n");

    await deleteSkillResource(workspace, SKILL, "nda-playbook.md");
    expect(await exists(created.path)).toBe(false);
    expect(await listSkillResources(workspace, SKILL)).toEqual([]);
  });

  test("writes binary content from base64", async () => {
    await createSkill();
    const bytes = Buffer.from("binary-ish content");
    await upsertSkillResource(workspace, SKILL, { name: "letterhead.docx", contentBase64: bytes.toString("base64") });
    const written = await readFile(join(skillDir(), "resources", "letterhead.docx"));
    expect(written.equals(bytes)).toBe(true);
  });

  test("rejects reading non-text resources in the editor", async () => {
    await createSkill();
    await upsertSkillResource(workspace, SKILL, { name: "letterhead.docx", contentBase64: "aGk=" });
    await expect(readSkillResource(workspace, SKILL, "letterhead.docx")).rejects.toThrow("text files");
  });

  test("404s for unknown resources", async () => {
    await createSkill();
    await expect(readSkillResource(workspace, SKILL, "missing.md")).rejects.toThrow("Attached file not found");
    await expect(deleteSkillResource(workspace, SKILL, "missing.md")).rejects.toThrow("Attached file not found");
  });

  test("requires content on upsert", async () => {
    await createSkill();
    await expect(upsertSkillResource(workspace, SKILL, { name: "empty.md" })).rejects.toThrow("content is required");
  });

  test("skips directories and hidden files when listing", async () => {
    await createSkill();
    await upsertSkillResource(workspace, SKILL, { name: "visible.md", content: "ok" });
    await mkdir(join(skillDir(), "resources", "nested"), { recursive: true });
    await writeFile(join(skillDir(), "resources", ".hidden"), "x", "utf8");
    const items = await listSkillResources(workspace, SKILL);
    expect(items.map((item) => item.name)).toEqual(["visible.md"]);
  });

  test("resolves nested skills (skills/<domain>/<name>/SKILL.md) like the skills routes", async () => {
    const dir = await createNestedSkill("finance", "invoice-review");
    const created = await upsertSkillResource(workspace, "invoice-review", { name: "checklist.md", content: "1. Check\n" });
    expect(created.path).toBe(join(dir, "resources", "checklist.md"));

    const items = await listSkillResources(workspace, "invoice-review");
    expect(items.map((item) => item.name)).toEqual(["checklist.md"]);

    const written = await readFile(join(dir, "SKILL.md"), "utf8");
    expect(written).toContain("`resources/checklist.md`");
  });
});

describe("name safety", () => {
  const badFileNames = ["../evil.md", "..", "a/b.md", "a\\b.md", "/etc/passwd", ".hidden.md", "", "trailing. ", "a..b.md"];

  for (const name of badFileNames) {
    test(`rejects file name ${JSON.stringify(name)}`, async () => {
      await createSkill();
      await expect(upsertSkillResource(workspace, SKILL, { name, content: "x" })).rejects.toThrow("Resource name");
      await expect(readSkillResource(workspace, SKILL, name)).rejects.toThrow("Resource name");
      await expect(deleteSkillResource(workspace, SKILL, name)).rejects.toThrow("Resource name");
    });
  }

  const badSkillNames = ["../evil", "..", "a/b", "a\\b", ".hidden", "", "UPPER", "spaced name"];

  for (const name of badSkillNames) {
    test(`rejects skill name ${JSON.stringify(name)}`, async () => {
      await expect(listSkillResources(workspace, name)).rejects.toThrow("Skill name");
      await expect(upsertSkillResource(workspace, name, { name: "a.md", content: "x" })).rejects.toThrow("Skill name");
      await expect(readSkillResource(workspace, name, "a.md")).rejects.toThrow("Skill name");
      await expect(deleteSkillResource(workspace, name, "a.md")).rejects.toThrow("Skill name");
    });
  }

  test("accepts plain file names with spaces and dots", async () => {
    await createSkill();
    const result = await upsertSkillResource(workspace, SKILL, { name: "Client Response v1.2.md", content: "hi" });
    expect(result.action).toBe("added");
  });
});

describe("SKILL.md attached-resources section", () => {
  test("adding resources injects the section with RELATIVE paths (zip-portable)", async () => {
    await createSkill();
    await upsertSkillResource(workspace, SKILL, { name: "tone-guide.md", content: "Tone." });
    await upsertSkillResource(workspace, SKILL, { name: "response-template.md", content: "Template." });

    const written = await readFile(skillMd(), "utf8");
    expect(written).toContain("## Attached resources");
    expect(written).toContain("- `resources/response-template.md`");
    expect(written).toContain("- `resources/tone-guide.md`");
    expect(written).toContain("Follow the firm's process.");
    expect(written).toContain("name: workflow-assistant-legal-response");
    // Portable: no absolute paths, no global-library paths.
    expect(written).not.toContain(workspace);
    expect(written).not.toContain(".opencode/templates");
  });

  test("re-upserting the same resource leaves SKILL.md unchanged (idempotent)", async () => {
    await createSkill();
    await upsertSkillResource(workspace, SKILL, { name: "a.md", content: "v1" });
    const afterFirst = await readFile(skillMd(), "utf8");
    await upsertSkillResource(workspace, SKILL, { name: "a.md", content: "v2" });
    expect(await readFile(skillMd(), "utf8")).toBe(afterFirst);
  });

  test("deleting a resource removes its entry; deleting the last removes the block", async () => {
    await createSkill();
    await upsertSkillResource(workspace, SKILL, { name: "a.md", content: "a" });
    await upsertSkillResource(workspace, SKILL, { name: "b.md", content: "b" });

    await deleteSkillResource(workspace, SKILL, "b.md");
    const afterFirst = await readFile(skillMd(), "utf8");
    expect(afterFirst).toContain("- `resources/a.md`");
    expect(afterFirst).not.toContain("b.md");

    await deleteSkillResource(workspace, SKILL, "a.md");
    const afterSecond = await readFile(skillMd(), "utf8");
    expect(afterSecond).not.toContain("legalwork:resources");
    expect(afterSecond).not.toContain("## Attached resources");
    expect(afterSecond).toContain("Follow the firm's process.");
  });

  test("skill saves preserve the managed section", async () => {
    await createSkill();
    await upsertSkillResource(workspace, SKILL, { name: "a.md", content: "a" });
    const withSection = await readFile(skillMd(), "utf8");

    // Saving the skill (round-tripping its own content) keeps the block intact.
    await upsertSkill(workspace, { name: SKILL, content: withSection });
    expect(await readFile(skillMd(), "utf8")).toBe(withSection);
  });
});

describe("applyResourcesSection", () => {
  test("is idempotent and preserves surrounding body text", () => {
    const body = "Intro paragraph.\n";
    const once = applyResourcesSection(body, ["a.md"]);
    const twice = applyResourcesSection(once, ["a.md"]);
    expect(twice).toBe(once);
    expect(once.startsWith("Intro paragraph.\n\n<!-- legalwork:resources:start -->")).toBe(true);
  });

  test("removes the section when the list becomes empty", () => {
    const withSection = applyResourcesSection("Intro.\n", ["a.md"]);
    expect(applyResourcesSection(withSection, [])).toBe("Intro.\n");
  });

  test("handles an empty body", () => {
    expect(applyResourcesSection("", [])).toBe("");
    const only = applyResourcesSection("", ["a.md"]);
    expect(only).toContain("## Attached resources");
    expect(applyResourcesSection(only, ["a.md"])).toBe(only);
  });
});

describe("global skills fallback", () => {
  // The desktop app installs skills into the global dir ($XDG_CONFIG_HOME/
  // opencode/skills), not the workspace — resources must resolve there too.
  let configHome: string;
  let savedXdg: string | undefined;

  beforeEach(async () => {
    configHome = await mkdtemp(join(tmpdir(), "legalwork-xdg-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(async () => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    await rm(configHome, { recursive: true, force: true });
  });

  test("attaches a resource to a skill that only exists globally", async () => {
    const globalDir = join(configHome, "opencode", "skills", "global-only-skill");
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      join(globalDir, "SKILL.md"),
      "---\nname: global-only-skill\ndescription: Desktop-installed skill\n---\n\nBody.\n",
      "utf8",
    );

    const created = await upsertSkillResource(workspace, "global-only-skill", {
      name: "vorlage.md",
      content: "# Vorlage\n",
    });
    expect(created.action).toBe("added");
    expect(await exists(join(globalDir, "resources", "vorlage.md"))).toBe(true);
    expect(await readFile(join(globalDir, "SKILL.md"), "utf8")).toContain("resources/vorlage.md");

    const items = await listSkillResources(workspace, "global-only-skill");
    expect(items.map((item) => item.name)).toEqual(["vorlage.md"]);
  });

  test("prefers the workspace skill over a global one with the same name", async () => {
    await createSkill("shared-name");
    const globalDir = join(configHome, "opencode", "skills", "shared-name");
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, "SKILL.md"), "---\nname: shared-name\ndescription: g\n---\n\nBody.\n", "utf8");

    await upsertSkillResource(workspace, "shared-name", { name: "a.md", content: "x" });
    expect(await exists(join(workspace, ".opencode", "skills", "shared-name", "resources", "a.md"))).toBe(true);
    expect(await exists(join(globalDir, "resources", "a.md"))).toBe(false);
  });
});
