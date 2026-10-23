import { composedSkill, SkillLessonInputSchema } from "./skill-composition.js";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillItem } from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { ApiError } from "./errors.js";
import { globalSkillsDir, projectSkillsDir } from "./workspace-files.js";
import { BUNDLED_WORKFLOW_NAMES } from "./bundled-workflows.js";

export type SkippedSkill = { path: string; reason: string };

async function findWorkspaceRoots(workspaceRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    roots.push(current);
    const gitPath = join(current, ".git");
    if (await exists(gitPath)) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

const extractTriggerFromBody = (body: string) => {
  const lines = body.split(/\r?\n/);
  let inWhenSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "").trim();
      inWhenSection = /^when to use$/i.test(heading);
      continue;
    }

    if (!inWhenSection) continue;

    const cleaned = trimmed
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();

    if (cleaned) return cleaned;
  }

  return "";
};

export function resolveHubSkillKind(
  skill: SkillItem | undefined,
  requestedKind: "skill" | "workflow",
  ref: string,
): "skill" | "workflow" {
  if (requestedKind === "workflow" || skill?.kind === "workflow" || ref.startsWith("workflow-")) {
    return "workflow";
  }
  return "skill";
}

async function parseSkillEntry(
  skillPath: string,
  entryName: string,
  scope: "project" | "global",
  skipped?: SkippedSkill[],
): Promise<SkillItem | null> {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(await readFile(skillPath, "utf8"));
  } catch (error) {
    console.warn("[skills] Skipped unreadable or malformed skill:", skillPath, error);
    skipped?.push({ path: skillPath, reason: error instanceof Error ? error.message.split("\n")[0]! : "Could not read or parse SKILL.md" });
    return null;
  }
  const { data, body } = parsed;
  const name = typeof data.name === "string" ? data.name : entryName;
  const description = typeof data.description === "string" ? data.description : "";
  // Workflows are user-facing skills. Recognize older corrections without rewriting pinned packages.
  const kind = data.kind === "workflow" || data.workflow_type === "tabular" || name.startsWith("workflow-")
    || await exists(join(dirname(skillPath), "legalwork-extension.json")) ? "workflow" : undefined;
  const workflowType = kind === "workflow" ? "assistant" : undefined;
  const trigger =
    typeof data.trigger === "string"
      ? data.trigger
      : typeof data.when === "string"
        ? data.when
        : extractTriggerFromBody(body);
  try {
    validateSkillName(name);
    validateDescription(description);
  } catch (error) {
    console.warn("[skills] Skipped invalid skill:", skillPath, error instanceof Error ? error.message : error);
    skipped?.push({ path: skillPath, reason: error instanceof Error ? error.message : "Invalid skill metadata" });
    return null;
  }
  return {
    name,
    description,
    path: skillPath,
    scope,
    trigger: trigger.trim() || undefined,
    ...(kind ? { kind } : {}),
    ...(workflowType ? { workflowType } : {}),
  };
}

export async function listSkillsInDir(dir: string, scope: "project" | "global", skipped?: SkippedSkill[]): Promise<SkillItem[]> {
  if (!(await exists(dir))) return [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const items: SkillItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (await exists(skillPath)) {
      // Direct skill: <dir>/<name>/SKILL.md
      const item = await parseSkillEntry(skillPath, entry.name, scope, skipped);
      if (item) items.push(item);
    } else {
      // Domain/category folder: <dir>/<domain>/<name>/SKILL.md – scan one level deeper.
      // This supports the convention where global skills are organised as
      //   skills/<domain>/<skill-name>/SKILL.md
      // in addition to the flat   skills/<skill-name>/SKILL.md  layout.
      const domainDir = join(dir, entry.name);
      let subEntries: Dirent[];
      try {
        subEntries = await readdir(domainDir, { withFileTypes: true });
      } catch (error) {
        console.warn("[skills] Could not read skill folder:", domainDir, error);
        continue;
      }
      for (const subEntry of subEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!subEntry.isDirectory()) continue;
        const subSkillPath = join(domainDir, subEntry.name, "SKILL.md");
        if (!(await exists(subSkillPath))) continue;
        const item = await parseSkillEntry(subSkillPath, subEntry.name, scope, skipped);
        if (item) items.push(item);
      }
    }
  }
  return items;
}

export async function listGlobalSkills(skipped?: SkippedSkill[]): Promise<SkillItem[]> {
  const directories = [globalSkillsDir(), join(homedir(), ".claude", "skills"), join(homedir(), ".agents", "skills"), join(homedir(), ".agent", "skills")];
  const items = (await Promise.all(directories.map(directory => listSkillsInDir(directory, "global", skipped)))).flat();
  const seen = new Set<string>();
  return items.filter(item => { if (seen.has(item.name)) return false; seen.add(item.name); return true; });
}

