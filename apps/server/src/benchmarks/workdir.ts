/**
 * Scratch working directories for benchmark run items.
 *
 * Each task×model item gets its own directory inside the workspace root
 * (<workspace>/.legalwork/benchmarks/<runId>/<itemId>/) so the opencode engine
 * can read staged documents and write deliverables while staying inside
 * authorizedRoots. An inner `.gitignore` keeps runs from dirtying user repos.
 */
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { exists } from "../utils.js";

const SCRATCH_SEGMENTS = [".legalwork", "benchmarks"] as const;

export function benchmarkScratchRoot(workspacePath: string): string {
  return join(workspacePath, ...SCRATCH_SEGMENTS);
}

export function runScratchDir(workspacePath: string, runId: string): string {
  return join(benchmarkScratchRoot(workspacePath), runId);
}

export function itemWorkDir(workspacePath: string, runId: string, itemId: string): string {
  return join(runScratchDir(workspacePath, runId), itemId);
}

async function ensureScratchGitignore(workspacePath: string): Promise<void> {
  const root = benchmarkScratchRoot(workspacePath);
  await mkdir(root, { recursive: true });
  const gitignore = join(root, ".gitignore");
  if (!(await exists(gitignore))) {
    await writeFile(gitignore, "*\n", "utf8");
  }
}

export async function prepareItemWorkDir(input: {
  workspacePath: string;
  runId: string;
  itemId: string;
  documentsDir: string | null;
}): Promise<string> {
  await ensureScratchGitignore(input.workspacePath);
  const workDir = itemWorkDir(input.workspacePath, input.runId, input.itemId);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  if (input.documentsDir && (await exists(input.documentsDir))) {
    await cp(input.documentsDir, join(workDir, "documents"), { recursive: true });
  }
  return workDir;
}

export type CollectedDeliverable = {
  name: string;
  relativePath: string | null;
  size: number | null;
};

async function listOutputFiles(workDir: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = relative(workDir, full);
      // The staged inputs are not agent output.
      if (rel === "documents" || rel.startsWith(`documents${sep}`)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  await walk(workDir);
  return results.sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b));
}

/**
 * Match expected deliverable filenames against what the agent actually wrote.
 * Basenames match case-insensitively; the shallowest match wins.
 */
export async function collectDeliverables(
  workDir: string,
  expectedNames: string[],
): Promise<{ deliverables: CollectedDeliverable[]; outputFiles: string[] }> {
  const outputFiles = await listOutputFiles(workDir);
  const deliverables: CollectedDeliverable[] = [];
  for (const name of expectedNames) {
    const wanted = basename(name).toLowerCase();
    const match = outputFiles.find((file) => basename(file).toLowerCase() === wanted) ?? null;
    let size: number | null = null;
    if (match) {
      size = await stat(join(workDir, match))
        .then((info) => info.size)
        .catch(() => null);
    }
    deliverables.push({ name, relativePath: match, size });
  }
  return { deliverables, outputFiles };
}

export async function removeRunScratchDir(workspacePath: string, runId: string): Promise<void> {
  await rm(runScratchDir(workspacePath, runId), { recursive: true, force: true });
}

function sanitizeTaskDirName(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function taskDocumentsScratchDir(workspacePath: string, taskId: string): string {
  return join(benchmarkScratchRoot(workspacePath), "task-docs", sanitizeTaskDirName(taskId));
}

export type StagedTaskDocument = {
  name: string;
  /** Workspace-relative path — usable with the regular workspace file APIs. */
  relativePath: string;
  size: number;
};

async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) results.push(relative(root, full));
    }
  };
  await walk(root);
  return results.sort();
}

/**
 * Mirror a task's input documents into the workspace scratch area so the
 * client can open them through the regular workspace file viewer. Copies only
 * files that are not staged yet; returns the staged listing either way.
 */
export async function stageTaskDocuments(
  workspacePath: string,
  taskId: string,
  sourceDir: string | null,
): Promise<StagedTaskDocument[]> {
  const targetDir = taskDocumentsScratchDir(workspacePath, taskId);
  if (sourceDir && (await exists(sourceDir))) {
    await ensureScratchGitignore(workspacePath);
    for (const rel of await walkFiles(sourceDir)) {
      const destination = join(targetDir, rel);
      if (await exists(destination)) continue;
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(sourceDir, rel), destination);
    }
  }
  const staged: StagedTaskDocument[] = [];
  for (const rel of await walkFiles(targetDir)) {
    const full = join(targetDir, rel);
    const size = await stat(full)
      .then((info) => info.size)
      .catch(() => 0);
    staged.push({
      name: rel.split(sep).join("/"),
      relativePath: relative(workspacePath, full).split(sep).join("/"),
      size,
    });
  }
  return staged;
}

export async function removeTaskDocumentsScratchDir(workspacePath: string, taskId: string): Promise<void> {
  await rm(taskDocumentsScratchDir(workspacePath, taskId), { recursive: true, force: true });
}
