import { describe, expect, test } from "bun:test";

import { getSkillTemplates, setSkillTemplates } from "../src/app/utils/skill-templates";

const skill = (frontmatterLines: string[]) =>
  ["---", ...frontmatterLines, "---", "", "Body text.", ""].join("\n");

describe("getSkillTemplates", () => {
  test("returns [] without frontmatter or templates key", () => {
    expect(getSkillTemplates("Just a body.")).toEqual([]);
    expect(getSkillTemplates(skill(["name: a", "description: b"]))).toEqual([]);
  });

  test("reads a block list", () => {
    const content = skill(["name: a", "description: b", "templates:", "  - nda.md", "  - tone-guide.md"]);
    expect(getSkillTemplates(content)).toEqual(["nda.md", "tone-guide.md"]);
  });

  test("reads an inline list and quoted entries", () => {
    expect(getSkillTemplates(skill(["name: a", "templates: [nda.md, \"Client Response.md\"]"]))).toEqual([
      "nda.md",
      "Client Response.md",
    ]);
    expect(getSkillTemplates(skill(["name: a", "templates:", "  - 'quoted.md'"]))).toEqual(["quoted.md"]);
  });

  test("stops at the next top-level key", () => {
    const content = skill(["name: a", "templates:", "  - nda.md", "description: b"]);
    expect(getSkillTemplates(content)).toEqual(["nda.md"]);
  });
});

describe("setSkillTemplates", () => {
  test("adds a templates list to existing frontmatter", () => {
    const content = skill(["name: a", "description: b"]);
    const next = setSkillTemplates(content, ["nda.md"]);
    expect(getSkillTemplates(next)).toEqual(["nda.md"]);
    expect(next).toContain("name: a");
    expect(next).toContain("description: b");
    expect(next).toContain("Body text.");
  });

  test("replaces an existing list and preserves other keys", () => {
    const content = skill(["name: a", "templates:", "  - old.md", "description: b"]);
    const next = setSkillTemplates(content, ["new.md", "other.md"]);
    expect(getSkillTemplates(next)).toEqual(["new.md", "other.md"]);
    expect(next).not.toContain("old.md");
    expect(next).toContain("description: b");
  });

  test("removes the key when the list is empty", () => {
    const content = skill(["name: a", "templates:", "  - old.md", "description: b"]);
    const next = setSkillTemplates(content, []);
    expect(next).not.toContain("templates");
    expect(getSkillTemplates(next)).toEqual([]);
    expect(next).toContain("name: a");
    expect(next).toContain("Body text.");
  });

  test("is idempotent", () => {
    const content = skill(["name: a", "description: b"]);
    const once = setSkillTemplates(content, ["nda.md", "tone.md"]);
    expect(setSkillTemplates(once, ["nda.md", "tone.md"])).toBe(once);
  });

  test("dedupes and trims entries, quoting non-plain names", () => {
    const next = setSkillTemplates(skill(["name: a"]), [" nda.md ", "nda.md", "weird:name.md"]);
    expect(getSkillTemplates(next)).toEqual(["nda.md", "weird:name.md"]);
    expect(next).toContain('- "weird:name.md"');
  });

  test("creates frontmatter when the content has none", () => {
    const next = setSkillTemplates("Body only.", ["nda.md"]);
    expect(getSkillTemplates(next)).toEqual(["nda.md"]);
    expect(next).toContain("Body only.");
    expect(setSkillTemplates("Body only.", [])).toBe("Body only.");
  });

  test("replaces an inline list", () => {
    const content = skill(["name: a", "templates: [old.md]"]);
    const next = setSkillTemplates(content, ["new.md"]);
    expect(getSkillTemplates(next)).toEqual(["new.md"]);
    expect(next).not.toContain("old.md");
  });
});
