import { SkillLessonInputSchema } from "../skill-lesson-schema.js";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";

import { buildSkillMarkdown, resolveSkillName } from "../skill-tool-content.js";

import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";

/**
 * Agent tools for the ordinary discoverable skill library. Workflows is the
 * user-facing home for playbooks and corrections; Skills holds supporting capabilities.
 * Both use the same authenticated server API and engine discovery.
 */

const REQUEST_TIMEOUT_MS = 30_000;
/** Per-file cap for attached templates (base64 inflates the JSON body). */
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;

const SKILL_TOOLS_INSTRUCTION = `## Creating skills and workflows
When the user asks you to create, save, or "remember" a reusable skill or workflow (a repeatable drafting/review task, a firm playbook, a correction), save it through legalwork_skill_create so it is installed in the library with the correct scope and metadata.
Exception: tabular-review prompts and sets are structured library entries. Load author-review-prompts and use legalwork_review_library_save for those; never create new tabular workflow skills. Existing tabular workflows remain ordinary workflows.
Workflows are ordinary discoverable skills, not manual-only tasks. Both kinds can be loaded automatically when relevant. Use kind "workflow" for user-facing instructions, playbooks and saved corrections, shown in Workflows; use kind "skill" for supporting capabilities, shown in Settings > Integrations > Skills. Attach the firm's template with resourcePaths when the task drafts from one. Call legalwork_skill_list first if you need to check what already exists.`;

const createArgs = z.object({
  lesson: SkillLessonInputSchema.optional().describe("For a lawyer-approved reusable correction, extend an installed skill or workflow. Saved in Workflows and automatically composed with the base. Supply precise scope and positive and negative regression examples. A code defect also needs an executable fix and tests; prose cannot fix code."),
  scope: z.enum(["project", "global"]).default("global").describe("Project for a matter-specific correction; global for a reusable correction in this user library."),
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
      "The SKILL.md body in markdown (frontmatter is generated). Open with a '# Title' heading, then write the steps the assistant follows: what facts it needs, how to produce the output, and a short 'Before delivering' checklist.",
    ),
  kind: z
    .enum(["skill", "workflow"])
    .optional()
    .describe(
      "'workflow' for user-facing instructions, playbooks and corrections in Workflows; 'skill' for supporting capabilities in Settings > Integrations > Skills. Both are automatically discoverable. Lessons always use 'workflow'; otherwise defaults to 'skill'.",
    ),
  workflowType: z
    .literal("assistant")
    .optional()
    .describe(
      "Workflows only. Ordinary workflows use assistant. For tabular-review prompts or sets, load author-review-prompts and use legalwork_review_library_save instead.",
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
    output.system.push(SKILL_TOOLS_INSTRUCTION + "\nBefore calculating legal deadlines, use legalwork_skill_load to read the jurisdiction skill AND its expert corrections. When a lawyer corrects you, distinguish an extracted fact, a matter-specific exception, a reusable rule, and a code defect. Propose the exact correction and project/global scope. On an explicit request to remember/save it, call legalwork_skill_create with kind=workflow, lesson={base, appliesWhen, correction, examples}, and a new descriptive name. The correction appears in Workflows and loads automatically with its base. Preserve the base. Include both the corrected case and a nearby case whose correct behavior must not change. Never claim these examples are executed tests. Reload the composed skill before retrying, including in a new session.");
  },
  tool: {
    legalwork_skill_load: {
      description: "Read an installed skill or workflow together with its scoped expert corrections. Both are automatically discoverable. Resolves dependencies and refuses changed base versions. Always load a deadline skill through this tool before calculating.",
      args: { name: z.string().min(1) },
      async execute(raw: unknown, context: OpenCodeContext) {
        const { name } = z.object({ name: z.string().min(1) }).parse(raw);
        const workspace = await resolveWorkspaceId(context);
        return JSON.stringify(await requestJson(`/workspace/${encodeURIComponent(workspace)}/skills/${encodeURIComponent(name)}/composed`));
      },
    },
    legalwork_skill_create: {
      description:
        "Save reusable instructions through the ordinary skill library. User-facing playbooks and corrections appear in Workflows; supporting capabilities appear in Settings > Integrations > Skills. Both are automatically discoverable within their project/global scope. Use when the user asks to create, save or remember instructions. For tabular-review prompts and sets, use the author-review-prompts skill and legalwork_review_library_save instead.",
      args: createArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = createArgs.parse(rawArgs);
        const kind = args.lesson ? "workflow" : args.kind ?? "skill";
        const workflowType = args.workflowType ?? "assistant";
        let fullName = resolveSkillName({ name: args.name, kind, workflowType });
        if (!fullName) {
          return JSON.stringify({ ok: false, error: `"${args.name}" has no usable characters for a skill name.` });
        }
        try {
          const workspaceId = await resolveWorkspaceId(context);
          const existing = await requestJson(
            `/workspace/${encodeURIComponent(workspaceId)}/skills?includeGlobal=true`,
          );
          const items = existing.ok ? (existing.payload as { items?: SkillListItem[] } | null)?.items ?? [] : [];
          const original = items.find(item => item.name === args.name);
          // Existing workflow IDs remain stable even after their type is retired.
          if (kind === "workflow" && original && (args.name.startsWith("workflow-") || original.kind === "workflow")) fullName = args.name;
          if (existing.ok && !args.overwrite) {
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
              scope: args.scope,
              lesson: args.lesson,
            },
          });
          if (!created.ok) {
            return JSON.stringify({ ok: false, name: fullName, error: `Could not save the ${kind}: ${created.error}` });
          }
          const { attached, warnings } = args.resourcePaths?.length
            ? await attachResources(workspaceId, fullName, args.resourcePaths, context.directory?.trim() || process.cwd())
            : { attached: [], warnings: [] };
          const where = kind === "workflow" ? "Workflows" : "Settings > Integrations > Skills";
          return JSON.stringify(
            {
              ok: true,
              name: fullName,
              kind,
              ...(kind === "workflow" ? { workflowType } : {}),
              path: (created.payload as { path?: string } | null)?.path,
              ...(attached.length ? { attachedResources: attached } : {}),
              ...(warnings.length ? { resourceWarnings: warnings } : {}),
              scope: args.scope,
              ...(args.lesson ? { extends: args.lesson.base } : {}),
              message: args.lesson
                ? `Saved "${fullName}" in Workflows as a ${args.scope}-scoped extension of ${args.lesson.base}. It loads automatically with its base. Call legalwork_skill_load to resolve it immediately, including in a fresh session. The saved examples are expectations, not executed tests.`
                : args.scope === "project" ? `Saved "${fullName}" for this project under ${where}. Accept the offered reload to refresh the skill list.`
                : `Saved "${fullName}" to the user's library under ${where}. Accept the offered reload to refresh the skill list.`,
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
