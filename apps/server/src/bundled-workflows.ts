import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUNDLED_WORKFLOW_FILES } from "./core-skills.js";
import { exists } from "./utils.js";
import { globalSkillsDir } from "./workspace-files.js";

export const BUNDLED_WORKFLOW_NAMES = [...new Set(BUNDLED_WORKFLOW_FILES.map(file => file.path.split("/")[0]!))];

const previousDefaults: Record<string, string> = {
  "workflow-firm-knowledge": "3fbae9c3646e40877aa2aa3a33d21e51480617571d1e56d30623227bb92dcdaa",
  "workflow-suggest-timesheet": "1b5a3f1f9053d4a8f39ba4651c856d034c850328cfdbd9e256175a9286b43d12",
};

/** Install changed defaults without replacing customized workflows. */
async function upgradeDefault(name: string, destination: string) {
  const path = join(destination, "SKILL.md");
  const content = await readFile(path).catch(() => null);
  if (!content || createHash("sha256").update(content).digest("hex") !== previousDefaults[name]) return;
  const launcher = BUNDLED_WORKFLOW_FILES.find(file => file.path === name + "/SKILL.md");
  if (launcher) await writeFile(path, Buffer.from(launcher.content, launcher.encoding));
}

/** Install complete defaults once; migrate only known unmodified defaults. */
export async function ensureBundledWorkflows(root = globalSkillsDir()): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const name of BUNDLED_WORKFLOW_NAMES) {
    const destination = join(root, name);
    if (await exists(destination)) {
      if (previousDefaults[name]) await upgradeDefault(name, destination);
      continue;
    }
    // No SKILL.md is visible to discovery until its attachments are in place.
    const staging = await mkdtemp(join(dirname(root), ".bundled-workflow-"));
    try {
      const folder = join(staging, name);
      for (const file of BUNDLED_WORKFLOW_FILES.filter(file => file.path.startsWith(name + "/"))) {
        const path = join(staging, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(file.content, file.encoding));
      }
      try {
        await rename(folder, destination);
      } catch (error) {
        // A concurrent startup may have installed it first.
        if (!(error instanceof Error) || !("code" in error)
          || !["ENOTEMPTY", "EEXIST"].includes(String(error.code)) || !(await exists(destination))) throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
