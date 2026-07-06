import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError } from "./errors.js";
import { exists } from "./utils.js";
import { validateSkillName } from "./validators.js";
import { projectSkillsDir } from "./workspace-files.js";

// Attached files (firm templates, playbooks, …) live INSIDE the skill's own
// folder: .opencode/skills/<name>/resources/<file>. A workflow plus its
// templates is one self-contained folder that can be shared as a zip — no
// global library to collect files from. The SKILL.md body carries an
// auto-managed "Attached resources" section (delimited block below) that is
// regenerated from the resources/ folder whenever a file is added or removed;
// the folder itself is the attachment state.

export type SkillResourceItem = {
  name: string;
  path: string;
  size: number;
  updatedAt: number;
};

// A resource name is a plain file name — no directories, no dot-prefix, no `..`.
const RESOURCE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;
const TEXT_RESOURCE_EXTENSIONS = new Set(["md", "markdown", "txt", "csv"]);

export function validateResourceName(name: string): void {
  const ok =
    RESOURCE_NAME_REGEX.test(name) &&
    !name.includes("..") &&
    !name.endsWith(" ") &&
    !name.endsWith(".");
  if (!ok) {
    throw new ApiError(
      400,
      "invalid_resource_name",
      "Resource name must be a plain file name (letters, numbers, spaces, dots, dashes; no slashes or ..)",
    );
  }
}

export function isTextResource(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_RESOURCE_EXTENSIONS.has(ext);
}

async function findSkillDirInBase(baseDir: string, skillName: string): Promise<string | null> {
  // Flat layout: <base>/<name>/SKILL.md
  const flat = join(baseDir, skillName);
  if (await exists(join(flat, "SKILL.md"))) return flat;
  // Nested layout: <base>/<domain>/<name>/SKILL.md — same convention the
  // skills listing supports (see listSkillsInDir in skills.ts).
  if (!(await exists(baseDir))) return null;
  const entries = await readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = join(baseDir, entry.name, skillName);
    if (await exists(join(nested, "SKILL.md"))) return nested;
  }
  return null;
}

// Same global roots the skills listing scans (see listSkills in skills.ts).
// The desktop app installs skills globally ($XDG_CONFIG_HOME/opencode/skills),
// so the resource routes must resolve those folders too, not just the workspace.
function globalSkillsBaseDirs(): string[] {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return [
    join(configHome, "opencode", "skills"),
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".agent", "skills"),
  ];
}

/**
 * Resolve a skill's folder from the same identifier the skills routes use
 * (the kebab-case skill name). Checks the workspace's .opencode/skills and
 * .claude/skills first, then the global skills dirs, in both the flat and the
 * nested (<domain>/<name>) layouts.
 */
export async function resolveSkillDir(workspaceRoot: string, skillName: string): Promise<string> {
  const trimmed = skillName.trim();
  validateSkillName(trimmed); // kebab-case only — path-traversal safe
  const fromOpencode = await findSkillDirInBase(projectSkillsDir(workspaceRoot), trimmed);
  if (fromOpencode) return fromOpencode;
  const fromClaude = await findSkillDirInBase(join(workspaceRoot, ".claude", "skills"), trimmed);
  if (fromClaude) return fromClaude;
  for (const baseDir of globalSkillsBaseDirs()) {
    const fromGlobal = await findSkillDirInBase(baseDir, trimmed);
    if (fromGlobal) return fromGlobal;
  }
  throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
}

