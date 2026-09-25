import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ReloadReason } from "../types.js";
import { serialized } from "./storage.js";

/** Remove the executable legacy skill without deleting user edits or old result artifacts. */
export async function retireLegacyReview(workspaceRoot: string): Promise<ReloadReason[]> {
  const root = await realpath(workspaceRoot), reasons = new Set<ReloadReason>();
  const inside = (path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
  const legacy: Array<{ path: string; reason: ReloadReason }> = [
    { path: "skills/tabular-review", reason: "skills" }, { path: "commands/review-docs.md", reason: "commands" },
  ];
  for (const item of legacy) {
    const source = join(root, ".opencode", item.path);
    const exists = await lstat(source).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!exists) continue;
    if (!inside(await realpath(dirname(source)))) throw new Error("Legacy review files must be inside the project.");
    const backup = join(root, ".opencode", "legalwork", "retired-reviews");
    await mkdir(backup, { recursive: true, mode: 0o700 });
    if (!inside(await realpath(backup))) throw new Error("Review backup must be inside the project.");
    // Rename the entire folder, including unknown/custom files. Backups are outside skill discovery.
    await rename(source, join(backup, `${item.reason}-${randomUUID()}`));
    reasons.add(item.reason);
  }
  if (await migrateWorkflowWrappers(join(root, ".opencode", "skills"), inside)) reasons.add("skills");
  return [...reasons];
}

/** Global workflows are shared by all projects; migrate them once before engine startup. */
export async function retireSharedLegacyReview(skillsDirectory: string) {
  return serialized(`retire:${skillsDirectory}`, async () => {
    const skills = await realpath(skillsDirectory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!skills) return;
    const inside = (path: string) => { const part = relative(skills, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
    const source = join(skills, "tabular-review");
    if (await lstat(source).catch(error => { if (error.code === "ENOENT") return null; throw error; })) {
      const backup = join(dirname(skills), "legalwork-retired-reviews");
      await mkdir(backup, { recursive: true, mode: 0o700 });
      if (await realpath(backup) !== backup) throw new Error("Review backup must not use symbolic links.");
      await rename(source, join(backup, `skills-${randomUUID()}`));
    }
    await migrateWorkflowWrappers(skills, inside);
  });
}

async function migrateWorkflowWrappers(skills: string, inside: (path: string) => boolean) {
  let changed = false;
  // Migrate only the exact wrapper text we generated; retain users' column definitions.
  const directories = await readdir(skills, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of directories.filter(entry => entry.isDirectory() && entry.name.startsWith("workflow-tabular-"))) {
    const path = join(skills, entry.name, "SKILL.md");
    if (!(await lstat(path).catch(() => null))?.isFile()) continue;
    if (!inside(await realpath(path))) continue;
    const before = await readFile(path, "utf8");
    const after = before.replace('This is a **tabular review workflow**. To run it, load the **`tabular-review`** skill\nand build a review grid over the user\'s documents — one row per document.', 'This is a **tabular review workflow**. First read legalwork_review_settings and follow its mandatory mode. Use legalwork_review_library for exact saved prompts. Create and start a saved project review with legalwork_review_create and legalwork_review_start; do not build an HTML artifact.')
      .replace('Discover available models with tabular_review_models; choose LLM for cited extraction or SystemOne for typed, explicitly uncited decisions.', 'Only JEV permits yes/no or fixed-choice classification questions. Never silently rewrite or drop incompatible columns. Ask the user to select compatible questions or change their settings.')
      .replace(/(When the user asks to run "[^\n]+", )use the `tabular-review` skill\./g, '$1use the saved-review tools above.');
    if (after !== before) { await writeFile(path, after, "utf8"); changed = true; }
  }
  return changed;
}
