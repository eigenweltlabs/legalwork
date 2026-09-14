import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";

import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";
import {
  resolveSkillDecision,
  SKILL_TOOL,
  type BenchmarkSkillPolicy,
} from "../benchmarks/ablation.js";

/**
 * Agent tool for creating a LegalWork benchmark task from chat. Lets the user
 * say "make a benchmark task for X" in any conversation and have it land in the
 * benchmark's Tasks table.
 *
 * Persists via the same authenticated legalwork-server relay the Office tools
 * use (LEGALWORK_SERVER_URL + LEGALWORK_SERVER_TOKEN → POST
 * /workspace/:id/benchmarks/tasks). Mirrors the custom-task schema in
 * apps/server/src/benchmarks/task-schema.ts.
 */

const CREATE_TASK_TIMEOUT_MS = 30_000;
/** Per-file cap for attached input documents (base64 inflates the JSON body). */
const MAX_DOC_BYTES = 20 * 1024 * 1024;

const criterionArg = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Stable criterion id like C-001. Auto-assigned (C-001, C-002, …) if omitted."),
  title: z.string().min(1).max(300).optional().describe("Short criterion title."),
  matchCriteria: z
    .string()
    .min(1)
    .max(8_000)
    .describe("The pass/fail rule, judged independently. Write it as 'PASS if <checkable condition>. FAIL if …'."),
});

const createTaskArgs = z.object({
  title: z.string().min(1).max(300).describe("Short, specific task title."),
  workType: z
    .enum(["analyze", "draft", "review", "research"])
    .describe("The kind of legal work the task asks for."),
  instructions: z
    .string()
    .min(1)
    .max(40_000)
    .describe("Directional instructions to the model, in the second person, naming any expected output file(s)."),
  tags: z
    .array(z.string().min(1).max(120))
    .max(20)
    .optional()
    .describe("Practice-area / vertical tags, e.g. ['Arbitration','ICC Rules']. The first tag is treated as the vertical."),
  deliverables: z
    .array(z.string().min(1).max(200))
    .max(20)
    .optional()
    .describe("Expected output filenames the model must produce, e.g. ['compliance-report.docx']."),
  criteria: z
    .array(criterionArg)
    .min(1)
    .max(100)
    .describe("Rubric of atomic, independently-judged pass/fail criteria."),
  documentPaths: z
    .array(z.string().min(1).max(1024))
    .max(20)
    .optional()
    .describe(
      "Paths to INPUT document files to attach to the task (workspace-relative or absolute), e.g. ['documents/contract.pdf','brief.docx']. Each is read from disk and stored with the task as a source document the model must read. These are inputs — not deliverables (which are the model's OUTPUT filenames). You may write a file first, then pass its path here.",
    ),
});

/** Read the given file paths and base64-encode them for the create payload. */
async function readDocuments(
  paths: string[],
  baseDir: string,
): Promise<{ documents: Array<{ name: string; contentBase64: string }>; errors: string[] }> {
  const documents: Array<{ name: string; contentBase64: string }> = [];
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const absolute = isAbsolute(path) ? path : join(baseDir, path);
      const bytes = await readFile(absolute);
      if (bytes.byteLength === 0) {
        errors.push(`${path}: file is empty`);
        continue;
      }
      if (bytes.byteLength > MAX_DOC_BYTES) {
        errors.push(`${path}: exceeds ${Math.round(MAX_DOC_BYTES / (1024 * 1024))} MB`);
        continue;
      }
      documents.push({ name: basename(path), contentBase64: bytes.toString("base64") });
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { documents, errors };
}

/**
 * Ablation gate for skills and workflows.
 *
 * Skills and workflows both load through the engine's single `skill` tool, so
 * the per-prompt `tools` map can only switch all of them off at once. Naming
 * individual ones has to happen here: every `skill` call in a benchmark session
 * is checked against the arm's policy and rejected if it is switched off.
 *
 * Ordinary (non-benchmark) sessions must pay as little as possible, so a
 * session that resolves to "no arm" is negative-cached and never asked again.
 */
const ABLATION_CACHE_MS = 30_000;
const ABLATION_LOOKUP_TIMEOUT_MS = 4_000;

