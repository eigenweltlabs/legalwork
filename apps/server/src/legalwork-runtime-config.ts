import { readChannelProvider } from "./channel-model.js";
import { legalworkAssistantToolsPluginPath } from "./legalwork-extensions-plugin-path.js";
import { PROJECT_TASK_AGENT, ALL_PROJECTS_TASK_AGENT, projectTaskPermissions, allProjectTaskPermissions } from "./scheduled-tasks/access.js";
import { readSystemOneSettings } from "./systemone.js";
import { nativeOpencodeConfig } from "./native-opencode-config.js";
import { engineStorageDir } from "./engine-storage.js";
import { runtimeDbPath } from "./runtime-db.js";
import { embeddedNativePluginBundle } from "./native-plugin-assets.js";
import { resolveCapabilityLibrary } from "./capability-library.js";
import { managedSettingsFileSchema, type ManagedSettingsFile } from "./managed-engine-settings.js";
import { legalworkPluginPath } from "./legalwork-extensions-plugin-path.js";
import { archiveNativeProjectProjection, nativeEngineProjectRegistryPath, writeNativeEngineProjectRegistry, writeNativeProjectProjection } from "./engine-project.js";
import { approvedNativePluginIdentities, approveNativePluginTargets, managedNativePluginTargets, nativePluginIdentity } from "./native-project-plugins.js";
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
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeGeneratedConfigFile } from "./generated-config-file.js";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { listGlobalSkills, listSkills } from "./skills.js";
import { commonManagedConfiguration } from "./managed-config-sources.js";
import { prepareManagedGlobalLibrary } from "./managed-global-library.js";
import { managedCoreLibraryRoot, managedCoreConfiguration, prepareManagedCoreLibrary } from "./managed-core-library.js";
import { createHash, randomUUID } from "node:crypto";
import {
  legalworkExtensionsPreviewPluginPath,
  legalworkSandboxPluginPath,
  legalworkCapabilitiesKnowledgePluginPath,
  legalworkLegalMemoryKnowledgePluginPath,
  legalworkAnthropicAdaptiveThinkingPluginPath,
  legalworkAnthropicToolSchemaPluginPath,
  legalworkOpenAIToolCallIdsPluginPath,
  legalworkWordToolsPluginPath,
  legalworkSkillToolsPluginPath,
  legalworkStorageToolsPluginPath,
  legalworkTaskToolsPluginPath,
  legalworkCalendarToolsPluginPath,
  legalworkDraftToolsPluginPath,
  legalworkScheduledTaskToolsPluginPath,
  legalworkProjectToolsPluginPath,
  legalworkToolOutputPluginPath,
  legalworkReviewToolsPluginPath,
  legalworkWikiToolsPluginPath,
  legalworkExcelToolsPluginPath,
  legalworkPowerPointToolsPluginPath,
  legalworkBenchmarkToolsPluginPath,
  legalworkOrgPolicyGuardPluginPath,
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
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { buildPersonalizedAgentPrompt, withFirmInstructions } from "./personalization.js";
import { buildOrgPolicyEngineLayer, orgPolicyPermissions, writeOrgPolicyEngineLayer } from "./org-policy-engine.js";
import { appliedOrgPolicy } from "./org-policy.js";
import { orgChatEngineIds } from "./org-policy-ai.js";
import { allowedMemberConnectors } from "./org-policy-items.js";
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
import { nativeHostExecutionActions } from "./agent-sandbox/engine-policy.js";
import { REVIEW_AGENT, reviewAgentConfig } from "./reviews/agent.js";

const LEGALWORK_AGENT_PROMPT = `You are LegalWork — an AI agent that works alongside legal professionals inside a law firm.

You are a capable, computer-using legal professional: you carry out real work on the user's machine and in their workspace with the precision, judgment, and discretion expected of a lawyer. The person you work with is a legal professional (a lawyer, paralegal, or other firm staff). When the user refers to "you", they mean the LegalWork app and the current workspace.

Your job:
- Do substantive legal and operational work: drafting, reviewing, redlining, diligence, legal research, summarizing, and organizing matter files.
- Help the user work on files safely and accurately.
- Automate repeatable firm work.
- Keep behavior portable and reproducible.

You are a fully capable computer-use agent for legal and operational work. You can read, write, and edit files; run code and shell commands; use the browser and the computer; build and preview artifacts; and call, compose, and author skills and subagents. Use these capabilities directly to get the job done — don't claim you can't do something you have the tools for.

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
- A denied permission blocks that action or scope, not the whole conversation. Respect the denial: do not retry it through another tool, request the same access again, or bypass it. Continue any remaining work within the authorized project scope, or briefly explain the specific limitation if the answer requires the denied access.
- If you change code, run the smallest meaningful test.
- If steps repeat, factor them into a skill.

## Project-local working files

- Never use system temporary folders for agent work: no /tmp, /private/tmp, /var/tmp, macOS /var/folders, or the system TMPDIR. Do not create, read, search, or request access to scratch files there.
- Keep all agent-created intermediate files inside the current project, in .legalwork/scratch/<task-specific-directory>. Use a distinct directory for each task to avoid collisions. If a command needs a temporary directory, explicitly point it at that project-local directory.
- Keep shell commands rooted at the project. Use project-relative paths from that root, or an explicit workdir when needed; avoid combining cd with parent-relative (../) paths, which can be interpreted as access outside the project. Never request a parent folder merely to create project-local scratch files.
- Prefer streaming extracted text directly from the source to the next operation without writing an intermediate file. For PDF text, pdftotext can write to stdout using - as its output argument.
- When JEV returns matching filenames, answer from those results unless the user needs exact source wording. Any follow-up extraction must follow these same project-local rules.

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

## Quick questions about a document corpus

- A question such as "Which contracts in this folder contain a change-of-control provision?" is semantic file search, not a request to create or look up a tabular review. When available, call \`legalwork_jev_corpus_question\` directly with that folder and a per-document question. Do not first look up review settings, review lists, prompt sets or extension actions.
- Use the exact user-named subfolder, not the entire project. Folder paths are traversed automatically: up to 1,000 files run in ONE job. Do not enumerate files, generate lists with shell commands, or split into arbitrary 250/500-file batches. If the folder is unknown, inspect its parent once and stop browsing as soon as it is found. A corpus_scope error returns folder paths to help correct scope; only split if the requested folder itself exceeds 1,000 files.
- The same question is applied independently to EACH document: ask "Does this document contain X?", not "Which files contain X?" Classification also concerns one document and takes explicit answer options. Filter compact results, then open relevant files only. Extraction and OCR happen inside the tool; do not read the corpus into your context first. Unclear, errors and unsupported sources never mean No. This tool does not create a saved review.
- Only call tools exposed in the current session. If Jev Search is unavailable, say so briefly and use available project-local tools where practical. Do not turn a search question into a saved review or try hidden tool names.

## Starting tabular reviews
- Load the bundled \`start-tabular-review\` skill for requests to start a tabular review. Read \`legalwork_review_settings\` before choosing columns. Reuse prompt-library sets where appropriate.
- Use attached paths directly, or \`legalwork_review_files\` for source discovery. Do not show a project overview widget or load a PDF-reading skill for review setup. OCR and creation IDs are automatic.
- The user's request to start a review is fulfilled when \`legalwork_review_start\` succeeds. The table runs independently; its live card tracks progress. Do not wait, poll, read results, or summarize answers unless the user explicitly asked for results too.
- After starting, end the turn with at most one short sentence in the user's language, such as "Review started." or "Prüfung gestartet." Never refer to the card as above or below; its placement can change. Do not narrate setup, enumerate columns or settings, add a Markdown table, or offer follow-up work. Report real blockers briefly.
- When asked for results, call \`legalwork_review_results\` with the known review ID directly. Default overview gives full-scope counts/distributions; use answers for document-specific findings and evidence for exact sources and probabilities. Use its server-side filters, search and typed comparisons. Do not invent a revision or offset: continue with only the review ID and returned cursor. Respect coverage and read free-text answers before summarizing them. Never read internal result/tool-output files or run shell commands to retrieve review findings. Once the requested information is available, answer concisely and stop.`;

// Native configured plugins are directories. The released host resolves their
// entrypoints and supplies its own plugin/effect runtime on every platform.
async function bundledPluginSpec(absolutePath: string, config?: ServerConfig): Promise<string> {
  if (config && absolutePath.endsWith(".js")) {
    // Bundled plugins are standalone. Give changed code a new physical path:
    // the engine can retain imported modules across workspace disposal, even
    // when the file URL's query changes. Never relocate unbundled TS sources.
    const content = await readFile(absolutePath).catch(error => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const embedded = embeddedNativePluginBundle(basename(dirname(absolutePath)));
      if (embedded === undefined) throw error;
      return Buffer.from(embedded);
    });
    const hash = createHash("sha256").update(content).digest("hex");
    const directory = join(runtimeStorageDir(config), "bundled-plugins", hash);
    const destination = join(directory, basename(absolutePath));
    await mkdir(directory, { recursive: true });
    const existing = await readFile(destination).catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!existing.equals(content)) throw new Error("An immutable LegalWork plugin bundle was changed outside the application.");
      return dirname(destination);
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      try { await link(temporary, destination); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (!(await readFile(destination)).equals(content)) throw new Error("An immutable LegalWork plugin bundle was changed outside the application.");
      }
    } finally { await rm(temporary, { force: true }); }
    return dirname(destination);
  }
  return dirname(absolutePath);
}

