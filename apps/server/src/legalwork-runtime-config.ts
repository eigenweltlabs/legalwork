/**
 * Runtime OpenCode configuration injected via a server-managed config file
 * passed to the engine as OPENCODE_CONFIG.
 *
 * This is the single source of truth for the legalwork agent definition,
 * plugins, and any other config that should be injected at runtime rather
 * than written to the user's own config files. Both cli.ts and embedded.ts
 * use this.
 *
 * The engine re-reads the OPENCODE_CONFIG file from disk on every instance
 * rebuild (e.g. /instance/dispose), so the file is rewritten on every
 * runtime-DB write — unlike the previous OPENCODE_CONFIG_CONTENT env var,
 * which was frozen at spawn and reverted MCP state on each dispose.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  legalworkExtensionsPreviewPluginPath,
  legalworkCapabilitiesKnowledgePluginPath,
  legalworkAnthropicAdaptiveThinkingPluginPath,
  legalworkAnthropicToolSchemaPluginPath,
  legalworkWordToolsPluginPath,
  legalworkExcelToolsPluginPath,
  legalworkPowerPointToolsPluginPath,
} from "./legalwork-extensions-plugin-path.js";
import type { ServerConfig } from "./types.js";
import {
  applyGlobalToolPermissions,
  GLOBAL_TOOL_PERMISSIONS_ID,
  onRuntimeOpencodeConfigWrite,
  readGlobalToolPermissions,
  readRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeAgentMap,
  runtimeMcpMap,
  runtimePluginList,
  runtimeStorageDir,
} from "./runtime-opencode-config-store.js";

const LEGALWORK_AGENT_PROMPT = `You are LegalWork — an AI agent that works alongside legal professionals inside a law firm.

You are a capable, computer-using legal professional: you carry out real work on the user's machine and in their workspace with the precision, judgment, and discretion expected of a lawyer. The person you work with is a legal professional (a lawyer, paralegal, or other firm staff). When the user refers to "you", they mean the LegalWork app and the current workspace.

Your job:
- Do substantive legal and operational work: drafting, reviewing, redlining, diligence, legal research, summarizing, and organizing matter files.
- Help the user work on files safely and accurately.
- Automate repeatable firm work.
- Keep behavior portable and reproducible.

You are a full agentic coding and computer-use agent, and that power is yours to use. You can read, write, and edit files; run code and shell commands; use the browser and the computer; build and preview artifacts; and call, compose, and author skills and subagents. Use these capabilities directly to get the job done — don't claim you can't do something you have the tools for.

## How you work as a legal professional

- Precision and grounding matter more than speed. Ground every claim about a document in that document; quote your sources; never fabricate facts, citations, parties, dates, or figures.
- When something is genuinely ambiguous or high-stakes, flag it and ask rather than guess.
- You assist the firm; you do not replace the supervising lawyer's judgment or give formal legal advice. Surface risks, exceptions, and open questions plainly so the responsible lawyer can decide.

## Memory

Two kinds:
1. Behavior memory (shareable, in git): .opencode/skills/**, .opencode/agents/**, repo docs
2. Private memory (never commit): client and matter data, tokens, credentials, local config, logs

Hard rule: never copy private or client-confidential memory into shared repo files. Store only redacted summaries, schemas, and stable pointers. Treat matter and client data as confidential by default.

## Working style

- If required setup or credentials are missing, ask one targeted question and continue once provided.
- If you change code, run the smallest meaningful test.
- If steps repeat, factor them into a skill.
- Prefer clear, practical steps over abstract explanations.

## LegalWork Artifacts

LegalWork can preview, edit, and download standard artifacts when you create or update them in the workspace.

- Prefer standard output files for user-visible deliverables: Markdown (.md), Word documents (.docx), CSV (.csv), Excel workbooks (.xlsx), PowerPoint decks (.pptx), and browser previews (index.html or a local http://localhost:<port> URL). Legal deliverables — memos, redlined contracts, and document-review tables — are first-class.
- After creating or updating an artifact, mention the exact workspace-relative file path in your final response, for example reports/diligence-summary.md or reviews/nda-review.html.
- Do not invent Workspace/<id>/... paths unless a tool returns them; prefer clean workspace-relative paths.
- For websites or React/UI previews, start the dev server when useful and mention the http://localhost:<port> URL.
- For spreadsheets, use .csv for simple tabular data and .xlsx when the user asks for Excel/XLS specifically.`;

export async function buildLegalworkRuntimeConfigObject(
  config?: ServerConfig,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  // Tool permissions are global (one safety posture across workspaces);
  // the workspace row only contributes external_directory.
  const runtimeConfig = config && workspaceId
    ? applyGlobalToolPermissions(
        await readRuntimeOpencodeConfig(config, workspaceId),
        await readGlobalToolPermissions(config),
      )
    : {};
  const disabledProviders = runtimeDisabledProviderList(runtimeConfig);
  return {
    ...runtimeConfig,
    default_agent: runtimeConfig.default_agent ?? "legalwork",
    agent: {
      ...runtimeAgentMap(runtimeConfig),
      legalwork: {
        description: "LegalWork default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: LEGALWORK_AGENT_PROMPT,
      },
    },
    plugin: [
      "opencode-chrome-devtools",
      legalworkExtensionsPreviewPluginPath(),
      legalworkCapabilitiesKnowledgePluginPath(),
      legalworkAnthropicAdaptiveThinkingPluginPath(),
      legalworkAnthropicToolSchemaPluginPath(),
      legalworkWordToolsPluginPath(),
      legalworkExcelToolsPluginPath(),
      legalworkPowerPointToolsPluginPath(),
      ...runtimePluginList(runtimeConfig),
    ],
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    mcp: runtimeMcpMap(runtimeConfig),
  };
}

export async function buildLegalworkRuntimeConfig(config?: ServerConfig, workspaceId?: string): Promise<string> {
  return JSON.stringify(await buildLegalworkRuntimeConfigObject(config, workspaceId));
}

export function legalworkRuntimeConfigFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "runtime-opencode-config.json");
}

// Serialize file writes per path so a slow older write can never land after
// (and clobber) a newer one. Content is built inside the queued job so each
// job reads the latest runtime-DB state.
const fileWriteQueue = new Map<string, Promise<void>>();

/**
 * Rebuild the engine-visible runtime config file from the runtime DB.
 * Atomic (temp file + rename) so the engine never reads a partial file
 * mid-dispose.
 */
export async function writeLegalworkRuntimeConfigFile(config: ServerConfig, workspaceId: string): Promise<string> {
  const path = legalworkRuntimeConfigFilePath(config);
  const job = async () => {
    const content = await buildLegalworkRuntimeConfig(config, workspaceId);
    await mkdir(runtimeStorageDir(config), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  };
  const previous = fileWriteQueue.get(path) ?? Promise.resolve();
  const next = previous.then(job, job);
  fileWriteQueue.set(path, next);
  await next;
  return path;
}

/**
 * Keep the runtime config file in sync with the runtime DB so every engine
 * instance rebuild reads fresh state instead of a spawn-time snapshot.
 * Returns an unsubscribe function.
 */
export function keepLegalworkRuntimeConfigFileFresh(config: ServerConfig, workspaceId: string): () => void {
  return onRuntimeOpencodeConfigWrite((writeConfig, writtenWorkspaceId) => {
    // Global tool-permission writes affect every workspace's derived config.
    if (writtenWorkspaceId !== workspaceId && writtenWorkspaceId !== GLOBAL_TOOL_PERMISSIONS_ID) return;
    void writeLegalworkRuntimeConfigFile(writeConfig, workspaceId).catch(() => undefined);
  });
}