type SessionAblation = { skills: BenchmarkSkillPolicy } | null;

const ablationCache = new Map<string, { at: number; value: SessionAblation }>();

async function sessionAblation(sessionID: string): Promise<SessionAblation> {
  const cached = ablationCache.get(sessionID);
  if (cached && Date.now() - cached.at < ABLATION_CACHE_MS) return cached.value;

  const url = serverUrl();
  const token = serverToken();
  // Without a server relay there is nothing to enforce; fail open so a
  // misconfigured engine cannot block every skill call in normal chat.
  if (!url || !token) return null;

  let value: SessionAblation = null;
  try {
    const response = await fetch(
      `${url}/benchmarks/session-ablation?session=${encodeURIComponent(sessionID)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(ABLATION_LOOKUP_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      const payload = (await response.json()) as { arm?: { skills?: BenchmarkSkillPolicy } | null };
      value = payload.arm?.skills ? { skills: payload.arm.skills } : null;
    }
  } catch {
    // Fail open: an unreachable server must not break unrelated sessions.
    value = null;
  }
  ablationCache.set(sessionID, { at: Date.now(), value });
  return value;
}

export const LegalWorkBenchmarkTools = async () => ({
  "tool.execute.before": async (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { args: Record<string, unknown> },
  ) => {
    if (input.tool !== SKILL_TOOL) return;
    const sessionID = input.sessionID?.trim();
    if (!sessionID) return;
    const ablation = await sessionAblation(sessionID);
    if (!ablation) return;
    const name = typeof output.args?.name === "string" ? output.args.name : "";
    if (!name) return;
    const decision = resolveSkillDecision(ablation.skills, name);
    // Throwing is how a plugin denies a tool call; the message reaches the model.
    if (!decision.allowed) throw new Error(decision.reason);
  },
  tool: {
    benchmark_create_task: {
      description:
        "Create a task in the LegalWork benchmark's Tasks table. Use when the user wants to create/add a benchmark task, eval, or test case — i.e. define a legal task (instructions + expected deliverables + pass/fail criteria) to compare how connected models perform. Optionally attach input documents by path (documentPaths) — the files the model must read. The task is saved as an editable custom task the user can then run.",
      args: createTaskArgs.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = createTaskArgs.parse(rawArgs);
        const url = serverUrl();
        const token = serverToken();
        if (!url || !token) {
          return JSON.stringify({
            ok: false,
            error: "LegalWork server connection is not configured for this engine.",
          });
        }
        try {
          const workspaceId = await resolveWorkspaceId(context);
          const { documents, errors: documentErrors } = args.documentPaths?.length
            ? await readDocuments(args.documentPaths, context.directory?.trim() || process.cwd())
            : { documents: [], errors: [] };
          const response = await fetch(`${url}/workspace/${encodeURIComponent(workspaceId)}/benchmarks/tasks`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title: args.title,
              workType: args.workType,
              tags: args.tags ?? [],
              instructions: args.instructions,
              deliverables: args.deliverables ?? [],
              criteria: args.criteria,
              ...(documents.length ? { documents } : {}),
            }),
            signal: AbortSignal.timeout(CREATE_TASK_TIMEOUT_MS),
          });
          const text = await response.text();
          if (!response.ok) {
            let message = text;
            try {
              message = (JSON.parse(text) as { message?: string }).message ?? text;
            } catch {
              // keep raw text
            }
            return JSON.stringify({ ok: false, error: `Could not create task (HTTP ${response.status}): ${message}` });
          }
          const item = (JSON.parse(text) as { item?: { id?: string; title?: string; criteriaCount?: number; docCount?: number } })
            .item;
          const docNote = item?.docCount ? ` and ${item.docCount} input document(s)` : "";
          return JSON.stringify(
            {
              ok: true,
              id: item?.id,
              title: item?.title,
              criteriaCount: item?.criteriaCount,
              docCount: item?.docCount ?? 0,
              ...(documentErrors.length ? { documentWarnings: documentErrors } : {}),
              message: `Created benchmark task "${item?.title}" with ${item?.criteriaCount ?? 0} criteria${docNote}. It is now in the benchmark's Tasks tab, where it can be edited or included in a run.`,
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
