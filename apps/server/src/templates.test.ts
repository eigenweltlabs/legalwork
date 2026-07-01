import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTemplatesSection,
  deleteTemplate,
  listTemplates,
  normalizeSkillTemplates,
  readTemplate,
  upsertTemplate,
} from "./templates.js";
import { upsertSkill } from "./skills.js";
import { parseFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "legalwork-templates-"));
  await mkdir(join(workspace, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("templates CRUD", () => {
  test("lists an empty library", async () => {
    expect(await listTemplates(workspace)).toEqual([]);
  });

  test("upserts, lists, reads, updates, and deletes a template", async () => {
    const created = await upsertTemplate(workspace, { name: "nda-playbook.md", content: "# NDA playbook\n" });
    expect(created.action).toBe("added");
    expect(created.path).toBe(join(workspace, ".opencode", "templates", "nda-playbook.md"));

    const items = await listTemplates(workspace);
    expect(items.map((item) => item.name)).toEqual(["nda-playbook.md"]);
    expect(items[0]!.size).toBeGreaterThan(0);
    expect(items[0]!.updatedAt).toBeGreaterThan(0);

    const read = await readTemplate(workspace, "nda-playbook.md");
    expect(read.content).toBe("# NDA playbook\n");

    const updated = await upsertTemplate(workspace, { name: "nda-playbook.md", content: "# NDA playbook v2\n" });
    expect(updated.action).toBe("updated");
    expect((await readTemplate(workspace, "nda-playbook.md")).content).toBe("# NDA playbook v2\n");

    await deleteTemplate(workspace, "nda-playbook.md");
    expect(await exists(created.path)).toBe(false);
    expect(await listTemplates(workspace)).toEqual([]);
  });

  test("writes binary content from base64", async () => {
    const bytes = Buffer.from("binary-ish content");
    await upsertTemplate(workspace, { name: "letterhead.docx", contentBase64: bytes.toString("base64") });
    const written = await readFile(join(workspace, ".opencode", "templates", "letterhead.docx"));
    expect(written.equals(bytes)).toBe(true);
  });

  test("rejects reading non-text templates in the editor", async () => {
    await upsertTemplate(workspace, { name: "letterhead.docx", contentBase64: "aGk=" });
    await expect(readTemplate(workspace, "letterhead.docx")).rejects.toThrow("text templates");
  });

  test("404s for unknown templates", async () => {
    await expect(readTemplate(workspace, "missing.md")).rejects.toThrow("Template not found");
    await expect(deleteTemplate(workspace, "missing.md")).rejects.toThrow("Template not found");
  });

  test("requires content on upsert", async () => {
    await expect(upsertTemplate(workspace, { name: "empty.md" })).rejects.toThrow("content is required");
  });

  test("skips directories and hidden files when listing", async () => {
    await upsertTemplate(workspace, { name: "visible.md", content: "ok" });
    await mkdir(join(workspace, ".opencode", "templates", "nested"), { recursive: true });
    const items = await listTemplates(workspace);
    expect(items.map((item) => item.name)).toEqual(["visible.md"]);
  });
});

describe("template name safety", () => {
  const badNames = ["../evil.md", "..", "a/b.md", "a\\b.md", "/etc/passwd", ".hidden.md", "", "trailing. ", "a..b.md"];

  for (const name of badNames) {
    test(`rejects ${JSON.stringify(name)}`, async () => {
      await expect(upsertTemplate(workspace, { name, content: "x" })).rejects.toThrow("Template name");
      await expect(readTemplate(workspace, name)).rejects.toThrow("Template name");
      await expect(deleteTemplate(workspace, name)).rejects.toThrow("Template name");
    });
  }

  test("accepts plain file names with spaces and dots", async () => {
    const result = await upsertTemplate(workspace, { name: "Client Response v1.2.md", content: "hi" });
    expect(result.action).toBe("added");
  });
});

describe("normalizeSkillTemplates", () => {
  test("dedupes, trims, and validates entries", () => {
    expect(normalizeSkillTemplates([" a.md ", "a.md", "b.md"])).toEqual(["a.md", "b.md"]);
    expect(normalizeSkillTemplates("solo.md")).toEqual(["solo.md"]);
    expect(normalizeSkillTemplates(undefined)).toEqual([]);
    expect(normalizeSkillTemplates([42, null])).toEqual([]);
    expect(() => normalizeSkillTemplates(["../evil.md"])).toThrow("Template name");
  });
});

describe("skill frontmatter templates round-trip", () => {
  const skillContent = (templates: string[]) =>
    [
      "---",
      "name: workflow-assistant-legal-response",
      "description: Draft a legal response",
      ...(templates.length ? ["templates:", ...templates.map((name) => `  - ${name}`)] : []),
      "---",
      "",
      "Follow the firm's process.",
      "",
    ].join("\n");

  test("upsert injects the Firm templates section and keeps frontmatter", async () => {
    const result = await upsertSkill(workspace, {
      name: "workflow-assistant-legal-response",
      content: skillContent(["response-template.md", "tone-guide.md"]),
    });
    const written = await readFile(result.path, "utf8");
    const { data, body } = parseFrontmatter(written);
    expect(data.templates).toEqual(["response-template.md", "tone-guide.md"]);
    expect(body).toContain("## Firm templates");
    expect(body).toContain("`.opencode/templates/response-template.md`");
    expect(body).toContain("`.opencode/templates/tone-guide.md`");
    expect(body).toContain("Follow the firm's process.");
  });

  test("upsert is idempotent — saving the written content again changes nothing", async () => {
    const payload = {
      name: "workflow-assistant-legal-response",
      content: skillContent(["response-template.md"]),
    };
    const first = await upsertSkill(workspace, payload);
    const afterFirst = await readFile(first.path, "utf8");

    const second = await upsertSkill(workspace, { name: payload.name, content: afterFirst });
    const afterSecond = await readFile(second.path, "utf8");
    expect(afterSecond).toBe(afterFirst);
  });

  test("removing a template from frontmatter removes it from the section", async () => {
    const name = "workflow-assistant-legal-response";
    const first = await upsertSkill(workspace, { name, content: skillContent(["a.md", "b.md"]) });
    const afterFirst = await readFile(first.path, "utf8");
    expect(afterFirst).toContain("`.opencode/templates/b.md`");

    // Drop b.md from the frontmatter of the previously written content.
    const reduced = afterFirst.replace("  - b.md\n", "");
    await upsertSkill(workspace, { name, content: reduced });
    const afterSecond = await readFile(first.path, "utf8");
    expect(afterSecond).toContain("`.opencode/templates/a.md`");
    expect(afterSecond).not.toContain("b.md");

    // Removing all templates removes the managed section entirely.
    const none = afterSecond.replace("templates:\n  - a.md\n", "");
    await upsertSkill(workspace, { name, content: none });
    const afterThird = await readFile(first.path, "utf8");
    expect(afterThird).not.toContain("legalwork:templates");
    expect(afterThird).not.toContain("## Firm templates");
    expect(afterThird).toContain("Follow the firm's process.");
  });
});

describe("applyTemplatesSection", () => {
  test("is idempotent and preserves surrounding body text", () => {
    const body = "Intro paragraph.\n";
    const once = applyTemplatesSection(body, ["a.md"]);
    const twice = applyTemplatesSection(once, ["a.md"]);
    expect(twice).toBe(once);
    expect(once.startsWith("Intro paragraph.\n\n<!-- legalwork:templates:start -->")).toBe(true);
  });

  test("removes the section when the list becomes empty", () => {
    const withSection = applyTemplatesSection("Intro.\n", ["a.md"]);
    expect(applyTemplatesSection(withSection, [])).toBe("Intro.\n");
  });

  test("handles an empty body", () => {
    expect(applyTemplatesSection("", [])).toBe("");
    const only = applyTemplatesSection("", ["a.md"]);
    expect(only).toContain("## Firm templates");
    expect(applyTemplatesSection(only, ["a.md"])).toBe(only);
  });
});