// Tool permissions are global (one safety posture across workspaces);
// the workspace row only contributes external_directory.
async function memberRuntimeConfig(config?: ServerConfig, workspaceId?: string): Promise<RuntimeOpencodeConfig> {
  return config && workspaceId
    ? applyGlobalToolPermissions(
        await readRuntimeOpencodeConfig(config, workspaceId),
        await readGlobalToolPermissions(config),
      )
    : {};
}

export async function buildLegalworkRuntimeSettings(
  config?: ServerConfig,
  workspaceId?: string,
) {
  const runtimeConfig = await memberRuntimeConfig(config, workspaceId);
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
  const jevSettings = config ? await readSystemOneSettings(config).catch(() => null) : null;
  const jevSearchEnabled = process.env.LEGALWORK_DISABLE_JEV_SEARCH !== "1" && !!jevSettings?.providers.some(provider => provider.status === "ready" && provider.id === jevSettings.selection.providerId
    && provider.models.some(model => model.id === jevSettings.selection.model && model.questionTypes.includes("noul") && model.questionTypes.includes("choice")));
  // The firm's providers stay on, whatever the member disconnected.
  const firmProviderIds = config ? await orgChatEngineIds(config) : [];
  const disabledProviders = [
    ...runtimeDisabledProviderList(runtimeConfig).filter((id) => !firmProviderIds.includes(id)),
    // The free tier is retired: the engine's anonymous OpenCode Zen provider
    // is always disabled so no unauthenticated fallback models exist.
    OPENCODE_ZEN_PROVIDER_ID,
  ].filter((item, index, list) => list.indexOf(item) === index);
  const storedProviders = repairRuntimeProviders(runtimeConfig.provider ?? {}).providers;
  // An account manifest is authoritative even when empty (unfunded Sync or
  // all models disabled). Never resurrect a stale per-workspace paid model.
  if (paidManifest) delete storedProviders[EIGENWELT_PROVIDER_ID];
  const providerMap = {
    ...(await readChannelProvider()),
    // Never let a retired or unparsable stored block reach the engine: it
    // would invalidate this whole file. The startup repair also removes such
    // blocks from the DB and notifies the app.
    ...storedProviders,
    // Global injection wins over any stale per-workspace eigenwelt block.
    ...(paidProvider ? { [EIGENWELT_PROVIDER_ID]: paidProvider } : {}),
  };
  // The firm's tool permissions apply over the member's own.
  const { permission } = config
    ? await orgPolicyPermissions(config, { ...runtimeConfig.permission })
    : { permission: { ...runtimeConfig.permission } };
  const instructionPermission = permission.legalwork_project_set_instructions === "deny" ? "deny" : "ask";
  // Append the specific rule after wildcard rules; approvals cannot be saved
  // for this tool, so every proposed instructions change is reviewed.
  delete permission.legalwork_project_set_instructions;
  // The firm's instructions too, for every agent the member works with (scheduled runs included).
  const agentPrompt = withFirmInstructions(
    personalization ? buildPersonalizedAgentPrompt(LEGALWORK_AGENT_PROMPT, personalization) : LEGALWORK_AGENT_PROMPT,
    config ? (await appliedOrgPolicy(config, "personalization.firmInstructions"))?.value : undefined,
  );
  const workspace = config?.workspaces.find((item) => item.id === workspaceId);
  const result = {
    ...runtimeConfig,
    // Enable bounded output reads in the native explore agent, whose default
    // denies unknown tools. User and firm rules follow and keep precedence.
    permission: { ...(!Object.hasOwn(permission, "legalwork_tool_output_read") ? { legalwork_tool_output_read: "allow" } : {}),
      ...permission, legalwork_project_set_instructions: instructionPermission },
    // A refusal remains a tool error visible to the model. The engine should
    // continue within the user's boundaries instead of silently ending the turn.
    experimental: { continue_loop_on_deny: true },
    tools: { legalwork_jev_corpus_question: jevSearchEnabled },
    skills: { paths: workspace ? (config?.engineConfigurationMode === "managed" ? await listGlobalSkills() : await listSkills(workspace.path, true)).map((skill) => dirname(skill.path)) : [] },
    provider: providerMap,
    default_agent: runtimeConfig.default_agent,
    agent: {
      ...runtimeAgentMap(runtimeConfig),
      [REVIEW_AGENT]: reviewAgentConfig(),
      [PROJECT_TASK_AGENT]: {
        description: "Scheduled task with access to this project only", mode: "primary", hidden: true,
        prompt: agentPrompt + "\nThis scheduled run may access its own project through the project-scoped tools. Use legalwork_project_list/read, project calendar and review tools. The recording tools legalwork_recordings_list and legalwork_recording_read also include unassigned global recordings; other projects' recordings are unavailable. Shell, browser, delegation and unrestricted connectors are unavailable. Do not work around a scope denial or request broader project access during the run. Explain any missing capability. Existing chat history remains visible.",
        permission: projectTaskPermissions(permission),
      },
      [ALL_PROJECTS_TASK_AGENT]: {
        description: "Scheduled task with access to all authorized local projects", mode: "primary", hidden: true,
        prompt: agentPrompt + "\nThis scheduled run may access all authorized local projects. Use legalwork_schedule_projects and legalwork_schedule_project_list/read to find and read project data. Use legalwork_recordings_list and legalwork_recording_read for recordings across those projects and unassigned global recordings. Read chat transcripts directly using kind=sessions and exact chat IDs. Do not open chats or navigate the LegalWork UI to retrieve data. If direct reads are unavailable, report that limitation. Existing tool permissions and approvals still apply.",
        permission: allProjectTaskPermissions(permission),
      },
      legalwork: {
        description: "LegalWork default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: agentPrompt,
      },
    },
    plugin: (await Promise.all([
      bundledPluginSpec(legalworkExtensionsPreviewPluginPath(), config),
      bundledPluginSpec(legalworkCapabilitiesKnowledgePluginPath(), config),
      bundledPluginSpec(legalworkLegalMemoryKnowledgePluginPath(), config),
      bundledPluginSpec(legalworkAnthropicAdaptiveThinkingPluginPath(), config),
      bundledPluginSpec(legalworkAnthropicToolSchemaPluginPath(), config),
      bundledPluginSpec(legalworkOpenAIToolCallIdsPluginPath(), config),
      bundledPluginSpec(legalworkWordToolsPluginPath(), config),
      bundledPluginSpec(legalworkExcelToolsPluginPath(), config),
      bundledPluginSpec(legalworkPowerPointToolsPluginPath(), config),
      bundledPluginSpec(legalworkBenchmarkToolsPluginPath(), config),
      bundledPluginSpec(legalworkSkillToolsPluginPath(), config),
      bundledPluginSpec(legalworkStorageToolsPluginPath(), config),
      bundledPluginSpec(legalworkTaskToolsPluginPath(), config),
      bundledPluginSpec(legalworkCalendarToolsPluginPath(), config),
      bundledPluginSpec(legalworkDraftToolsPluginPath(), config),
      bundledPluginSpec(legalworkScheduledTaskToolsPluginPath(), config),
      bundledPluginSpec(legalworkAssistantToolsPluginPath(), config),
      bundledPluginSpec(legalworkProjectToolsPluginPath(), config),
      bundledPluginSpec(legalworkToolOutputPluginPath(), config),
      bundledPluginSpec(legalworkReviewToolsPluginPath(), config),
      bundledPluginSpec(legalworkWikiToolsPluginPath(), config),
      bundledPluginSpec(legalworkOrgPolicyGuardPluginPath(), config),
      // The member's own plugins, unless the firm allows none.
      ...(config && (await appliedOrgPolicy(config, "plugins.allowCustom"))?.value === false ? [] : runtimePluginList(runtimeConfig)),
      ...(config?.agentSandboxEnabled ? [bundledPluginSpec(legalworkSandboxPluginPath(), config)] : []),
    ])).filter((item, index, list) => list.indexOf(item) === index),
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    mcp: config
      ? await allowedMemberConnectors(config, { ...sharedMcp, ...runtimeMcpMap(runtimeConfig) })
      : { ...sharedMcp, ...runtimeMcpMap(runtimeConfig) },
  };
  const { config: normalized, ...native } = nativeOpencodeConfig(result);
  const core = config?.engineConfigurationMode === "managed" ? managedCoreConfiguration() : undefined;
  const configuration = core ? { ...normalized, agents: { ...core.config.agents, ...normalized.agents }, commands: { ...core.config.commands, ...normalized.commands } } : normalized;
  native.agentRequests = { ...core?.agentRequests, ...native.agentRequests };
  const firmFilters = config ? nativeOpencodeConfig(await buildOrgPolicyEngineLayer(config, { permission: { ...runtimeConfig.permission } })).modelFilters : {};
  // A member selection may narrow the firm's catalog, never expand it. These
  // legacy filters also guard explicit requests, not only catalog display.
  for (const [id, firm] of Object.entries(firmFilters)) {
    const member = native.modelFilters[id];
    native.modelFilters[id] = {
      allow: firm.allow === undefined ? member?.allow
        : member?.allow === undefined ? firm.allow : firm.allow.filter(model => member.allow?.includes(model)),
      deny: [...new Set([...firm.deny ?? [], ...member?.deny ?? []])],
    };
  }
  const library = workspace ? await resolveCapabilityLibrary(workspace.path, config?.engineConfigurationMode === "managed", config?.engineConfigurationMode === "managed" ? managedCoreLibraryRoot(config) : undefined) : { nativeSkills: [] };
  const providerActivation = { ...runtimeConfig.providerActivation };
  // The firm's own providers remain enabled, as before the migration.
  for (const id of firmProviderIds) delete providerActivation[id];
  const filteredProviders = Object.fromEntries(Object.entries(configuration.providers ?? {}).map(([id, provider]) => {
    const filter = native.modelFilters[id];
    if (!filter || !provider.models) return [id, provider];
    return [id, { ...provider, models: Object.fromEntries(Object.entries(provider.models).map(([modelID, model]) => [modelID,
      filter.allow && !filter.allow.includes(modelID) || filter.deny?.includes(modelID) ? { ...model, disabled: true } : model])) }];
  }));
  return { configuration: { ...configuration, providers: filteredProviders,
    policies: [...configuration.policies ?? [], ...Object.entries(providerActivation).map(([resource, effect]) => ({ action: "provider.use", resource, effect }))] },
    ...native, providerActivation, skills: library.nativeSkills };
}

