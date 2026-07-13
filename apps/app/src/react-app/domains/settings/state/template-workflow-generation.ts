// Template → workflow generation: registers the user's templates folder as a
// real workspace, runs an agent session inside it that stages one assistant
// workflow per template under .legalwork/generated-workflows/, and imports the
// staged folders into the global workflows library when the run completes.
//
// Staging inside the workspace is what keeps the run silent: the agent only
// ever reads and writes its own workspace root, so no external-directory
// permission prompts fire. The privileged move into the shared skills dir is
// done by the app (importSkillsFromFolder IPC), not the agent.
//
// The run is tracked here (persisted to localStorage) so the onboarding step,
// the Workflows view, and the session view all see the same state; the session
// itself is an ordinary session in the templates workspace the user can open
// and watch at any time.
import { useSyncExternalStore } from "react";

import { createClient, unwrap } from "@/app/lib/opencode";
import { toSessionTransportDirectory } from "@/app/lib/session-scope";
import {
  importSkillsFromFolder,
  listLocalSkills,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceSetSelected,
} from "@/app/lib/desktop";
import { buildLegalworkWorkspaceBaseUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { Client, ModelRef } from "@/app/types";

export type TemplateWorkflowRunStatus = "running" | "done" | "error";

export type TemplateWorkflowRun = {
  /** The workspace created at the templates folder — sessions and navigation target. */
  workspaceId: string;
  /** Workspace root == the templates folder. */
  workspaceRoot: string;
  sessionId: string;
  templatesDir: string;
  /** Where the agent stages workflows before the app imports them. */
  stagingDir: string;
  startedAt: number;
  status: TemplateWorkflowRunStatus;
  error?: string;
  /** Import outcome, e.g. "8 workflows added". */
  summary?: string;
  /** The session reported busy at least once — idle after that means finished. */
  seenBusy: boolean;
};

const STORAGE_KEY = "legalwork.templateWorkflowRun";
const STAGING_SUBDIR = ".legalwork/generated-workflows";
// A prompt_async that never turns busy within this window is treated as done
// (covers sends that failed silently or ultra-fast runs the poll missed).
const NEVER_BUSY_GRACE_MS = 60_000;
// Hard cap: past this the run is finalized regardless, so a wedged session
// can't leave the Workflows view spinning forever.
const MAX_RUN_MS = 90 * 60_000;
const POLL_MS = 2_500;
// Server-side skill names are capped at 64 chars (validateSkillName).
const MAX_SKILL_NAME_LENGTH = 64;

// ---------------------------------------------------------------------------
// Run store (module singleton, persisted, React-subscribable)
// ---------------------------------------------------------------------------

let currentRun: TemplateWorkflowRun | null = readPersistedRun();
const listeners = new Set<() => void>();

function readPersistedRun(): TemplateWorkflowRun | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TemplateWorkflowRun;
    if (!parsed || typeof parsed.sessionId !== "string" || !parsed.sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRun(run: TemplateWorkflowRun | null) {
  currentRun = run;
  try {
    if (run) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — in-memory state still drives the UI.
  }
  for (const listener of listeners) listener();
}

function updateRun(patch: Partial<TemplateWorkflowRun>) {
  if (!currentRun) return;
  writeRun({ ...currentRun, ...patch });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTemplateWorkflowRun(): TemplateWorkflowRun | null {
  return currentRun;
}

export function useTemplateWorkflowRun(): TemplateWorkflowRun | null {
  return useSyncExternalStore(subscribe, getTemplateWorkflowRun, getTemplateWorkflowRun);
}

export function dismissTemplateWorkflowRun() {
  stopWatcher();
  writeRun(null);
}

// ---------------------------------------------------------------------------
// Hidden utility workspaces
// ---------------------------------------------------------------------------
// Templates workspaces are plumbing, not something the user manages: they stay
// out of the sidebar, and the generation session is reached only through the
// Workflows progress banner. Ids are persisted so the filter survives reloads
// and dismissed runs.

const HIDDEN_WORKSPACES_KEY = "legalwork.templateWorkspaceIds";

let hiddenWorkspaceIds: string[] = readPersistedHiddenWorkspaceIds();

function readPersistedHiddenWorkspaceIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HIDDEN_WORKSPACES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && !!id) : [];
  } catch {
    return [];
  }
}

