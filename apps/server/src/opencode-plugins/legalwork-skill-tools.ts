import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";

import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";

/**
 * Agent tools for adding skills and workflows to the firm's LegalWork library —
 * the one Settings > Skills and Settings > Workflows list.
 *
 * Hand-writing a SKILL.md with the file tools does NOT put it there: the app
 * lists the shared (global) skills library, not a workspace's .opencode/skills,
 * so a skill written into the working directory stays an invisible file. These
 * tools persist through the same authenticated legalwork-server relay the other
 * LegalWork tools use (LEGALWORK_SERVER_URL + LEGALWORK_SERVER_TOKEN →
 * POST /workspace/:id/skills with scope "global"), which writes into the library
 * the app reads and the engine loads for every workspace.
 */

const REQUEST_TIMEOUT_MS = 30_000;
/** Per-file cap for attached templates (base64 inflates the JSON body). */
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;
// A skill is exposed to the model as a tool, and providers reject tool names
// longer than 64 chars (Anthropic: `^[a-zA-Z0-9_-]{1,64}$`).
const MAX_SKILL_NAME_LENGTH = 64;

const SKILL_TOOLS_INSTRUCTION = `## Creating skills and workflows
When the user asks you to create, save, or "remember" a reusable skill or workflow (a repeatable drafting/review task, a firm playbook, a checklist they want to run again), create it with legalwork_skill_create. That is the only way it lands in the firm's library and shows up in the LegalWork app under Settings > Skills and Settings > Workflows. Writing a SKILL.md yourself with the file tools leaves it as a loose file the app never lists.
Use kind "workflow" for a legal task the user runs on documents (drafting from a template, a review pass); use kind "skill" for knowledge or capability the assistant should pick up automatically. Attach the firm's template with resourcePaths when the task drafts from one. Call legalwork_skill_list first if you need to check what already exists.`;

const createArgs = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Short name describing what this does, e.g. 'NDA review' or 'Antrag Baugenehmigung'. Slugified automatically; for workflows the workflow-<type>- prefix is added for you.",
    ),
  description: z
    .string()
    .min(1)
    .max(1_024)
    .describe(
      "One sentence starting with 'Use when …' that says when to run this. This is what the assistant matches on, so name the documents and phrases that should trigger it.",
    ),
  instructions: z
    .string()
    .min(1)
    .max(80_000)
    .describe(
      "The SKILL.md body in markdown (no frontmatter — it is generated). Open with a '# Title' heading, then write the steps the assistant follows when this runs: what to ask the user for, how to produce the output, and a short 'Before delivering' checklist.",
    ),
  kind: z
    .enum(["skill", "workflow"])
    .optional()
    .describe(
      "'workflow' (shown under Settings > Workflows) for a legal task the user runs on documents; 'skill' (Settings > Skills) for knowledge the assistant loads on its own. Defaults to 'skill'.",
    ),
  workflowType: z
    .enum(["assistant", "tabular"])
    .optional()
    .describe(
      "Workflows only. 'assistant' (default) drafts or reviews a document; 'tabular' extracts fields across many documents into a sourced review grid.",
    ),
  resourcePaths: z
    .array(z.string().min(1).max(1_024))
    .max(20)
    .optional()
    .describe(
      "Paths to firm templates/playbooks to ship inside the skill (workspace-relative or absolute), e.g. ['templates/nda.docx']. Each is copied into the skill's resources/ folder and listed in its 'Attached resources' section.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe("Replace an existing skill of the same name. Defaults to false — an existing name is reported back instead."),
});

const listArgs = z.object({});

type SkillListItem = { name?: unknown; description?: unknown; kind?: unknown; scope?: unknown };

/**
 * Coerce a free-text name into a valid kebab-case slug of at most 64 chars,
 * dropping whole trailing words rather than cutting mid-word (same rule the
 * desktop import uses, so a name behaves identically whichever path created it).
 */
