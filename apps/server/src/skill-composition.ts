import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listSkills, type SkillWorkspace } from "./skills.js";
import { ApiError } from "./errors.js";
import { deadlineToolGuide } from "./calculations/guidance.js";

import { inspectSkillPackage } from "./skill-package.js";

import { SkillExtensionSchema } from "./skill-lesson-schema.js";
export { SkillLessonInputSchema } from "./skill-lesson-schema.js";
/** Fingerprint the installed package, so changing instructions or executable invalidates an extension. */
export async function skillFingerprint(path: string): Promise<string> {
  return (await inspectSkillPackage(path)).hash;
}

export async function extensionAt(path: string) {
  try { return SkillExtensionSchema.parse(JSON.parse(await readFile(join(dirname(path), "legalwork-extension.json"), "utf8"))); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null; throw error; }
}
export async function composedSkill(workspace: SkillWorkspace, name: string, includeExtensions = true) {
  const installed = await listSkills(workspace, true);
  const chain: Array<{ name: string; hash: string; scope: string; content: string; directory: string; files: Array<{ path: string; size: number }> }> = [];
  const visiting = new Set<string>();
  async function visit(current: string) {
    if (visiting.has(current)) throw new ApiError(422, "skill_cycle", "Skill dependencies contain a cycle.");
    if (chain.some(item => item.name === current)) return;
    const skill = installed.find(skill => skill.name === current);
    if (!skill) throw new ApiError(422, "skill_dependency_missing", `Install the base skill ${current}.`);
    visiting.add(current);
    const extension = await extensionAt(skill.path);
    if (extension) {
      await visit(extension.base);
      if (chain.find(item => item.name === extension.base)?.hash !== extension.baseHash) throw new ApiError(409, "skill_base_changed", `The base of ${current} changed. Review and rebase its correction before using it.`);
    }
    chain.push({ name: skill.name, ...await inspectSkillPackage(skill.path), scope: skill.scope, content: await readFile(skill.path, "utf8") });
    visiting.delete(current);
  }
  await visit(name);
  if (includeExtensions) {
    // Load each descendant once; conflicting prose must be surfaced by the agent, never silently ranked.
    let added = true;
    while (added) {
      added = false;
      for (const skill of installed) {
        if (chain.some(item => item.name === skill.name)) continue;
        const extension = await extensionAt(skill.path);
        if (extension && chain.some(item => item.name === extension.base)) { await visit(skill.name); added = true; }
      }
    }
  }
  const calculationGuide = deadlineToolGuide(chain.map(item => item.name));
  return { name, chain, resources: {
    read: { tool: "legalwork_skill_read", arguments: { name: "Name from chain", path: "Exact relative path from that entry's files", offset: "Optional nextOffset for long files" } },
    shell: { tool: "legalwork_shell", skills: chain.map(item => item.name), mounts: chain.map((item, index) => ({ name: item.name, hostDirectory: item.directory, sandboxDirectory: `/skills/${index}` })) },
    instruction: "Use legalwork_skill_read for attached text and Word files. Paths in each entry are relative to its directory, not the project. For binary templates and helpers, pass the listed skills to legalwork_shell and use the matching /skills/N path when sandboxing is on, or hostDirectory when off. The entire selected package is available read-only in the sandbox. Command and file permissions still apply. Do not guess paths or request access to the global library.",
  }, ...(calculationGuide ? { calculationGuide } : {}), instruction: "Read base first, then apply extensions only within their stated scope. If instructions conflict, ask the user. Examples are regression expectations, not proof that executable tests ran. Corrections do not extend the coverage of code. Any calculationGuide below provides the current app tool contract without changing the installed skill or its pinned corrections." };
}
