import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

const MARKER = ".legalwork-windows-config-migration.json";
const CONFIG_GROUPS = [
  ["config.json", "opencode.json", "opencode.jsonc"],
  ["tui.json", "tui.jsonc"],
];
const CONFIG_FILES = new Set(CONFIG_GROUPS.flat());
const DATABASE_ARTIFACT = /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i;
const MIGRATION_VERSION = 2;
const ADDITIVE_ARRAYS = new Set(["plugin", "instructions", "skills.paths", "skills.urls"]);

function isSkillDirectory(pathname, root) {
  const parts = path.relative(root, pathname).split(path.sep);
  return parts.length > 1 && (parts[0] === "skills" || parts[0] === "skill");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeUniqueArray(previous, next) {
  const seen = new Set(previous.map((value) => JSON.stringify(value)));
  return [...previous, ...next.filter((value) => {
    const serialized = JSON.stringify(value);
    if (seen.has(serialized)) return false;
    seen.add(serialized);
    return true;
  })];
}

function mergeValues(previous, next, keys = []) {
  if (Array.isArray(previous) && Array.isArray(next) && ADDITIVE_ARRAYS.has(keys.join("."))) {
    return mergeUniqueArray(previous, next);
  }
  if (!isObject(previous) || !isObject(next)) return next;
  const result = Object.assign(Object.create(null), previous);
  for (const [key, value] of Object.entries(next)) {
    Object.defineProperty(result, key, {
      value: Object.hasOwn(result, key) ? mergeValues(result[key], value, [...keys, key]) : value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function missingValues(source, target, prefix = [], additions = [], conflicts = []) {
  for (const [key, value] of Object.entries(source)) {
    const keys = [...prefix, key];
    if (!Object.hasOwn(target, key)) {
      additions.push({ keys, value });
    } else if (isObject(value) && isObject(target[key])) {
      missingValues(value, target[key], keys, additions, conflicts);
    } else if (Array.isArray(value) && Array.isArray(target[key]) && ADDITIVE_ARRAYS.has(keys.join("."))) {
      const merged = mergeUniqueArray(target[key], value);
      if (merged.length !== target[key].length) additions.push({ keys, value: merged });
    } else if (JSON.stringify(value) !== JSON.stringify(target[key])) {
      conflicts.push(keys.join("."));
    }
  }
  return { additions, conflicts };
}

async function existing(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function sameFileContents(first, second) {
  const [firstStat, secondStat] = await Promise.all([stat(first), stat(second)]);
  if (!firstStat.isFile() || !secondStat.isFile() || firstStat.size !== secondStat.size) return false;
  const digest = async (pathname) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(pathname)) hash.update(chunk);
    return hash.digest("hex");
  };
  return await digest(first) === await digest(second);
}

async function copyFileAtomically(source, target) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeFileAtomically(target, content) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readConfig(pathname) {
  const raw = await readFile(pathname, "utf8");
  const errors = [];
  const value = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length || !isObject(value)) {
    throw new Error(`Invalid JSON(C) object: ${pathname}`);
  }
  return { raw, value };
}

async function configEntries(root, names, failures) {
  const entries = [];
  for (const name of names) {
    const pathname = path.join(root, name);
    if (!(await existing(pathname))) continue;
    try {
      entries.push({ name, pathname, ...(await readConfig(pathname)) });
    } catch (error) {
      failures.push({ path: pathname, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return entries;
}

async function mergeConfigGroup(source, target, names, result) {
  const sourceEntries = await configEntries(source, names, result.failed);
  if (!sourceEntries.length) return;
  const targetFailures = [];
  const targetEntries = await configEntries(target, names, targetFailures);
  if (targetFailures.length) {
    result.failed.push(...targetFailures);
    return;
  }
  if (!targetEntries.length) {
    if (sourceEntries.length > 1) {
      const combined = sourceEntries.reduce((value, entry) => mergeValues(value, entry.value), Object.create(null));
      try {
        await writeFileAtomically(path.join(target, names.at(-1)), `${JSON.stringify(combined, null, 2)}\n`);
        result.merged += sourceEntries.length;
      } catch (error) {
        result.failed.push({ path: sourceEntries[0].pathname, reason: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    for (const entry of sourceEntries) {
      try {
        await copyFileAtomically(entry.pathname, path.join(target, entry.name));
        result.copied += 1;
      } catch (error) {
        result.failed.push({ path: entry.pathname, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return;
  }

  const sourceConfig = sourceEntries.reduce((value, entry) => mergeValues(value, entry.value), Object.create(null));
  const targetConfig = targetEntries.reduce((value, entry) => mergeValues(value, entry.value), Object.create(null));
  const { additions, conflicts } = missingValues(sourceConfig, targetConfig);
  result.conflicts.push(...conflicts.map((key) => `${sourceEntries[0].pathname}: ${key}`));
  if (!additions.length) return;

  // Add missing settings to the file LegalWork's global config editor opens.
  // Existing native OpenCode values retain precedence, including values in
  // lower-priority files that would otherwise be shadowed by this file.
  const editable = targetEntries.find((entry) => entry.name === "opencode.jsonc" || entry.name === "tui.jsonc")
    ?? targetEntries.find((entry) => entry.name === "opencode.json" || entry.name === "tui.json");
  const destination = editable?.pathname ?? path.join(target, names.at(-1));
  let content = editable?.raw ?? "{}\n";
  for (const { keys, value } of additions) {
    content = applyEdits(content, modify(content, keys, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }));
  }

  const backup = editable ? path.join(target, ".legalwork-migration-backup", `${editable.name}.${randomUUID()}`) : null;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    if (backup) {
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(destination, backup, constants.COPYFILE_EXCL);
    }
    await writeFile(temporary, content, "utf8");
    await rename(temporary, destination);
    result.merged += additions.length;
  } catch (error) {
    result.failed.push({ path: destination, reason: error instanceof Error ? error.message : String(error) });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function copyMissingTree(source, target, result, sourceRoot = source, targetRoot = target) {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()));
  for (const entry of entries) {
    if (source === sourceRoot && (CONFIG_FILES.has(entry.name) || entry.name === MARKER)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    // OpenCode's older data location can overlap this AppData directory.
    // A SQLite DB (including its WAL/journal) is runtime data, not config;
    // keep it where the existing database migration can still find it.
    if (source === sourceRoot && (entry.isFile() || entry.isSymbolicLink()) && DATABASE_ARTIFACT.test(entry.name)) {
      result.skipped.push(from);
      continue;
    }
    try {
      const sourceStat = await lstat(from);
      const targetStat = await existing(to);
      if (sourceStat.isDirectory()) {
        if (targetStat && !targetStat.isDirectory()) {
          result.conflicts.push(from);
          continue;
        }
        // A skill's SKILL.md and supporting files form one install. Mixing
        // files from two different installs with the same name can break both.
        if (targetStat && isSkillDirectory(from, sourceRoot)
          && await existing(path.join(from, "SKILL.md"))
          && await existing(path.join(to, "SKILL.md"))
          && !(await sameFileContents(path.join(from, "SKILL.md"), path.join(to, "SKILL.md")))) {
          result.conflicts.push(from);
          continue;
        }
        await mkdir(to, { recursive: true });
        await copyMissingTree(from, to, result, sourceRoot, targetRoot);
      } else if (targetStat) {
        if (!sourceStat.isFile() || !targetStat.isFile() || !(await sameFileContents(from, to))) {
          result.conflicts.push(from);
        }
      } else if (sourceStat.isSymbolicLink()) {
        const original = path.resolve(path.dirname(from), await readlink(from));
        const relative = path.relative(sourceRoot, original);
        const insideSource = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        const destination = insideSource ? path.join(targetRoot, relative) : original;
        const isDirectory = await stat(from).then((value) => value.isDirectory()).catch(() => false);
        await symlink(destination, to, isDirectory ? (process.platform === "win32" ? "junction" : "dir") : "file");
        result.copied += 1;
      } else if (sourceStat.isFile()) {
        await copyFileAtomically(from, to);
        result.copied += 1;
      } else {
        result.failed.push({ path: from, reason: "Unsupported file type" });
      }
    } catch (error) {
      result.failed.push({ path: from, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Keep OpenCode's already-active XDG files, and import LegalWork's old AppData files. */
export async function migrateLegacyWindowsOpenCodeConfig(source, target) {
  const result = { copied: 0, merged: 0, conflicts: [], skipped: [], failed: [] };
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase() || !(await existing(source))) return result;
  const marker = path.join(target, MARKER);
  if (await existing(marker)) {
    try {
      const previous = JSON.parse(await readFile(marker, "utf8"));
      if (previous.version === MIGRATION_VERSION && previous.source === source && previous.target === target) return result;
    } catch {
      // A truncated marker from a cancelled migration must not hide old files.
    }
  }
  await mkdir(target, { recursive: true });

  for (const names of CONFIG_GROUPS) await mergeConfigGroup(source, target, names, result);
  await copyMissingTree(source, target, result);
  if (!result.failed.length) {
    const temporary = `${marker}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: MIGRATION_VERSION, source, target, copied: result.copied, merged: result.merged, conflicts: result.conflicts, skipped: result.skipped }, null, 2)}\n`);
      await rename(temporary, marker);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return result;
}