function markTemplateWorkspaceHidden(workspaceId: string) {
  if (!workspaceId || hiddenWorkspaceIds.includes(workspaceId)) return;
  hiddenWorkspaceIds = [...hiddenWorkspaceIds, workspaceId];
  try {
    window.localStorage.setItem(HIDDEN_WORKSPACES_KEY, JSON.stringify(hiddenWorkspaceIds));
  } catch {
    // localStorage unavailable — in-memory state still drives the filter.
  }
  for (const listener of listeners) listener();
}

function getHiddenTemplateWorkspaceIds(): string[] {
  return hiddenWorkspaceIds;
}

export function useHiddenTemplateWorkspaceIds(): string[] {
  return useSyncExternalStore(subscribe, getHiddenTemplateWorkspaceIds, getHiddenTemplateWorkspaceIds);
}

// ---------------------------------------------------------------------------
// Agent prompt
// ---------------------------------------------------------------------------

function buildGenerationPrompt(existingWorkflowNames: string[]): string {
  const skipList = existingWorkflowNames.length
    ? existingWorkflowNames.map((name) => `- ${name}`).join("\n")
    : "(none yet)";
  return [
    `Set up reusable drafting workflows for this firm from the templates in this workspace.`,
    ``,
    `This workspace is the firm's templates folder. Stage one workflow per template under \`${STAGING_SUBDIR}/\` (create it). When you are done, LegalWork imports every staged folder into the firm's workflow library automatically — do not try to install them anywhere else yourself.`,
    ``,
    `## 1. Find the templates`,
    `List this workspace recursively. Template documents are files ending in .docx, .doc, .dotx, .odt, .pdf, .md, .rtf, or .txt. Ignore hidden files and folders (names starting with . or ~$), the \`${STAGING_SUBDIR}\` folder itself, and anything that is clearly not a template (READMEs, exports, logs).`,
    ``,
    `## 2. Skip templates that already have a workflow`,
    `These workflows already exist in the firm's library:`,
    skipList,
    `For each template compute its slug: the file name without extension, lowercased, every run of characters outside a-z and 0-9 replaced with a single hyphen, leading/trailing hyphens trimmed. Its workflow folder name is "workflow-assistant-<slug>". The full folder name must be at most ${MAX_SKILL_NAME_LENGTH} characters — if it is longer, shorten the slug by dropping whole words from the end until it fits.`,
    `SKIP any template whose workflow name is already in the list above, or where an existing name clearly covers the same template. Never create a duplicate or a second variant of an existing workflow.`,
    ``,
    `## 3. Create a workflow for each remaining template`,
    `For each template:`,
    `- Read the template and understand it: what document it is, who the parties are, its purpose, the placeholders/blanks to fill, optional clauses, defined terms, and any firm conventions you can observe. If a file cannot be read (e.g. a scanned PDF), still create the workflow from what the file name and context imply, and note that limitation inside it.`,
    `- Create \`${STAGING_SUBDIR}/workflow-assistant-<slug>/resources/\` and copy the template file into it unchanged, keeping its original file name.`,
    `- Write \`${STAGING_SUBDIR}/workflow-assistant-<slug>/SKILL.md\` with EXACTLY this frontmatter shape (only these two keys — any extra frontmatter key stops the engine from loading the workflow):`,
    ``,
    "```",
    `---`,
    `name: workflow-assistant-<slug>`,
    `description: "<one sentence starting with 'Use when', describing when a lawyer runs this workflow>"`,
    `---`,
    "```",
    ``,
    `After the frontmatter, write the workflow body in markdown:`,
    `- A "# <Human Readable Title>" heading.`,
    `- Instructions the agent follows when the workflow runs: always start by copying the attached template from resources/ (never modify the original), ask the user the intake questions the template requires (parties, dates, key terms — derived from the placeholders you found), then fill each placeholder, decide the optional clauses, and keep the firm's defined terms and formatting.`,
    `- A short "Before delivering" checklist (cross-references resolved, no leftover placeholders, dates and party names consistent).`,
    `- End with an "## Attached resources" section listing "resources/<original file name> — the firm's template this workflow drafts from".`,
    ``,
    `## Constraints`,
    `- Work entirely inside this workspace: every file you read or write with your file tools must be under the workspace root. Do not touch /tmp, application-support folders, config directories, or any other outside path — if you need scratch space, use \`${STAGING_SUBDIR}/.scratch/\` and delete it when done.`,
    `- Everything stays local to this machine; do not use the network for this task.`,
    `- Work through every template. When done, report a short summary: workflows staged, templates skipped (already covered), and any failures.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

function joinPath(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative.split("/").join(separator)}`;
}

function workspaceScopedClient(baseUrl: string, token: string, workspaceId: string, workspaceRoot: string): Client {
  const mount = (buildLegalworkWorkspaceBaseUrl(baseUrl, workspaceId) ?? baseUrl).replace(/\/+$/, "");
  return createClient(`${mount}/opencode`, workspaceRoot || undefined, { token, mode: "legalwork" });
}

export type StartTemplateWorkflowGenerationInput = {
  /** Base (environment) LegalWork server client — used to register the workspace. */
  environmentClient: LegalworkServerClient;
  baseUrl: string;
  token: string;
  templatesDir: string;
  model?: ModelRef | null;
};

export async function startTemplateWorkflowGeneration(
  input: StartTemplateWorkflowGenerationInput,
): Promise<{ ok: true; sessionId: string; workspaceId: string } | { ok: false; message: string }> {
  const templatesDir = input.templatesDir.trim();
  if (!templatesDir) {
    return { ok: false, message: "A templates folder is required." };
  }
  if (currentRun?.status === "running") {
    return { ok: false, message: "A workflow generation run is already in progress." };
  }

  try {
    // Workflows the firm already has — injected into the prompt as the skip list,
    // and enforced again at import time (existing names are never overwritten).
    const existingNames = (await listLocalSkills(""))
      .map((skill) => skill.name)
      .filter((name) => name.startsWith("workflow-"));

    // Register the templates folder as a real workspace (same server call the
    // manual "new workspace" flow uses; creating over an existing path reuses
    // it). It is a utility workspace: creation flips the store's selection to
    // it, so remember the user's current workspace and flip back afterwards —
    // the templates workspace stays hidden from the sidebar and is reached
    // only through the Workflows progress banner.
    const previousState = await workspaceBootstrap().catch(() => null);
    const previousSelectedId = previousState ? resolveWorkspaceListSelectedId(previousState) || "" : "";
    const previousIds = new Set((previousState?.workspaces ?? []).map((entry) => entry.id));
    const folderName = templatesDir.split(/[\\/]/).filter(Boolean).pop() || "Templates";
    const list = await input.environmentClient.createLocalWorkspace({
      folderPath: templatesDir,
      name: folderName,
      preset: "starter",
    });
    const workspaces = list.workspaces ?? [];
    const workspaceId =
      resolveWorkspaceListSelectedId(list) ||
      workspaces[workspaces.length - 1]?.id ||
      "";
    const workspace = workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspaceId) {
      return { ok: false, message: "The templates workspace could not be created." };
    }
    const workspaceRoot = workspace?.path?.trim() || templatesDir;
    // Hide only workspaces this run created — if the user pointed at a folder
    // that is already one of their real workspaces, it stays in the sidebar.
    if (!previousIds.has(workspaceId)) {
      markTemplateWorkspaceHidden(workspaceId);
    }
    if (previousSelectedId && previousSelectedId !== workspaceId) {
      await workspaceSetSelected(previousSelectedId).catch(() => undefined);
    }

    const client = workspaceScopedClient(input.baseUrl, input.token, workspaceId, workspaceRoot);
    const directory = toSessionTransportDirectory(workspaceRoot) || undefined;
    const session = unwrap(
      await client.session.create({
        directory,
        title: "Generate workflows from firm templates",
      }),
    );

    const promptResult = await client.session.promptAsync({
      sessionID: session.id,
      directory,
      agent: "legalwork",
      model: input.model ?? undefined,
      parts: [{ type: "text", text: buildGenerationPrompt(existingNames) }],
    });
    if ((promptResult as { error?: unknown }).error !== undefined) {
      const error = (promptResult as { error?: unknown }).error;
      throw new Error(error instanceof Error ? error.message : "The generation task could not be started.");
    }

    writeRun({
      workspaceId,
      workspaceRoot,
      sessionId: session.id,
      templatesDir: workspaceRoot,
      stagingDir: joinPath(workspaceRoot, STAGING_SUBDIR),
      startedAt: Date.now(),
      status: "running",
      seenBusy: false,
    });
    startWatcher(client);
    return { ok: true, sessionId: session.id, workspaceId };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Workflow generation could not be started.",
    };
  }
}

