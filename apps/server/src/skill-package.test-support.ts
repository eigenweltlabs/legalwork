import { afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

export async function skillPackageFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-package-"))); roots.push(root);
  const directory = join(root, "workflow");
  await mkdir(join(directory, "resources"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  const skill = join(directory, "SKILL.md");
  await writeFile(skill, "Read resources/felder.md, then use the attached template.");
  await writeFile(join(directory, "resources/felder.md"), "Mandant und Aktenzeichen");
  await writeFile(join(directory, "resources/template.docx"), zipSync({ "word/document.xml": strToU8('<w:document><w:p><w:t>Current firm template</w:t></w:p></w:document>') }));
  await writeFile(join(directory, "scripts/helper.py"), "raise Exception('Reading must never execute this')");
  return { root, directory, skill };
}

