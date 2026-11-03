import { expect, test } from "bun:test";
import { join } from "node:path";
import { inspectSkillPackage, readSkillPackageFile } from "./skill-package.js";
import { skillPackageFixture } from "./skill-package.test-support.js";
import { writeFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";

test("full package includes Markdown, Word and helpers, and reads current installed bytes", async () => {
  const f = await skillPackageFixture();
  const manifest = await inspectSkillPackage(f.skill);
  expect(manifest.directory).toBe(f.directory);
  expect(manifest.files.map(file => file.path)).toEqual(["resources/felder.md", "resources/template.docx", "scripts/helper.py", "SKILL.md"].sort((a, b) => a.localeCompare(b)));
  expect((await readSkillPackageFile(f.skill, f.directory, "resources/felder.md")).content).toBe("Mandant und Aktenzeichen");
  expect((await readSkillPackageFile(f.skill, f.directory, "resources/template.docx")).content).toContain("Current firm template");
  expect((await readSkillPackageFile(f.skill, f.directory, "scripts/helper.py")).content).toContain("must never execute");
  await writeFile(join(f.directory, "resources/felder.md"), "Updated checklist");
  expect((await readSkillPackageFile(f.skill, f.directory, "resources/felder.md")).content).toBe("Updated checklist");
  expect((await inspectSkillPackage(f.skill)).hash).not.toBe(manifest.hash);
});

test("long resources paginate and Word content with tracked changes is marked incomplete", async () => {
  const f = await skillPackageFixture(), text = "a".repeat(30000);
  await writeFile(join(f.directory, "resources/long.md"), text);
  const first = await readSkillPackageFile(f.skill, f.directory, "resources/long.md");
  expect(first.nextOffset).toBe(24000);
  const second = await readSkillPackageFile(f.skill, f.directory, "resources/long.md", first.nextOffset);
  expect(first.content + second.content).toBe(text);
  expect(second.nextOffset).toBeUndefined();
  await writeFile(join(f.directory, "resources/template.docx"), zipSync({ "word/document.xml": strToU8('<w:document><w:ins><w:t>Changed</w:t></w:ins></w:document>') }));
  expect(await readSkillPackageFile(f.skill, f.directory, "resources/template.docx")).toMatchObject({ complete: false, notice: expect.stringContaining("visual review") });
});

test("Word extraction limits the whole document, including attached headers", async () => {
  const f = await skillPackageFixture();
  const xml = strToU8("<w:document>" + "a".repeat(9 * 1024 * 1024) + "</w:document>");
  await writeFile(join(f.directory, "resources/template.docx"), zipSync({ "word/document.xml": xml, "word/header1.xml": xml }));
  await expect(readSkillPackageFile(f.skill, f.directory, "resources/template.docx")).rejects.toThrow("extraction limit");
});