// ---------------------------------------------------------------------------
// Completion watcher (module singleton; safe to call from multiple mounts)
// ---------------------------------------------------------------------------

let watcherTimer: ReturnType<typeof setInterval> | null = null;

function stopWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}

// The agent staged its results inside the workspace; move them into the global
// workflows library. Existing names are skipped, never overwritten.
async function finalizeRun() {
  const run = currentRun;
  if (!run) return;
  try {
    const result = await importSkillsFromFolder(run.stagingDir);
    const parts: string[] = [];
    if (result.imported.length) {
      parts.push(`${result.imported.length} workflow${result.imported.length === 1 ? "" : "s"} added`);
    }
    if (result.skipped.length) parts.push(`${result.skipped.length} already existed`);
    if (result.failed.length) parts.push(`${result.failed.length} failed`);
    updateRun({
      status: result.failed.length && !result.imported.length ? "error" : "done",
      summary: parts.length ? parts.join(", ") : "No new workflows were staged",
      error: result.failed.length
        ? result.failed.map((failure) => `${failure.name}: ${failure.error}`).join("; ")
        : undefined,
    });
  } catch (error) {
    updateRun({
      status: "error",
      error:
        error instanceof Error
          ? `The generated workflows could not be imported: ${error.message}`
          : "The generated workflows could not be imported.",
    });
  }
}

