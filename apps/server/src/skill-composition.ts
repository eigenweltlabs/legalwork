import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listSkills } from "./skills.js";
import { ApiError } from "./errors.js";
import { deadlineToolGuide } from "./calculations/guidance.js";

import { SkillExtensionSchema } from "./skill-lesson-schema.js";
export { SkillLessonInputSchema } from "./skill-lesson-schema.js";
/** Fingerprint the installed package, so changing instructions or executable invalidates an extension. */
export async function skillFingerprint(path: string): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  async function walk(dir: string, prefix: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
      const relative = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new ApiError(422, "skill_dependency", "Skill dependencies must not contain symbolic links.");
      if (entry.isDirectory()) { await walk(join(dir, entry.name), `${relative}/`); continue; }
      const bytes = await readFile(join(dir, entry.name)); size += bytes.length;
      if (size > 32_000_000) throw new ApiError(422, "skill_dependency", "Skill package is too large to pin.");
      hash.update(relative).update("\0").update(bytes).update("\0");
    }
  }
  await walk(dirname(path), ""); return hash.digest("hex");
}
export async function extensionAt(path: string) {
  try { return SkillExtensionSchema.parse(JSON.parse(await readFile(join(dirname(path), "legalwork-extension.json"), "utf8"))); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null; throw error; }
}
export async function composedSkill(workspace: string, name: string, includeExtensions = true) {
  const installed = await listSkills(workspace, true);
  const chain: Array<{ name: string; hash: string; scope: string; content: string }> = [];
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
    chain.push({ name: skill.name, hash: await skillFingerprint(skill.path), scope: skill.scope, content: await readFile(skill.path, "utf8") });
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
  return { name, chain, ...(calculationGuide ? { calculationGuide } : {}), instruction: "Read base first, then apply extensions only within their stated scope. If instructions conflict, ask the user. Examples are regression expectations, not proof that executable tests ran. Corrections do not extend the coverage of code. Any calculationGuide below provides the current app tool contract without changing the installed skill or its pinned corrections." };
}