export async function buildLegalworkRuntimeConfigObject(config?: ServerConfig, workspaceId?: string): Promise<Record<string, unknown>> {
  return { ...(await buildLegalworkRuntimeSettings(config, workspaceId)).configuration };
}

/** The firm's enforced engine layer, against the member's own settings of `workspaceId`. */
export async function buildOrgPolicyEngineLayerFor(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  const own = await memberRuntimeConfig(config, workspaceId);
  const layer = nativeOpencodeConfig(await buildOrgPolicyEngineLayer(config, { permission: { ...own.permission } })).config;
  const targets = async (path: string) => {
    let value: unknown;
    try { value = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (!value || typeof value !== "object" || !("plugins" in value) || !Array.isArray(value.plugins)) return [];
    return value.plugins.flatMap(plugin => typeof plugin === "string" ? plugin.startsWith("-") ? [] : [plugin]
      : plugin && typeof plugin === "object" && "package" in plugin && typeof plugin.package === "string" ? [plugin.package] : []);
  };
  // Both the writer and the guard's repair path must preserve this complete
  // pre-import policy. Repairing only firm tool rules would remove the plugin
  // approvals and deactivate mandatory integrations on the next config load.
  const [common, mandatory, approved] = await Promise.all([
    targets(legalworkRuntimeConfigFilePath(config)), targets(mandatoryRuntimeConfigFilePath(config)),
    config.engineConfigurationMode === "managed" || (await appliedOrgPolicy(config, "plugins.allowCustom"))?.value === false ? [] : approvedNativePluginIdentities(config),
  ]);
  return { ...layer, policies: [
    { action: "integration.use", resource: "plugin:*", effect: "deny" },
    ...[...new Set([...common, ...mandatory, ...approved].map(nativePluginIdentity))].map(target => ({ action: "integration.use", resource: `plugin:${target}`, effect: "allow" })),
    ...(config.agentSandboxEnabled ? nativeHostExecutionActions.map(action => ({ action: "tool.use", resource: `${action}:*`, effect: "deny" })) : []),
    ...layer.policies ?? [],
  ] };
}

export async function buildLegalworkRuntimeConfig(config?: ServerConfig, workspaceId?: string): Promise<string> {
  return JSON.stringify(await buildLegalworkRuntimeConfigObject(config, workspaceId));
}

export function legalworkRuntimeConfigFilePath(config: ServerConfig): string {
  return join(engineStorageDir(config), "runtime-opencode-config.json");
}

export function mandatoryRuntimeConfigFilePath(config: ServerConfig): string {
  return join(engineStorageDir(config), "runtime-opencode-mandatory.json");
}

export async function legalworkMandatoryRuntimeConfigContent(config: ServerConfig): Promise<string> {
  return readFile(mandatoryRuntimeConfigFilePath(config), "utf8");
}

export function managedEngineSettingsFilePath(config: ServerConfig): string {
  return join(engineStorageDir(config), "runtime-opencode-settings.json");
}

/**
 * The paid Eigenwelt provider block the engine config file serves right now,
 * serialized ("null" when it serves none; null when the file is unreadable).
 * Comparing it around a rebuild tells whether the Eigenwelt models changed.
 */
export async function readEngineEigenweltProvider(config: ServerConfig): Promise<string | null> {
  try {
    const file = managedSettingsFileSchema.parse(JSON.parse(await readFile(managedEngineSettingsFilePath(config), "utf8")));
    return JSON.stringify(Object.fromEntries(Object.entries(file.workspaces).sort(([left], [right]) => left.localeCompare(right)).map(([id, entry]) => {
      const configuration = nativeOpencodeConfig(entry.configuration && typeof entry.configuration === "object" && !Array.isArray(entry.configuration) ? Object.fromEntries(Object.entries(entry.configuration)) : {}).config;
      return [id, configuration.providers?.[EIGENWELT_PROVIDER_ID] ?? null];
    })));
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
    await mkdir(engineStorageDir(config), { recursive: true });
    const workspaces: ManagedSettingsFile["workspaces"] = {};
    const commonPlugins = new Set<string>();
    const managed = config.engineConfigurationMode === "managed";
    if (managed) await prepareManagedCoreLibrary(config);
    const library = managed ? await prepareManagedGlobalLibrary(config) : { plugins: [] };
    const sharedPlugins = (await appliedOrgPolicy(config, "plugins.allowCustom"))?.value === false ? [] : library.plugins ?? [];
    for (const directory of config.managedEnginePluginDirectories ?? []) {
      commonPlugins.add(await bundledPluginSpec(join(directory, "index.js"), config));
    }
    for (const workspace of config.workspaces) {
      const settings = await buildLegalworkRuntimeSettings(config, workspace.id);
      workspaces[workspace.id] = { ...settings, directory: workspace.directory?.trim() || workspace.path };
      // Only application bundles belong in the common engine bootstrap.
      // User-owned project plugins are still discovered by the released host.
      for (const plugin of settings.configuration.plugins ?? []) {
        if (typeof plugin === "string" && dirname(plugin) === join(runtimeStorageDir(config), "bundled-plugins")) commonPlugins.add(plugin);
      }
    }
    const settingsPath = managedEngineSettingsFilePath(config);
    const configurations = Object.values(workspaces).map(entry => nativeOpencodeConfig(entry.configuration && typeof entry.configuration === "object" && !Array.isArray(entry.configuration) ? Object.fromEntries(Object.entries(entry.configuration)) : {}).config);
    const sharedConfiguration = managed ? commonManagedConfiguration(configurations) : {};
    await writeGeneratedConfigFile(settingsPath, JSON.stringify({ version: 1, workspaces, sharedConfiguration }));
    const mandatoryPlugins = [
      { package: await bundledPluginSpec(legalworkPluginPath("legalwork-project-admission"), config), options: { registryPath: nativeEngineProjectRegistryPath(config), protectedHostExecution: config.agentSandboxEnabled === true } },
      await bundledPluginSpec(legalworkPluginPath("legalwork-product-scope"), config),
      await bundledPluginSpec(legalworkPluginPath("legalwork-digest-tools"), config),
      await bundledPluginSpec(legalworkPluginPath("legalwork-history-image-tools"), config),
      await bundledPluginSpec(legalworkPluginPath("legalwork-tool-image-original-capture"), config),
      await bundledPluginSpec(legalworkPluginPath("legalwork-tool-image-originals"), config),
      { package: await bundledPluginSpec(legalworkPluginPath("legalwork-managed-config"), config), options: { settingsPath, managedConfiguration: managed } },
      { package: await bundledPluginSpec(legalworkPluginPath("legalwork-commands"), config), options: { settingsPath } },
      await bundledPluginSpec(legalworkOrgPolicyGuardPluginPath(), config),
      ...(config.agentSandboxEnabled ? [await bundledPluginSpec(legalworkSandboxPluginPath(), config)] : []),
      // Observe the final permission effect so a denied native MCP call has
      // an accurate human-facing status without changing its authorization.
      { package: await bundledPluginSpec(legalworkPluginPath("legalwork-legalmemory"), config), options: { settingsPath } },
    ];
    // Existing explicit library selections are already person-managed. Newly
    // discovered project executables still require the separate review action.
    const selected = Object.values(workspaces).flatMap(entry => entry.configuration && typeof entry.configuration === "object" && "plugins" in entry.configuration && Array.isArray(entry.configuration.plugins)
      ? entry.configuration.plugins.flatMap(plugin => typeof plugin === "string" && !commonPlugins.has(plugin) ? [plugin] : []) : []);
    if (!managed) await approveNativePluginTargets(config, await managedNativePluginTargets(config, selected));
    if (managed) for (const workspace of config.workspaces) await archiveNativeProjectProjection(config, workspace);
    for (const workspace of managed ? [] : config.workspaces) {
      const settings = workspaces[workspace.id];
      if (!settings) continue;
      const configuration = nativeOpencodeConfig(settings.configuration && typeof settings.configuration === "object" && !Array.isArray(settings.configuration) ? Object.fromEntries(Object.entries(settings.configuration)) : {}).config;
      const projectConfiguration = { ...configuration, plugins: (configuration.plugins ?? []).filter(plugin => typeof plugin !== "string" || !commonPlugins.has(plugin)) };
      try { await writeNativeProjectProjection(config, workspace, projectConfiguration); }
      catch (error) {
        // A project conflict holds only that project's agent. Its authored files
        // and the server remain available for the actionable approval screen.
        if (!(error instanceof Error && "code" in error && error.code === "project_engine_configuration_conflict")) throw error;
      }
    }
    await writeNativeEngineProjectRegistry(config);
    const content = JSON.stringify({ ...sharedConfiguration, $schema: "https://opencode.ai/config.json", update: "disable",
      ...(!managed || configurations.every(configuration => configuration.default_agent === undefined) ? { default_agent: "legalwork" } : {}),
      experimental: { ...sharedConfiguration.experimental, todo: true }, plugins: [...sharedPlugins, ...commonPlugins] });
    await writeGeneratedConfigFile(path, content);
    // The final process-owned directives restore mandatory guards even when a
    // trusted authored document removes plugins. Only the unsafe native command
    // expansion loader is replaced; native MCP discovery and execution remain.
    await writeGeneratedConfigFile(mandatoryRuntimeConfigFilePath(config), JSON.stringify({ plugins: [...mandatoryPlugins, "-opencode.config.command"] }));
    await writeOrgPolicyEngineLayer(config, await buildOrgPolicyEngineLayerFor(config, workspaceId));
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
export function keepLegalworkRuntimeConfigFileFresh(config: ServerConfig, workspaceId: string): () => Promise<void> {
  const database = runtimeDbPath(config);
  let pending = Promise.resolve();
  const unsubscribe = onRuntimeOpencodeConfigWrite((writeConfig, writtenWorkspaceId) => {
    if (runtimeDbPath(writeConfig) !== database || runtimeDbPath(config) !== database) return;
    // Global tool-permission, personalisation and connector writes affect
    // every workspace's derived config.
    if (!config.workspaces.some(workspace => workspace.id === writtenWorkspaceId)
      && ![GLOBAL_TOOL_PERMISSIONS_ID, GLOBAL_PERSONALIZATION_ID, GLOBAL_MCP_ID].includes(writtenWorkspaceId)) return;
    // Each engine owns its generated files and process policy even when two
    // LegalWork instances observe the same shared settings database.
    pending = writeLegalworkRuntimeConfigFile(config, workspaceId).then(() => undefined, () => undefined);
  });
  return async () => { unsubscribe(); await pending; };
}
