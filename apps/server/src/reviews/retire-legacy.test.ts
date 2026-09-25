import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retireLegacyReview, retireSharedLegacyReview } from "./retire-legacy.js";

test("retires the old executable skill and command while preserving customized files and result artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-retirement-"));
  try {
    const skill = join(root, ".opencode/skills/tabular-review");
    await mkdir(skill, { recursive: true }); await mkdir(join(root, ".opencode/commands"));
    await writeFile(join(skill, "SKILL.md"), "User's changed review instructions");
    await writeFile(join(skill, "custom.txt"), "A custom prompt");
    await writeFile(join(root, ".opencode/commands/review-docs.md"), "Custom command");
    await writeFile(join(root, "existing-review.html"), "User review results");
    expect((await retireLegacyReview(root)).sort()).toEqual(["commands", "skills"]);
    expect(await stat(skill).catch(() => null)).toBeNull();
    const backups = join(root, ".opencode/legalwork/retired-reviews");
    const dir = (await readdir(backups)).find(name => name.startsWith("skills-"))!;
    expect(await readFile(join(backups, dir, "SKILL.md"), "utf8")).toBe("User's changed review instructions");
    expect(await readFile(join(backups, dir, "custom.txt"), "utf8")).toBe("A custom prompt");
    expect(await readFile(join(root, "existing-review.html"), "utf8")).toBe("User review results");
    expect(await retireLegacyReview(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retires shared legacy skills and migrates global workflow wrappers without changing custom prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-shared-migration-"));
  try {
    const skills = join(root, "skills");
    await mkdir(join(skills, "tabular-review"), { recursive: true });
    await writeFile(join(skills, "tabular-review/SKILL.md"), "My custom legacy review");
    const workflow = join(skills, "workflow-tabular-custom/SKILL.md");
    await mkdir(join(skills, "workflow-tabular-custom"));
    await writeFile(workflow, 'This is a **tabular review workflow**. To run it, load the **`tabular-review`** skill\nand build a review grid over the user\'s documents — one row per document.\n\nDoes this have a liability cap?');
    await Promise.all([retireSharedLegacyReview(skills), retireSharedLegacyReview(skills)]);
    expect(await stat(join(skills, "tabular-review")).catch(() => null)).toBeNull();
    expect(await readFile(workflow, "utf8")).toContain("legalwork_review_settings");
    expect(await readFile(workflow, "utf8")).toContain("Does this have a liability cap?");
    const backups = await readdir(join(root, "legalwork-retired-reviews"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, "legalwork-retired-reviews", backups[0], "SKILL.md"), "utf8")).toBe("My custom legacy review");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("updates only generated workflow instructions and keeps the actual column prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-workflow-migration-"));
  try {
    const path = join(root, ".opencode/skills/workflow-tabular-lease/SKILL.md");
    await mkdir(join(root, ".opencode/skills/workflow-tabular-lease"), { recursive: true });
    await writeFile(path, 'This is a **tabular review workflow**. To run it, load the **`tabular-review`** skill\nand build a review grid over the user\'s documents — one row per document.\n\n## What to extract\nDoes the tenant have a renewal option?\n');
    await retireLegacyReview(root);
    const text = await readFile(path, "utf8");
    expect(text).toContain("legalwork_review_settings"); expect(text).toContain("Does the tenant have a renewal option?"); expect(text).not.toContain("`tabular-review`");
    expect(await retireLegacyReview(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
