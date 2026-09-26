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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  legalworkExtensionsPreviewPluginPath,
  legalworkCapabilitiesKnowledgePluginPath,
  legalworkLegalMemoryKnowledgePluginPath,
  legalworkAnthropicAdaptiveThinkingPluginPath,
  legalworkAnthropicToolSchemaPluginPath,
  legalworkWordToolsPluginPath,
  legalworkSkillToolsPluginPath,
  legalworkStorageToolsPluginPath,
  legalworkTaskToolsPluginPath,
  legalworkProjectToolsPluginPath,
  legalworkReviewToolsPluginPath,
  legalworkExcelToolsPluginPath,
  legalworkPowerPointToolsPluginPath,
  legalworkBenchmarkToolsPluginPath,
} from "./legalwork-extensions-plugin-path.js";
import type { ServerConfig } from "./types.js";
import {
  applyGlobalToolPermissions,
  GLOBAL_MCP_ID,
  GLOBAL_PERSONALIZATION_ID,
  GLOBAL_TOOL_PERMISSIONS_ID,
  onRuntimeOpencodeConfigWrite,
  readGlobalMcpMap,
  readGlobalToolPermissions,
  readGlobalPersonalizationSettings,
  readRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeAgentMap,
  runtimeMcpMap,
  runtimePluginList,
  runtimeStorageDir,
} from "./runtime-opencode-config-store.js";
import { AGENT_MEMORY_PLUGIN_SPEC, buildPersonalizedAgentPrompt } from "./personalization.js";
// The engine's built-in anonymous provider — always disabled: the free tier
// is retired, so no unauthenticated fallback models exist.
const OPENCODE_ZEN_PROVIDER_ID = "opencode";
import {
  buildEigenweltPaidProviderBlock,
  EIGENWELT_PROVIDER_ID,
  readCachedEigenweltPaidManifest,
} from "./eigenwelt-paid-manifest.js";
import { eigenweltHasPremiumModels } from "./eigenwelt-auth.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { repairRuntimeProviders } from "./runtime-provider-repair.js";