export function fitSkillName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return "";
  if (cleaned.length <= MAX_SKILL_NAME_LENGTH) return cleaned;
  const words = cleaned.split("-");
  let candidate = words[0]!.slice(0, MAX_SKILL_NAME_LENGTH);
  for (let index = 1; index < words.length; index += 1) {
    const next = `${candidate}-${words[index]}`;
    if (next.length > MAX_SKILL_NAME_LENGTH) break;
    candidate = next;
  }
  return candidate.replace(/-+$/g, "");
}

/**
 * Workflows are marked by a `workflow-<type>-` name prefix, not by frontmatter:
 * the app detects them by it, and the engine skips a SKILL.md that carries
 * non-standard frontmatter keys. Mirrors the Workflows view's naming.
 */
export function resolveSkillName(input: { name: string; kind: "skill" | "workflow"; workflowType: "assistant" | "tabular" }): string {
  const slug = fitSkillName(input.name);
  if (!slug) return "";
  if (input.kind !== "workflow") return slug;
  const bare = slug.replace(/^workflow-(?:assistant|tabular)-/, "").replace(/^workflow-/, "");
  return fitSkillName(`workflow-${input.workflowType}-${bare}`);
}

function titleFromName(name: string): string {
  return name
    .replace(/^workflow-(?:assistant|tabular)-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Build the SKILL.md. Frontmatter stays standard (name + description only) so
 * the engine loads it as an ordinary skill; a tabular workflow's body carries
 * the instruction to run through the bundled `tabular-review` skill.
 */
export function buildSkillMarkdown(input: {
  fullName: string;
  description: string;
  instructions: string;
  kind: "skill" | "workflow";
  workflowType: "assistant" | "tabular";
}): string {
  const frontmatter = `---\nname: ${input.fullName}\ndescription: ${JSON.stringify(input.description.trim())}\n---\n`;
  const body = input.instructions.trim();
  if (input.kind !== "workflow" || input.workflowType === "assistant") {
    return `${frontmatter}\n${body}\n`;
  }
  const title = titleFromName(input.fullName);
  return `${frontmatter}\n${[
    `# ${title}`,
    ``,
    "This is a **tabular review workflow**. To run it, load the **`tabular-review`** skill",
    "and build a review grid over the user's documents — one row per document, with a",
    "source citation in every cell — extracting the fields described below.",
    ``,
    `## What to extract`,
    ``,
    body,
    ``,
    `When the user asks to run "${title}", use the \`tabular-review\` skill.`,
  ].join("\n")}\n`;
}

async function requestJson(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ ok: true; payload: unknown } | { ok: false; error: string }> {
  const url = serverUrl();
  const token = serverToken();
  if (!url || !token) {
    return { ok: false, error: "LegalWork server connection is not configured for this engine." };
  }
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && typeof Reflect.get(payload, "message") === "string"
        ? (Reflect.get(payload, "message") as string)
        : text) || `HTTP ${response.status}`;
    return { ok: false, error: message };
  }
  return { ok: true, payload };
}

/** Copy the named files into the skill's resources/ folder, one call each. */
async function attachResources(
  workspaceId: string,
  skillName: string,
  paths: string[],
  baseDir: string,
): Promise<{ attached: string[]; warnings: string[] }> {
  const attached: string[] = [];
  const warnings: string[] = [];
  for (const path of paths) {
    try {
      const absolute = isAbsolute(path) ? path : join(baseDir, path);
      const bytes = await readFile(absolute);
      if (bytes.byteLength === 0) {
        warnings.push(`${path}: file is empty`);
        continue;
      }
      if (bytes.byteLength > MAX_RESOURCE_BYTES) {
        warnings.push(`${path}: exceeds ${Math.round(MAX_RESOURCE_BYTES / (1024 * 1024))} MB`);
        continue;
      }
      const name = basename(path);
      const result = await requestJson(
        `/workspace/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillName)}/resources`,
        { method: "POST", body: { name, contentBase64: bytes.toString("base64") } },
      );
      if (result.ok) attached.push(name);
      else warnings.push(`${path}: ${result.error}`);
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { attached, warnings };
}

export const LegalWorkSkillTools = async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push(SKILL_TOOLS_INSTRUCTION);
  },
  tool: {
    legalwork_skill_create: {
      description:
        "Add a skill or workflow to the firm's LegalWork library so it appears in Settings > Skills / Settings > Workflows and loads in every workspace. Use whenever the user asks to create, save, or reuse a repeatable task — 'make a workflow for this', 'save this as a skill', 'remember how we draft these'. This is the only way a new skill/workflow reaches the app: writing a SKILL.md yourself with the file tools leaves it as a loose file the app never lists.",
      args: createArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = createArgs.parse(rawArgs);
        const kind = args.kind ?? "skill";
        const workflowType = args.workflowType ?? "assistant";
        const fullName = resolveSkillName({ name: args.name, kind, workflowType });
        if (!fullName) {
          return JSON.stringify({ ok: false, error: `"${args.name}" has no usable characters for a skill name.` });
        }
        try {
          const workspaceId = await resolveWorkspaceId(context);
          const existing = await requestJson(
            `/workspace/${encodeURIComponent(workspaceId)}/skills?includeGlobal=true`,
          );
          if (existing.ok && !args.overwrite) {
            const items = (existing.payload as { items?: SkillListItem[] } | null)?.items ?? [];
            if (items.some((item) => item.name === fullName)) {
              return JSON.stringify({
                ok: false,
                name: fullName,
                error: `A ${kind} named "${fullName}" already exists. Pass overwrite: true to replace it, or choose a different name.`,
              });
            }
          }
          const created = await requestJson(`/workspace/${encodeURIComponent(workspaceId)}/skills`, {
            method: "POST",
            body: {
              name: fullName,
              description: args.description.trim(),
              content: buildSkillMarkdown({
                fullName,
                description: args.description,
                instructions: args.instructions,
                kind,
                workflowType,
              }),
              // The library the app lists, not this workspace's .opencode/skills.
              scope: "global",
            },
          });
          if (!created.ok) {
            return JSON.stringify({ ok: false, name: fullName, error: `Could not save the ${kind}: ${created.error}` });
          }
          const { attached, warnings } = args.resourcePaths?.length
            ? await attachResources(workspaceId, fullName, args.resourcePaths, context.directory?.trim() || process.cwd())
            : { attached: [], warnings: [] };
          const where = kind === "workflow" ? "Settings > Workflows" : "Settings > Skills";
          return JSON.stringify(
            {
              ok: true,
              name: fullName,
              kind,
              ...(kind === "workflow" ? { workflowType } : {}),
              path: (created.payload as { path?: string } | null)?.path,
              ...(attached.length ? { attachedResources: attached } : {}),
              ...(warnings.length ? { resourceWarnings: warnings } : {}),
              message: `Saved "${fullName}" to the firm's library. It is listed under ${where} and is available in every workspace. Tell the user where to find it, and that the assistant can run it once they accept the reload the app offers above the conversation.`,
            },
            null,
            2,
          );
        } catch (error) {
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    legalwork_skill_list: {
      description:
        "List the skills and workflows installed in this LegalWork workspace, including the firm's shared library. Use before creating one to avoid duplicating an existing skill or workflow, or when the user asks what skills/workflows they have.",
      args: listArgs.shape,
      async execute(_rawArgs: unknown, context: OpenCodeContext) {
        try {
          const workspaceId = await resolveWorkspaceId(context);
          const result = await requestJson(`/workspace/${encodeURIComponent(workspaceId)}/skills?includeGlobal=true`);
          if (!result.ok) return JSON.stringify({ ok: false, error: result.error });
          const items = (result.payload as { items?: SkillListItem[] } | null)?.items ?? [];
          const entries = items.flatMap((item) =>
            typeof item.name === "string"
              ? [
                  {
                    name: item.name,
                    kind: item.kind === "workflow" || item.name.startsWith("workflow-") ? "workflow" : "skill",
                    description: typeof item.description === "string" ? item.description : "",
                    scope: typeof item.scope === "string" ? item.scope : undefined,
                  },
                ]
              : [],
          );
          return JSON.stringify(
            {
              ok: true,
              skills: entries.filter((entry) => entry.kind === "skill"),
              workflows: entries.filter((entry) => entry.kind === "workflow"),
            },
            null,
            2,
          );
        } catch (error) {
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  },
});
