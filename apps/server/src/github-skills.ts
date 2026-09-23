/**
 * Generic GitHub skill-folder import.
 *
 * Scans ANY repo's git tree for every SKILL.md folder and resolves the ones the
 * user picks into ready-to-write skill content (SKILL.md, frontmatter rewritten
 * so the name matches the destination folder). The CLIENT does the actual write
 * so it lands in the right place — the desktop's global skills dir (same path
 * createSkill uses) — rather than a workspace-specific .opencode/skills.
 * Reuses the GitHub URL parser from claude-plugin-bundle.ts.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ApiError } from "./errors.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { projectSkillsDir } from "./workspace-files.js";
import { parseClaudePluginSource, type ClaudePluginSource } from "./claude-plugin-bundle.js";
import { fitSkillName } from "./skill-tool-content.js";

const GH_API = (process.env.LEGALWORK_GITHUB_API_BASE?.trim() || "https://api.github.com").replace(/\/+$/, "");
const GH_RAW = (process.env.LEGALWORK_GITHUB_RAW_BASE?.trim() || "https://raw.githubusercontent.com").replace(/\/+$/, "");

const SKILL_MD_SUFFIX = "/SKILL.md";

export type GithubSkillItem = { dir: string; name: string; description: string };
export type ResolvedGithubSkillFile = { path: string; contentBase64: string; executable: boolean };
export type ResolvedGithubSkill = { name: string; files: ResolvedGithubSkillFile[] };
export type InstallGithubResult = {
  skills: ResolvedGithubSkill[];
  failed: Array<{ path: string; error: string }>;
};

type TreeBlob = { path: string; mode: string };

const enc = (value: string) => encodeURIComponent(value);

function rawUrl(source: ClaudePluginSource, ref: string, path: string): string {
  const segs = path.split("/").map(enc).join("/");
  const refSegs = ref.split("/").map(enc).join("/"); // branch names may contain slashes
  return `${GH_RAW}/${enc(source.owner)}/${enc(source.repo)}/${refSegs}/${segs}`;
}

async function ghJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "legalwork-server" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, "github_fetch_failed", `Failed to read from GitHub (${res.status}): ${text || url}`);
  }
  return res.json();
}

async function ghText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: "text/plain", "User-Agent": "legalwork-server" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, "github_fetch_failed", `Failed to read from GitHub (${res.status}): ${text || url}`);
  }
  return res.text();
}

async function ghBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "legalwork-server" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, "github_fetch_failed", `Failed to read from GitHub (${res.status}): ${text || url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchRepoTree(source: ClaudePluginSource, ref: string): Promise<TreeBlob[]> {
  const tree = await ghJson(`${GH_API}/repos/${enc(source.owner)}/${enc(source.repo)}/git/trees/${enc(ref)}?recursive=1`);
  const entries = Array.isArray(tree?.tree) ? tree.tree : [];
  return entries.flatMap((entry: any) =>
    entry && entry.type === "blob" && typeof entry.path === "string"
      ? [{ path: String(entry.path), mode: typeof entry.mode === "string" ? entry.mode : "100644" }]
      : [],
  );
}

async function resolveDefaultBranch(source: ClaudePluginSource): Promise<string> {
  try {
    const info = await ghJson(`${GH_API}/repos/${enc(source.owner)}/${enc(source.repo)}`);
    if (info && typeof info.default_branch === "string" && info.default_branch.trim()) {
      return info.default_branch.trim();
    }
  } catch {
    // fall through to "main"
  }
  return "main";
}

// Branch names may contain slashes, so a `/tree/<...>` URL is ambiguous between
// ref and subdir. Try progressively longer refs against the trees API and use
// the first that resolves. (Mirrors claude-plugin-bundle's resolveRefAndTree.)
async function resolveRefAndTree(
  source: ClaudePluginSource,
  explicitRef?: string,
): Promise<{ ref: string; dir: string | null; tree: TreeBlob[] }> {
  const candidates: Array<{ ref: string; dir: string | null }> = [];
  if (explicitRef?.trim()) {
    candidates.push({ ref: explicitRef.trim(), dir: source.dir });
  } else if (source.treeSegments && source.treeSegments.length > 0) {
    for (let index = 1; index <= source.treeSegments.length; index += 1) {
      candidates.push({
        ref: source.treeSegments.slice(0, index).join("/"),
        dir: index < source.treeSegments.length ? source.treeSegments.slice(index).join("/") : null,
      });
    }
  } else {
    candidates.push({ ref: await resolveDefaultBranch(source), dir: null });
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const tree = await fetchRepoTree(source, candidate.ref);
      return { ref: candidate.ref, dir: candidate.dir, tree };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new ApiError(404, "github_ref_not_found", "Could not resolve the requested branch or tag.");
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function deriveSkillName(skillDir: string, asWorkflow: boolean): string {
  const folder = skillDir.split("/").filter(Boolean).pop() ?? "";
  const base = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Shorten rather than reject a name over the 200-char cap, dropping whole
  // trailing words like the desktop folder import.
  const name = fitSkillName(asWorkflow ? `workflow-assistant-${base}` : base);
  validateSkillName(name);
  return name;
}

// Some repos ship a SKILL.md without frontmatter, and the engine skips a skill
// with no description, so fall back to the first line of prose in the body
// (the rule the desktop skill list uses, see skill-description.mjs).
function skillDescription(data: Record<string, unknown>, body: string): string {
  if (typeof data.description === "string" && data.description.trim()) return data.description.trim();
  const line = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text && !text.startsWith("#") && text !== "---");
  return (line ?? "").slice(0, 1024);
}

// `kind`/`workflow_type` frontmatter keys make opencode skip a skill, so strip
// them on import; workflow-ness is carried by the `workflow-` folder/name prefix.
function rewriteSkillFrontmatter(md: string, finalName: string): string {
  const { data, body } = parseFrontmatter(md);
  const description = skillDescription(data, body);
  validateDescription(description);
  const { kind: _kind, workflow_type: _workflowType, name: _name, ...rest } = data as Record<string, unknown>;
  const content = buildFrontmatter({ ...rest, name: finalName, description }) +
    "<!-- Modified by LegalWork: skill name and workflow metadata adapted for import. -->\n" + body.replace(/^\n/, "");
  return content.endsWith("\n") ? content : `${content}\n`;
}

export async function scanGithubSkills(input: { url: string; ref?: string }): Promise<{ ref: string; skills: GithubSkillItem[] }> {
  const source = parseClaudePluginSource(input.url);
  const { ref, dir, tree } = await resolveRefAndTree(source, input.ref);
  const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
  const skillMdPaths = tree
    .filter((entry) => entry.path.endsWith(SKILL_MD_SUFFIX) && entry.path.startsWith(prefix))
    .map((entry) => entry.path);
  if (!skillMdPaths.length) return { ref, skills: [] };

  const skills = await mapWithConcurrency(skillMdPaths, 8, async (path): Promise<GithubSkillItem> => {
    const skillDir = path.slice(0, -SKILL_MD_SUFFIX.length);
    const folder = skillDir.split("/").filter(Boolean).pop() ?? skillDir;
    try {
      const md = await ghText(rawUrl(source, ref, path));
      const { data, body } = parseFrontmatter(md);
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : folder;
      const description = skillDescription(data, body).replace(/\s+/g, " ");
      return { dir: skillDir, name, description };
    } catch {
      return { dir: skillDir, name: folder, description: "" };
    }
  });
  return { ref, skills: skills.sort((a, b) => a.dir.localeCompare(b.dir)) };
}

// Downloads EVERY file in each selected skill folder (SKILL.md + supporting files
// like references/, scripts, templates) and returns them as base64. Does NOT write
// to disk — the client writes them to the correct skills location (global on
// desktop, project for remote). SKILL.md frontmatter is rewritten so name == folder.
export async function installGithubSkills(input: {
  url: string;
  ref?: string;
  paths: string[];
  asWorkflow?: boolean;
}): Promise<InstallGithubResult> {
  const source = parseClaudePluginSource(input.url);
  const ref = input.ref?.trim() || (await resolveDefaultBranch(source));
  const tree = await fetchRepoTree(source, ref);

  const skills: ResolvedGithubSkill[] = [];
  const failed: InstallGithubResult["failed"] = [];

  for (const rawDir of input.paths) {
    try {
      const skillDir = rawDir.replace(/^\/+|\/+$/g, "");
      if (!skillDir) {
        failed.push({ path: rawDir, error: "Empty path" });
        continue;
      }
      const skillMdPath = `${skillDir}/SKILL.md`;
      if (!tree.some((entry) => entry.path === skillMdPath)) {
        failed.push({ path: rawDir, error: "No SKILL.md in that folder" });
        continue;
      }
      const finalName = deriveSkillName(skillDir, Boolean(input.asWorkflow));
      const prefix = `${skillDir}/`;
      const blobs = tree.filter((entry) => entry.path.startsWith(prefix));
      const files = await mapWithConcurrency(blobs, 6, async (blob): Promise<ResolvedGithubSkillFile> => {
        const rel = blob.path.slice(prefix.length);
        const executable = blob.mode === "100755";
        if (rel === "SKILL.md") {
          const md = await ghText(rawUrl(source, ref, blob.path));
          return { path: rel, contentBase64: Buffer.from(rewriteSkillFrontmatter(md, finalName), "utf8").toString("base64"), executable: false };
        }
        const buf = await ghBuffer(rawUrl(source, ref, blob.path));
        return { path: rel, contentBase64: buf.toString("base64"), executable };
      });
      skills.push({ name: finalName, files });
    } catch (error) {
      failed.push({ path: rawDir, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { skills, failed };
}

// Rename a project-installed skill to the `workflow-assistant-` prefix. Kept for
// the (project-scoped) remote-workspace path; the desktop global path encodes the
// workflow prefix in the name directly.
export async function promoteSkillToWorkflow(
  workspaceRoot: string,
  skillName: string,
): Promise<{ name: string; path: string; alreadyWorkflow: boolean }> {
  const name = skillName.trim();
  validateSkillName(name);
  const base = projectSkillsDir(workspaceRoot);
  const fromDir = join(base, name);
  if (!(await exists(join(fromDir, "SKILL.md")))) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
  }
  if (name.startsWith("workflow-")) {
    return { name, path: fromDir, alreadyWorkflow: true };
  }
  const toName = fitSkillName(`workflow-assistant-${name}`);
  validateSkillName(toName);
  const toDir = join(base, toName);
  if (await exists(toDir)) {
    throw new ApiError(409, "workflow_exists", `A workflow named ${toName} already exists.`);
  }
  await rename(fromDir, toDir);
  const skillMdPath = join(toDir, "SKILL.md");
  const md = await readFile(skillMdPath, "utf8");
  const { data, body } = parseFrontmatter(md);
  const { kind: _kind, workflow_type: _workflowType, ...rest } = data as Record<string, unknown>;
  const content = buildFrontmatter({ ...rest, name: toName }) + body.replace(/^\n/, "");
  await writeFile(skillMdPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return { name: toName, path: toDir, alreadyWorkflow: false };
}