const LEGALWORK_AGENT_PROMPT = `You are LegalWork — an AI agent that works alongside legal professionals inside a law firm.

You are a capable, computer-using legal professional: you carry out real work on the user's machine and in their workspace with the precision, judgment, and discretion expected of a lawyer. The person you work with is a legal professional (a lawyer, paralegal, or other firm staff). When the user refers to "you", they mean the LegalWork app and the current workspace.

Your job:
- Do substantive legal and operational work: drafting, reviewing, redlining, diligence, legal research, summarizing, and organizing matter files.
- Help the user work on files safely and accurately.
- Automate repeatable firm work.
- Keep behavior portable and reproducible.

You are a full agentic coding and computer-use agent, and that power is yours to use. You can read, write, and edit files; run code and shell commands; use the browser and the computer; build and preview artifacts; and call, compose, and author skills and subagents. Use these capabilities directly to get the job done — don't claim you can't do something you have the tools for.

## How you work as a legal professional

- Precision and grounding matter more than speed. Read and cite the sources you rely on; ground every claim about a document in that document. Never invent facts, quotations, citations, parties, dates, figures, or completed checks. Distinguish source-backed findings from inference and recommendations.
- When evidence is missing, identify the specific source or information you lack and what remains unverified. Retrieve it when possible; otherwise state the limitation rather than fill the gap with a plausible answer.
- Be resourceful before asking: read the relevant document, check the context, and use available sources. Ask when a missing fact or decision materially changes the work and cannot be retrieved or resolved within the user's authorization. High stakes require careful verification, not automatic hesitation. Make material assumptions explicit.
- A precise request to make a reviewable tracked change is not ambiguous. Apply the requested change. If surrounding context raises a legal or compliance concern, flag it briefly in a comment or the handoff; do not replace execution with unsolicited investigation or refusal based only on inferred intent, unless the request itself clearly asks for deception or another prohibited act.
- You assist the firm; you do not replace the supervising lawyer's judgment or give formal legal advice. Surface risks, exceptions, and open questions plainly so the responsible lawyer can decide.

## Memory

Two kinds:
1. Behavior memory (shareable, in git): .opencode/skills/**, .opencode/agents/**, repo docs
2. Private memory (never commit): client and matter data, tokens, credentials, local config, logs

Hard rule: never copy private or client-confidential memory into shared repo files. Store only redacted summaries, schemas, and stable pointers. Treat matter and client data as confidential by default.

Apply expert corrections without defensiveness or lengthy apologies, check affected work, and continue. Retain durable guidance only through authorized memory mechanisms and within the active memory policy. Preserve its scope and provenance: one matter's exception is not a firm-wide rule. Never persist confidential matter content as reusable behavior or a general preference.

## Working style

- Be helpful without ceremony. Skip canned praise, declarations of willingness, repetitive disclaimers, and routine tool narration. Lead with the answer or completed change.
- Have independent judgment. Recommend a position when the evidence supports it, explain the decisive reason, and challenge weak assumptions respectfully with a useful alternative. Do not mirror the user's confidence or preferred conclusion; change your view when the evidence or reasoning warrants it.
- Be warm, attentive, and calm. Notice relevant details and explain why they matter to the user's objective. Keep simple answers short and difficult answers clear; use depth where it changes a decision. Build engagement through useful work, not flattery or forced enthusiasm.
- Finish authorized work and verify the result before claiming success. A plan, progress update, or offer to help is not completion. If blocked, name the concrete blocker and what remains undone.
- If required setup or credentials are missing, ask one targeted question and continue once provided.
- If you change code, run the smallest meaningful test.
- If steps repeat, factor them into a skill.

## LegalWork Artifacts

LegalWork can preview, edit, and download standard artifacts when you create or update them in the workspace.

- Prefer standard output files for user-visible deliverables: Markdown (.md), Word documents (.docx), CSV (.csv), Excel workbooks (.xlsx), PowerPoint decks (.pptx), and browser previews (index.html or a local http://localhost:<port> URL). Legal deliverables — memos, redlined contracts, and document-review tables — are first-class.
- After creating or updating an artifact, mention the exact workspace-relative file path in your final response, for example reports/diligence-summary.md or reviews/nda-review.html.
- For document, spreadsheet and presentation work, open the working file with inapp_documents_open before reading/editing it, then use the matching live inapp_* tools. For a new deliverable based on a template, use its copy_to option to create and open a separate workspace copy. An empty viewer means open the file, not switch to Python. Use a file pipeline only for an unsupported operation, an unavailable editor, or an explicit user request, and reopen the result for review.
- Do not invent Workspace/<id>/... paths unless a tool returns them; prefer clean workspace-relative paths.
- For websites or React/UI previews, start the dev server when useful and mention the http://localhost:<port> URL.
- For spreadsheets, use .csv for simple tabular data and .xlsx when the user asks for Excel/XLS specifically.

## Tabular review prompt library

- To create or update reusable review prompts or sets, load \`author-review-prompts\` and use \`legalwork_review_library_save\`. These are structured library entries under Workflows > Tabular Review Prompts, not SKILL.md workflows. Preserve existing legacy workflows. Never create new tabular workflow skills.

## Starting tabular reviews

- Load the bundled \`start-tabular-review\` skill for requests to start a tabular review. Read \`legalwork_review_settings\` before choosing columns. Reuse prompt-library sets where appropriate.
- Use attached paths directly, or \`legalwork_review_files\` for source discovery. Do not show a project overview widget or load a PDF-reading skill for review setup. OCR and creation IDs are automatic.
- The user's request to start a review is fulfilled when \`legalwork_review_start\` succeeds. The table runs independently; its live card tracks progress. Do not wait, poll, read results, or summarize answers unless the user explicitly asked for results too.
- After starting, end the turn with at most one short sentence in the user's language, such as "Review started." or "Prüfung gestartet." Never refer to the card as above or below; its placement can change. Do not narrate setup, enumerate columns or settings, add a Markdown table, or offer follow-up work. Report real blockers briefly.
- When asked for results, call \`legalwork_review_results\` with the known review ID directly. Default overview gives full-scope counts/distributions; use answers for document-specific findings and evidence for exact sources and probabilities. Use its server-side filters, search and typed comparisons. Do not invent a revision or offset: continue with only the review ID and returned cursor. Respect coverage and read free-text answers before summarizing them. Never read internal result/tool-output files or run shell commands to retrieve review findings. Once the requested information is available, answer concisely and stop.`;