export async function listSkills(workspaceRoot: string, includeGlobal: boolean, skipped?: SkippedSkill[]): Promise<SkillItem[]> {
  const roots = await findWorkspaceRoots(workspaceRoot);
  // Visible workspace packages travel with a wiki and remain editable in its tree.
  // Only scan this workspace, never another wiki or a parent's visible content.
  const items = await listSkillsInDir(join(workspaceRoot, "Skills"), "project", skipped);
  for (const root of roots) {
    const opencodeDir = join(root, ".opencode", "skills");
    const claudeDir = join(root, ".claude", "skills");
    items.push(...(await listSkillsInDir(opencodeDir, "project", skipped)));
    items.push(...(await listSkillsInDir(claudeDir, "project", skipped)));
  }

  if (includeGlobal) {
    items.push(...await listGlobalSkills(skipped));
  } else {
    // Remote clients also get shipped workflows, without listing the host's
    // other personal workflows or skills.
    for (const name of BUNDLED_WORKFLOW_NAMES) {
      const path = join(globalSkillsDir(), name, "SKILL.md");
      if (!(await exists(path))) continue;
      const item = await parseSkillEntry(path, name, "global", skipped);
      if (item) items.push(item);
    }
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

/**
 * Where a skill/workflow is written.
 *
 * "project" is this workspace's .opencode/skills. "global" is the shared
 * library the desktop Skills and Workflows screens list and the engine loads
 * for every workspace — anything created for the firm (rather than for one
 * repository) belongs there, or it never shows up in the app.
 */
export type SkillScope = "project" | "global";

export function skillsDirForScope(workspaceRoot: string, scope: SkillScope): string {
  return scope === "global" ? globalSkillsDir() : projectSkillsDir(workspaceRoot);
}

export async function skillPathForScope(workspaceRoot: string, scope: SkillScope, name: string): Promise<string> {
  validateSkillName(name);
  const visible = join(workspaceRoot, "Skills", name, "SKILL.md");
  if (scope === "project" && await exists(visible)) return visible;
  return join(skillsDirForScope(workspaceRoot, scope), name, "SKILL.md");
}

export type UpsertSkillPayload = {
  name: string;
  content: string;
  description?: string;
  /** Defaults to "project" so existing callers keep writing into the workspace. */
  scope?: SkillScope;
  lesson?: unknown;
};

export function buildSkillContent(payload: UpsertSkillPayload): { name: string; content: string } {
  const name = payload.name.trim();
  validateSkillName(name);
  if (!payload.content) {
    throw new ApiError(400, "invalid_skill_content", "Skill content is required");
  }

  let content = payload.content;
  const { data, body } = parseFrontmatter(payload.content);
  if (Object.keys(data).length > 0) {
    const frontmatterName = typeof data.name === "string" ? data.name : "";
    const frontmatterDescription = typeof data.description === "string" ? data.description : "";
    if (frontmatterName && frontmatterName !== name) {
      throw new ApiError(400, "invalid_skill_name", "Skill frontmatter name must match payload name");
    }
    validateDescription(frontmatterDescription || payload.description);
    const nextDescription = frontmatterDescription || payload.description || "";
    const frontmatter = buildFrontmatter({
      ...data,
      name,
      description: nextDescription,
    });
    content = frontmatter + body.replace(/^\n/, "");
  } else {
    validateDescription(payload.description);
    const frontmatter = buildFrontmatter({ name, description: payload.description });
    content = frontmatter + payload.content.replace(/^\n/, "");
  }

  return {
    name,
    content: content.endsWith("\n") ? content : content + "\n",
  };
}

export async function upsertSkill(
  workspaceRoot: string,
  payload: UpsertSkillPayload,
): Promise<{ path: string; action: "added" | "updated"; scope: SkillScope }> {
  const lesson = payload.lesson === undefined ? null : SkillLessonInputSchema.parse(payload.lesson);
  const dependency = lesson ? await composedSkill(workspaceRoot, lesson.base, false) : null;
  if (dependency?.chain.some(item => item.name === payload.name)) throw new ApiError(422, "skill_cycle", "A skill cannot extend itself or its descendants.");
  const skill = buildSkillContent(payload);
  const scope: SkillScope = payload.scope === "global" ? "global" : "project";

  const skillPath = await skillPathForScope(workspaceRoot, scope, skill.name);
  const skillDir = dirname(skillPath);
  await mkdir(skillDir, { recursive: true });
  const existed = await exists(skillPath);
  if (lesson && existed) throw new ApiError(409, "skill_exists", "Choose a new name for this correction to preserve the existing skill.");
  if (lesson && dependency) {
    const base = dependency.chain.find(item => item.name === lesson.base)!;
    const pinned = { ...lesson, baseHash: base.hash, createdAt: new Date().toISOString() };
    skill.content += `\n## Extends ${lesson.base}\n\nBefore using this skill, call legalwork_skill_load with name=${lesson.base}. It resolves the base and applicable extensions and checks pinned versions. If the dependency changed, stop and review the correction.\n\n### Applies when\n${lesson.appliesWhen}\n\n### Expert correction\n${lesson.correction}\n\n### Regression examples\n${lesson.examples.map(example => `- Input: ${example.input}\n  Expected: ${example.expected}`).join("\n")}\n`;
    await writeFile(join(skillDir, "legalwork-extension.json"), JSON.stringify(pinned, null, 2) + "\n", { flag: "wx" });
  }
  await writeFile(skillPath, skill.content, "utf8");
  return { path: skillPath, action: existed ? "updated" : "added", scope };
}

export async function deleteSkill(workspaceRoot: string, name: string): Promise<{ path: string }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);
  const flatDir = dirname(await skillPathForScope(workspaceRoot, "project", trimmed));
  if (await exists(join(flatDir, "SKILL.md"))) {
    await rm(flatDir, { recursive: true, force: true });
    return { path: flatDir };
  }
  // Nested layout: skills/<domain>/<name>/SKILL.md (e.g. skills installed by
  // marketplace plugin bundles are namespaced under a plugin folder). Listing
  // supports this layout, so deletion must resolve it the same way.
  const items = await listSkills(workspaceRoot, false);
  const item = items.find((skill) => skill.name === trimmed && skill.scope === "project");
  if (!item) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
  }
  const skillDir = dirname(item.path);
  await rm(skillDir, { recursive: true, force: true });
  return { path: skillDir };
}
