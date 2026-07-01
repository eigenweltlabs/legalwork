import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./errors.js";
import { exists } from "./utils.js";
import { projectTemplatesDir } from "./workspace-files.js";

// Firm template library: any file dropped in .opencode/templates/ (md/docx/pdf/txt…).
// Metadata comes from the filename alone — no sidecars, no frontmatter.

export type TemplateItem = {
  name: string;
  path: string;
  size: number;
  updatedAt: number;
};

// A template name is a plain file name — no directories, no dot-prefix, no `..`.
const TEMPLATE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;
const TEXT_TEMPLATE_EXTENSIONS = new Set(["md", "markdown", "txt", "csv"]);

export function validateTemplateName(name: string): void {
  const ok =
    TEMPLATE_NAME_REGEX.test(name) &&
    !name.includes("..") &&
    !name.endsWith(" ") &&
    !name.endsWith(".");
  if (!ok) {
    throw new ApiError(
      400,
      "invalid_template_name",
      "Template name must be a plain file name (letters, numbers, spaces, dots, dashes; no slashes or ..)",
    );
  }
}

export function isTextTemplate(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_TEMPLATE_EXTENSIONS.has(ext);
}

export async function listTemplates(workspaceRoot: string): Promise<TemplateItem[]> {
  const dir = projectTemplatesDir(workspaceRoot);
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: TemplateItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    const info = await stat(path);
    items.push({ name: entry.name, path, size: info.size, updatedAt: info.mtimeMs });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTemplate(
  workspaceRoot: string,
  name: string,
): Promise<{ item: TemplateItem; content: string }> {
  const trimmed = name.trim();
  validateTemplateName(trimmed);
  const path = join(projectTemplatesDir(workspaceRoot), trimmed);
  if (!(await exists(path))) {
    throw new ApiError(404, "template_not_found", `Template not found: ${trimmed}`);
  }
  if (!isTextTemplate(trimmed)) {
    throw new ApiError(415, "template_not_text", "Only text templates (.md, .txt, .csv) can be opened in the editor");
  }
  const info = await stat(path);
  const content = await readFile(path, "utf8");
  return { item: { name: trimmed, path, size: info.size, updatedAt: info.mtimeMs }, content };
}

export type UpsertTemplatePayload = {
  name: string;
  content?: string;
  contentBase64?: string;
};

export async function upsertTemplate(
  workspaceRoot: string,
  payload: UpsertTemplatePayload,
): Promise<{ name: string; path: string; action: "added" | "updated" }> {
  const name = payload.name.trim();
  validateTemplateName(name);
  if (typeof payload.content !== "string" && typeof payload.contentBase64 !== "string") {
    throw new ApiError(400, "invalid_template_content", "Template content is required");
  }
  const dir = projectTemplatesDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const existed = await exists(path);
  if (typeof payload.contentBase64 === "string") {
    await writeFile(path, Buffer.from(payload.contentBase64, "base64"));
  } else {
    await writeFile(path, payload.content ?? "", "utf8");
  }
  return { name, path, action: existed ? "updated" : "added" };
}

export async function deleteTemplate(workspaceRoot: string, name: string): Promise<{ path: string }> {
  const trimmed = name.trim();
  validateTemplateName(trimmed);
  const path = join(projectTemplatesDir(workspaceRoot), trimmed);
  if (!(await exists(path))) {
    throw new ApiError(404, "template_not_found", `Template not found: ${trimmed}`);
  }
  await rm(path, { force: true });
  return { path };
}

// ---------------------------------------------------------------------------
// Skill frontmatter `templates:` support — a skill/workflow can attach library
// templates; the SKILL.md body then carries an auto-managed "Firm templates"
// section so the agent actually reads the files.
// ---------------------------------------------------------------------------

const TEMPLATES_SECTION_START = "<!-- legalwork:templates:start -->";
const TEMPLATES_SECTION_END = "<!-- legalwork:templates:end -->";
const TEMPLATES_SECTION_REGEX =
  /(?:\r?\n)*<!-- legalwork:templates:start -->[\s\S]*?<!-- legalwork:templates:end -->(?:\r?\n)*/g;

/** Normalize the frontmatter `templates` value into a validated, deduped list. */
export function normalizeSkillTemplates(value: unknown): string[] {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name || seen.has(name)) continue;
    validateTemplateName(name);
    seen.add(name);
    names.push(name);
  }
  return names;
}

function renderTemplatesSection(templates: string[]): string {
  return [
    TEMPLATES_SECTION_START,
    "## Firm templates",
    "",
    "This skill uses the firm's own templates and playbooks. Before drafting, read each file below and follow its structure, language, and standards:",
    "",
    ...templates.map((name) => `- \`.opencode/templates/${name}\``),
    TEMPLATES_SECTION_END,
  ].join("\n");
}

/**
 * Regenerate the auto-managed "Firm templates" section in a SKILL.md body from
 * the frontmatter `templates` list. Idempotent: any existing delimited block is
 * replaced (or removed when the list is empty); the rest of the body is kept.
 */
export function applyTemplatesSection(body: string, templates: string[]): string {
  const stripped = body.replace(TEMPLATES_SECTION_REGEX, "\n").replace(/\s+$/, "");
  if (templates.length === 0) {
    return stripped ? `${stripped}\n` : "";
  }
  const section = renderTemplatesSection(templates);
  return stripped ? `${stripped}\n\n${section}\n` : `${section}\n`;
}
