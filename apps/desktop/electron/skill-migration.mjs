import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { normalizeImportedSkill } from "./skill-import.mjs";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function needsRepair(raw, name) {
  const content = raw.replace(/^\uFEFF/, "");
  const match = content.match(FRONTMATTER);
  if (!match) return true;
  const metadata = parse(match[1]);
  return metadata?.name !== name || typeof metadata.description !== "string" || !metadata.description.trim();
}

async function workflowFiles(root) {
  const found = [];
  const failed = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const direct = path.join(root, entry.name);
    const directFile = path.join(direct, "SKILL.md");
    try {
      if ((await lstat(directFile)).isFile()) {
        if (entry.name.startsWith("workflow-")) found.push(directFile);
        continue;
      }
    } catch (error) {
      if (error.code !== "ENOENT") failed.push({ file: directFile, reason: error.message });
    }
    let nestedEntries;
    try {
      nestedEntries = await readdir(direct, { withFileTypes: true });
    } catch (error) {
      failed.push({ file: direct, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const nested of nestedEntries) {
      if (!nested.isDirectory() || !nested.name.startsWith("workflow-")) continue;
      const directory = path.join(direct, nested.name);
      const file = path.join(directory, "SKILL.md");
      try {
        if ((await lstat(file)).isFile()) found.push(file);
      } catch (error) {
        if (error.code !== "ENOENT") failed.push({ file, reason: error.message });
      }
    }
  }
  return { found, failed };
}

export async function migrateInstalledWorkflows(root) {
  let files;
  try {
    files = await workflowFiles(root);
  } catch (error) {
    if (error.code === "ENOENT") return { migrated: 0, failed: [] };
    throw error;
  }

  let migrated = 0;
  const failed = files.failed;
  for (const file of files.found) {
    let temporary;
    try {
      const raw = await readFile(file, "utf8");
      const name = path.basename(path.dirname(file));
      if (!needsRepair(raw, name)) continue;
      const normalized = normalizeImportedSkill(raw, name);
      const mode = (await lstat(file)).mode;
      temporary = path.join(path.dirname(file), `.SKILL.md.${randomUUID()}.tmp`);
      await writeFile(temporary, normalized, { mode });
      await chmod(temporary, mode);
      await rename(temporary, file);
      migrated += 1;
    } catch (error) {
      failed.push({ file, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return { migrated, failed };
}