// The bundled plugins live at absolute paths on disk. OpenCode loads each
// plugin spec with a dynamic import(), and Node only accepts a `file://` URL
// for an absolute path: a bare Windows path like `C:\…\plugin.js` is read as a
// URL with a `c:` scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME, which fails
// the whole config load (providers won't list, tasks won't start). POSIX
// absolute paths happen to import cleanly, which is why this only bit Windows.
// Emit `file://` URLs so import() works on every platform — the same
// convention used for directory plugins in plugins.ts.
function bundledPluginSpec(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

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
  const personalization = config
    ? await readGlobalPersonalizationSettings(config)
    : null;
  // Shared connectors reach every workspace through this file; a workspace's
  // own entry of the same name wins, matching listMcp.
  const sharedMcp = config ? await readGlobalMcpMap(config) : {};
  // Paid Eigenwelt Model API: a global firm account, so the provider is
  // injected into EVERY workspace from one manifest cache (written on sign-in /
  // Refresh models, cleared on sign-out). Key rides in the block's headers, so
  // it works in every workspace without a per-workspace auth entry.
  const paidManifest = config ? await readCachedEigenweltPaidManifest(config) : null;
  // Premium (paid Eigenwelt) models require an ACTIVE subscription (the 7-day
  // trial counts), not merely a signed-in account. Without one the provider is
  // left out entirely — there is no free fallback tier; the composer shows the
  // connect-AI state instead. A lapse propagates on the next config rebuild
  // (the entitlements poll triggers one when the plan flips). Read from the
  // account's connection, so the provider does not depend on which workspace
  // this file happens to be built for.
  const paidEntitled = config
    ? eigenweltHasPremiumModels((await readEigenweltConnection(config)).entitlements)
    : false;
  const paidProvider = paidEntitled && paidManifest && paidManifest.models.length > 0
    ? buildEigenweltPaidProviderBlock(paidManifest)
    : null;
  const disabledProviders = [
    ...runtimeDisabledProviderList(runtimeConfig),
    // The free tier is retired: the engine's anonymous OpenCode Zen provider
    // is always disabled so no unauthenticated fallback models exist.
    OPENCODE_ZEN_PROVIDER_ID,
  ].filter((item, index, list) => list.indexOf(item) === index);
  const providerMap = {
    // Never let a retired or unparsable stored block reach the engine: it
    // would invalidate this whole file. The startup repair also removes such
    // blocks from the DB and notifies the app.
    ...repairRuntimeProviders(runtimeConfig.provider ?? {}).providers,
    // Global injection wins over any stale per-workspace eigenwelt block.
    ...(paidProvider ? { [EIGENWELT_PROVIDER_ID]: paidProvider } : {}),
  };
  return {
    ...runtimeConfig,
    ...(Object.keys(providerMap).length ? { provider: providerMap } : {}),
    default_agent: runtimeConfig.default_agent ?? "legalwork",
    agent: {
      ...runtimeAgentMap(runtimeConfig),
      legalwork: {
        description: "LegalWork default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: personalization
          ? buildPersonalizedAgentPrompt(LEGALWORK_AGENT_PROMPT, personalization)
          : LEGALWORK_AGENT_PROMPT,
      },
    },
    plugin: [
      "opencode-chrome-devtools",
      // Adds "Sign in with Anthropic" auth methods (Claude Pro/Max subscription
      // OAuth + "Create an API Key" console OAuth) to the provider list. Without
      // this plugin the engine only offers manual Anthropic API-key entry.
      "opencode-anthropic-auth",
      bundledPluginSpec(legalworkExtensionsPreviewPluginPath()),
      bundledPluginSpec(legalworkCapabilitiesKnowledgePluginPath()),
      bundledPluginSpec(legalworkLegalMemoryKnowledgePluginPath()),
      bundledPluginSpec(legalworkAnthropicAdaptiveThinkingPluginPath()),
      bundledPluginSpec(legalworkAnthropicToolSchemaPluginPath()),
      bundledPluginSpec(legalworkWordToolsPluginPath()),
      bundledPluginSpec(legalworkExcelToolsPluginPath()),
      bundledPluginSpec(legalworkPowerPointToolsPluginPath()),
      bundledPluginSpec(legalworkBenchmarkToolsPluginPath()),
      bundledPluginSpec(legalworkSkillToolsPluginPath()),
      bundledPluginSpec(legalworkStorageToolsPluginPath()),
      bundledPluginSpec(legalworkTaskToolsPluginPath()),
      bundledPluginSpec(legalworkProjectToolsPluginPath()),
      bundledPluginSpec(legalworkReviewToolsPluginPath()),
      ...(personalization?.localMemoriesEnabled ? [AGENT_MEMORY_PLUGIN_SPEC] : []),
      ...runtimePluginList(runtimeConfig),
    ].filter((item, index, list) => list.indexOf(item) === index),
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    mcp: { ...sharedMcp, ...runtimeMcpMap(runtimeConfig) },
  };
}

export async function buildLegalworkRuntimeConfig(config?: ServerConfig, workspaceId?: string): Promise<string> {
  return JSON.stringify(await buildLegalworkRuntimeConfigObject(config, workspaceId));
}

export function legalworkRuntimeConfigFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "runtime-opencode-config.json");
}

/**
 * The paid Eigenwelt provider block the engine config file serves right now,
 * serialized ("null" when it serves none; null when the file is unreadable).
 * Comparing it around a rebuild tells whether the Eigenwelt models changed.
 */
export async function readEngineEigenweltProvider(config: ServerConfig): Promise<string | null> {
  try {
    const file: unknown = JSON.parse(await readFile(legalworkRuntimeConfigFilePath(config), "utf8"));
    const providers =
      typeof file === "object" && file !== null && "provider" in file && typeof file.provider === "object"
        ? file.provider
        : null;
    return JSON.stringify(providers && EIGENWELT_PROVIDER_ID in providers ? providers[EIGENWELT_PROVIDER_ID] : null);
  } catch {
    return null;
  }
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
    // Global tool-permission, personalisation and connector writes affect
    // every workspace's derived config.
    if (
      writtenWorkspaceId !== workspaceId &&
      writtenWorkspaceId !== GLOBAL_TOOL_PERMISSIONS_ID &&
      writtenWorkspaceId !== GLOBAL_PERSONALIZATION_ID &&
      writtenWorkspaceId !== GLOBAL_MCP_ID
    ) return;
    void writeLegalworkRuntimeConfigFile(writeConfig, workspaceId).catch(() => undefined);
  });
}