/**
 * Re-attempt just the import step of a failed run (e.g. the staged workflows
 * survived but the import IPC failed). Import is idempotent: existing names
 * are skipped, and a missing staging dir resolves to a clean "nothing staged".
 */
export async function retryTemplateWorkflowImport() {
  if (currentRun?.status !== "error") return;
  await finalizeRun();
}

function startWatcher(client: Client) {
  if (watcherTimer) return;
  if (currentRun?.status !== "running") return;

  watcherTimer = setInterval(() => {
    void (async () => {
      const run = currentRun;
      if (!run || run.status !== "running") {
        stopWatcher();
        return;
      }
      const elapsed = Date.now() - run.startedAt;
      let busy: boolean | null = null;
      try {
        const directory = toSessionTransportDirectory(run.workspaceRoot) || undefined;
        const statuses = unwrap(await client.session.status({ directory }));
        const status = statuses[run.sessionId];
        busy = status !== undefined && status.type !== "idle";
      } catch {
        if (elapsed <= MAX_RUN_MS) return; // transient — keep polling
      }
      if (busy) {
        if (!run.seenBusy) updateRun({ seenBusy: true });
        return;
      }
      if (run.seenBusy || elapsed > NEVER_BUSY_GRACE_MS || elapsed > MAX_RUN_MS) {
        stopWatcher();
        await finalizeRun();
      }
    })();
  }, POLL_MS);
}

/**
 * Resume the completion watcher for a persisted "running" run (after a reload).
 * Builds its own client scoped to the run's workspace; re-calls are no-ops
 * while a watcher is live.
 */
export function ensureTemplateWorkflowWatcher(baseUrl: string, token: string) {
  const run = currentRun;
  if (watcherTimer || !run || run.status !== "running") return;
  if (!baseUrl || !token) return;
  startWatcher(workspaceScopedClient(baseUrl, token, run.workspaceId, run.workspaceRoot));
}
