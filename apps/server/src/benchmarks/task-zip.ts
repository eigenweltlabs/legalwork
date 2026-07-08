import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { ensureHarveyDocuments } from "./harvey-catalog.js";
import type { BenchmarkTaskRow } from "./store.js";
import {
  parseHarveyTaskJson,
  type BenchmarkTaskDefinition,
} from "./task-schema.js";

/** Upper bound on tasks per archive — guards against pathological imports. */
export const MAX_ZIP_TASKS = 2000;

export type ParsedZipTask = {
  folder: string;
  definition: BenchmarkTaskDefinition;
  documents: Array<{ name: string; bytes: Uint8Array }>;
};

function safeParseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function rowToDefinition(row: BenchmarkTaskRow): BenchmarkTaskDefinition {
  return {
    title: row.title,
    workType: row.workType,
    tags: safeParseArray<string>(row.tagsJson),
    instructions: row.instructions,
    deliverables: safeParseArray<string>(row.deliverablesJson),
    criteria: safeParseArray<BenchmarkTaskDefinition["criteria"][number]>(row.criteriaJson),
  };
}

/** Serialize a task in the Harvey `task.json` shape (round-trips through parseHarveyTaskJson). */
function toHarveyJson(task: BenchmarkTaskDefinition): Record<string, unknown> {
  return {
    title: task.title,
    work_type: task.workType,
    tags: task.tags,
    instructions: task.instructions,
    deliverables: Object.fromEntries(task.deliverables.map((name) => [name, name])),
    criteria: task.criteria.map((criterion) => ({
      id: criterion.id,
      title: criterion.title,
      deliverables: criterion.deliverables,
      match_criteria: criterion.matchCriteria,
    })),
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "task";
}

function uniqueSlug(base: string, used: Set<string>): string {
  let slug = base;
  let counter = 2;
  while (used.has(slug)) slug = `${base}-${counter++}`;
  used.add(slug);
  return slug;
}

/** Resolve the on-disk documents directory for a stored task (custom dir or Harvey cache). */
async function resolveDocumentsDir(
  config: Pick<ServerConfig, "configPath">,
  row: BenchmarkTaskRow,
): Promise<string | null> {
  if (row.source === "custom") return row.documentsDir;
  if (!row.catalogRef) return null;
  const documents = safeParseArray<string>(row.harveyDocumentsJson);
  if (!documents.length) return null;
  return ensureHarveyDocuments(config, row.catalogRef, {
    key: row.id,
    vertical: row.id.split("/")[1] ?? "",
    name: row.id.split("/")[2] ?? row.id,
    documents,
  });
}

/** Recursively collect the files under a directory as posix-relative paths. */
async function collectFiles(dir: string, base = dir): Promise<Array<{ rel: string; bytes: Uint8Array }>> {
  const out: Array<{ rel: string; bytes: Uint8Array }> = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(abs, base)));
    } else if (entry.isFile()) {
      out.push({ rel: relative(base, abs).split(sep).join("/"), bytes: await readFile(abs) });
    }
  }
  return out;
}

/**
 * Build a Zip archive from stored task rows. Each task becomes a
 * `<slug>/task.json` (Harvey-compatible) plus its input documents under
 * `<slug>/documents/…`, so the archive round-trips through the importer and is
 * interoperable with the upstream Harvey repository layout.
 */
export async function buildTasksZip(
  config: Pick<ServerConfig, "configPath">,
  rows: BenchmarkTaskRow[],
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const usedSlugs = new Set<string>();
  for (const row of rows) {
    const definition = rowToDefinition(row);
    const slug = uniqueSlug(slugify(definition.title || row.id), usedSlugs);
    files[`${slug}/task.json`] = strToU8(`${JSON.stringify(toHarveyJson(definition), null, 2)}\n`);
    const documentsDir = await resolveDocumentsDir(config, row);
    if (documentsDir) {
      for (const file of await collectFiles(documentsDir)) {
        files[`${slug}/documents/${file.rel}`] = file.bytes;
      }
    }
  }
  return zipSync(files);
}

function isSafeDocumentName(name: string): boolean {
  if (!name || name.endsWith("/")) return false;
  return !name.split("/").some((segment) => segment === ".." || segment === "");
}

/**
 * Parse a Zip archive into task definitions + their documents. Any `**​/task.json`
 * entry is read as a Harvey-format task; sibling `documents/…` files are attached.
 * Malformed tasks are reported in `failed` rather than aborting the whole import.
 */
export function parseTasksZip(bytes: Uint8Array): {
  tasks: ParsedZipTask[];
  failed: Array<{ path: string; error: string }>;
} {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new ApiError(400, "invalid_zip", "Could not read the Zip archive.");
  }
  const paths = Object.keys(archive);
  const taskJsonPaths = paths.filter((path) => path === "task.json" || path.endsWith("/task.json"));
  if (taskJsonPaths.length === 0) {
    throw new ApiError(400, "invalid_zip", "The archive contains no task.json files.");
  }
  if (taskJsonPaths.length > MAX_ZIP_TASKS) {
    throw new ApiError(400, "invalid_zip", `The archive has more than ${MAX_ZIP_TASKS} tasks.`);
  }
  const tasks: ParsedZipTask[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const path of taskJsonPaths) {
    const folder = path === "task.json" ? "" : path.slice(0, -"/task.json".length);
    let raw: unknown;
    try {
      raw = JSON.parse(strFromU8(archive[path]));
    } catch {
      failed.push({ path, error: "Invalid JSON" });
      continue;
    }
    const parsed = parseHarveyTaskJson(raw);
    if (!parsed.ok) {
      failed.push({ path, error: parsed.error });
      continue;
    }
    const prefix = folder ? `${folder}/documents/` : "documents/";
    const documents = paths
      .filter((candidate) => candidate.startsWith(prefix))
      .map((candidate) => ({ name: candidate.slice(prefix.length), bytes: archive[candidate] }))
      .filter((document) => isSafeDocumentName(document.name));
    tasks.push({ folder, definition: parsed.task, documents });
  }
  return { tasks, failed };
}