async function listResourceNames(resourcesDir: string): Promise<string[]> {
  if (!(await exists(resourcesDir))) return [];
  const entries = await readdir(resourcesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function listSkillResources(workspaceRoot: string, skillName: string): Promise<SkillResourceItem[]> {
  const skillDir = await resolveSkillDir(workspaceRoot, skillName);
  const dir = join(skillDir, "resources");
  const items: SkillResourceItem[] = [];
  for (const name of await listResourceNames(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    items.push({ name, path, size: info.size, updatedAt: info.mtimeMs });
  }
  return items;
}

export async function readSkillResource(
  workspaceRoot: string,
  skillName: string,
  fileName: string,
): Promise<{ item: SkillResourceItem; content: string }> {
  const trimmed = fileName.trim();
  validateResourceName(trimmed);
  const skillDir = await resolveSkillDir(workspaceRoot, skillName);
  const path = join(skillDir, "resources", trimmed);
  if (!(await exists(path))) {
    throw new ApiError(404, "resource_not_found", `Attached file not found: ${trimmed}`);
  }
  if (!isTextResource(trimmed)) {
    throw new ApiError(415, "resource_not_text", "Only text files (.md, .txt, .csv) can be opened in the editor");
  }
  const info = await stat(path);
  const content = await readFile(path, "utf8");
  return { item: { name: trimmed, path, size: info.size, updatedAt: info.mtimeMs }, content };
}

export type UpsertSkillResourcePayload = {
  name: string;
  content?: string;
  contentBase64?: string;
};

export async function upsertSkillResource(
  workspaceRoot: string,
  skillName: string,
  payload: UpsertSkillResourcePayload,
): Promise<{ name: string; path: string; skillPath: string; action: "added" | "updated" }> {
  const name = payload.name.trim();
  validateResourceName(name);
  if (typeof payload.content !== "string" && typeof payload.contentBase64 !== "string") {
    throw new ApiError(400, "invalid_resource_content", "Resource content is required");
  }
  const skillDir = await resolveSkillDir(workspaceRoot, skillName);
  const dir = join(skillDir, "resources");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const existed = await exists(path);
  if (typeof payload.contentBase64 === "string") {
    await writeFile(path, Buffer.from(payload.contentBase64, "base64"));
  } else {
    await writeFile(path, payload.content ?? "", "utf8");
  }
  await syncResourcesSection(skillDir);
  return { name, path, skillPath: join(skillDir, "SKILL.md"), action: existed ? "updated" : "added" };
}

export async function deleteSkillResource(
  workspaceRoot: string,
  skillName: string,
  fileName: string,
): Promise<{ path: string; skillPath: string }> {
  const trimmed = fileName.trim();
  validateResourceName(trimmed);
  const skillDir = await resolveSkillDir(workspaceRoot, skillName);
  const path = join(skillDir, "resources", trimmed);
  if (!(await exists(path))) {
    throw new ApiError(404, "resource_not_found", `Attached file not found: ${trimmed}`);
  }
  await rm(path, { force: true });
  await syncResourcesSection(skillDir);
  return { path, skillPath: join(skillDir, "SKILL.md") };
}

// ---------------------------------------------------------------------------
// Auto-managed "Attached resources" section in SKILL.md. Paths are RELATIVE
// (resources/<file>) so the skill folder stays portable — zip it up and the
// references still resolve.
// ---------------------------------------------------------------------------

const RESOURCES_SECTION_START = "<!-- legalwork:resources:start -->";
const RESOURCES_SECTION_END = "<!-- legalwork:resources:end -->";
const RESOURCES_SECTION_REGEX =
  /(?:\r?\n)*<!-- legalwork:resources:start -->[\s\S]*?<!-- legalwork:resources:end -->(?:\r?\n)*/g;

function renderResourcesSection(names: string[]): string {
  return [
    RESOURCES_SECTION_START,
    "## Attached resources",
    "",
    "This skill ships with the firm's own templates and playbooks in its `resources/` folder (next to this file). Before drafting, read each file below and follow its structure, language, and standards:",
    "",
    ...names.map((name) => `- \`resources/${name}\``),
    RESOURCES_SECTION_END,
  ].join("\n");
}

/**
 * Regenerate the auto-managed "Attached resources" section in a SKILL.md body
 * from the resources/ folder listing. Idempotent: any existing delimited block
 * is replaced (or removed when the folder is empty); the rest of the body is
 * kept as-is.
 */
export function applyResourcesSection(body: string, names: string[]): string {
  const stripped = body.replace(RESOURCES_SECTION_REGEX, "\n").replace(/\s+$/, "");
  if (names.length === 0) {
    return stripped ? `${stripped}\n` : "";
  }
  const section = renderResourcesSection(names);
  return stripped ? `${stripped}\n\n${section}\n` : `${section}\n`;
}

/** Rewrite <skillDir>/SKILL.md so its managed section matches resources/. */
async function syncResourcesSection(skillDir: string): Promise<void> {
  const skillPath = join(skillDir, "SKILL.md");
  if (!(await exists(skillPath))) return;
  const content = await readFile(skillPath, "utf8");
  const names = await listResourceNames(join(skillDir, "resources"));
  // Split the frontmatter off textually so every other key stays byte-for-byte
  // untouched; only the body is regenerated.
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const head = match ? match[0] : "";
  const next = head + applyResourcesSection(content.slice(head.length), names);
  if (next !== content) {
    await writeFile(skillPath, next, "utf8");
  }
}
