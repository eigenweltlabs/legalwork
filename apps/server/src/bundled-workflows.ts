import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BUNDLED_WORKFLOW_FILES } from "./core-skills.js";
import { exists } from "./utils.js";
import { globalSkillsDir } from "./workspace-files.js";

export const BUNDLED_WORKFLOW_NAMES = [...new Set(BUNDLED_WORKFLOW_FILES.map(file => file.path.split("/")[0]!))];

/** Install complete defaults once; subsequent launches preserve firm edits. */
export async function ensureBundledWorkflows(root = globalSkillsDir()): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const name of BUNDLED_WORKFLOW_NAMES) {
    const destination = join(root, name);
    if (await exists(destination)) continue;
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
