import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LEGALMEMORY_EXPORT_DIR, safeExportFilename } from "./legalmemory-export.js";
import {
  engineAccessToken,
  fetchLegalMemoryDocument,
  fetchLegalMemoryGraph,
  fetchLegalMemoryMatters,
  fetchLegalMemoryTreeChildren,
  fetchLegalMemoryTreeRoots,
  fetchLegalMemoryTreeSearch,
  resolveLegalMemoryServer,
} from "./legalmemory-fetch.js";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor, ReloadReason, ReloadTrigger, TokenScope } from "./types.js";
import { ApprovalService } from "./approvals.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { sanitizePortableOpencodeConfig } from "./portable-opencode.js";
import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";
import { deleteSkill, listSkills, resolveHubSkillKind, upsertSkill } from "./skills.js";
import {
  deleteSkillResource,
  listSkillResources,
  readSkillResource,
  resolveSkillDir,
  upsertSkillResource,
  validateResourceName,
} from "./skill-resources.js";
import { installHubSkill, listHubSkills } from "./skill-hub.js";
import { scanGithubSkills, installGithubSkills, promoteSkillToWorkflow } from "./github-skills.js";
import { deleteCommand, listCommands, repairCommands, upsertCommand } from "./commands.js";
import { ApiError, formatError } from "./errors.js";
import { readJsoncFile, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import { recordAudit, readAuditEntries, readLastAudit } from "./audit.js";
import { ReloadEventStore } from "./events.js";
import { computeReloadFingerprint } from "./reload-fingerprint.js";
import { startReloadWatchers } from "./reload-watcher.js";
import { globalSkillsDir, opencodeConfigPath, legalworkConfigPath, projectCommandsDir, projectPluginsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { ensureWorkspaceFiles, readRawOpencodeConfig } from "./workspace-init.js";
import { sanitizeCommandName, validateMcpConfig, validateMcpName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { EnvService } from "./env-file.js";
import { installCloudPlugin, readCloudPluginResolved, readInstalledCloudPlugins, removeCloudPlugin } from "./cloud-plugins.js";
import { resolveClaudePluginBundle } from "./claude-plugin-bundle.js";
import {
  applyMaterializedBlueprintSessions,
  normalizeBlueprintSessionTemplates,
  readMaterializedBlueprintSessions,
  sanitizeLegalworkTemplateConfig,
} from "./blueprint-sessions.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { seedOpencodeSessionMessages } from "./opencode-db.js";
import { listPortableFiles } from "./portable-files.js";
import {
  buildWorkspaceImportPreview,
  normalizeWorkspaceImportPayload,
  publicWorkspaceImportPreview,
  summarizeWorkspaceImportApplied,
  summarizeWorkspaceImportPreview,
  type WorkspaceImportPlan,
  workspaceImportPreviewApprovalPaths,
} from "./workspace-import-preview.js";
import {
  collectWorkspaceExportWarnings,
  stripSensitiveWorkspaceExportData,
  type WorkspaceExportSensitiveMode,
} from "./workspace-export-safety.js";
import { serve, type ServeResult } from "./serve-node.js";
import { launchAnalyticsId } from "./launch-analytics-id.js";
import { handleWordAddinRequest, loadWordAddinTls, setAnalyticsConsent, WORD_ADDIN_PATH_PREFIX } from "./word-addin.js";
import { OfficeToolRelay } from "./office-tools.js";
import { registerOfficeToolRoutes } from "./routes/office-tools.js";
import { BenchmarkRunner, type BenchmarkOpencodeClient } from "./benchmarks/runner.js";
import { openBenchmarkStore } from "./benchmarks/store.js";
import { registerBenchmarkRoutes } from "./routes/benchmarks.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { addRoute, matchRoute, type AuthMode, type RequestContext, type Route } from "./routes/registry.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import {
  applyGlobalToolPermissions,
  GLOBAL_PERSONALIZATION_ID,
  GLOBAL_TOOL_PERMISSIONS_ID,
  isPersonality,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  mergeOpencodeConfigs,
  mergeRuntimeProviderPatch,
  readGlobalPersonalizationSettings,
  readGlobalToolPermissions,
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  type RuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { deleteAllLocalMemories } from "./personalization.js";
import {
  mergeLegalworkWorkspaceConfigs,
  readLegalworkWorkspaceConfig,
  writeLegalworkWorkspaceConfig,
} from "./legalwork-workspace-config-store.js";
import {
  buildLegalworkRuntimeConfigObject,
  writeLegalworkRuntimeConfigFile,
} from "./legalwork-runtime-config.js";
import {
  eigenweltHasPremiumModels,
  fetchEigenweltManifest,
  parseEigenweltAccountIdentity,
  parseEigenweltEntitlements,
  startEigenweltSignIn,
  validateEigenweltPlatformUrl,
  waitForEigenweltSignIn,
} from "./eigenwelt-auth.js";
import {
  clearCachedEigenweltPaidManifest,
  parseManifestModels,
  refreshEigenweltPaidManifest,
  writeCachedEigenweltPaidManifest,
} from "./eigenwelt-paid-manifest.js";
import {
  readEigenweltConnection,
  readEigenweltEntitlementsView,
  writeEigenweltConnection,
} from "./eigenwelt-connection-store.js";
import {
  ensureFreshPlatformToken,
  readFreshEntitlementsView,
  revokeEigenweltConnection,
} from "./eigenwelt-refresh.js";
import {
  buildIntegrationPayload,
  hubCreate,
  hubDelete,
  hubGet,
  hubGetSecret,
  hubList,
  hubListAll,
  installFolderFiles,
  installWorkflowFiles,
  parseIntegrationPayload,
  parsePluginPayload,
  requireHubClient,
  serializeLocalFolder,
  serializeWorkflowSkill,
  EIGENWELT_HUB_MAX_BATCH_ITEMS,
  EIGENWELT_HUB_MAX_PAYLOAD_BYTES,
  EIGENWELT_HUB_MAX_SECRET_BYTES,
  type EigenweltHubKind,
} from "./eigenwelt-hub.js";
import { sanitizePresetFragment } from "./hub-sanitize.js";
import {
  forgetHubInstall,
  readHubInstalls,
  recordHubInstall,
} from "./eigenwelt-hub-installs-store.js";
import pkg from "../package.json" with { type: "json" };
import constants from "../../../constants.json" with { type: "json" };

export {
  isSupportedWorkspaceTextFilePath,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceArtifactTargets,
} from "./routes/files.js";

const SERVER_VERSION = pkg.version;
const OPENCODE_VERSION = constants.opencodeVersion.trim().replace(/^v/, "");

const LEGALWORK_VOICE_REALTIME_MODEL = "gpt-realtime-2";
const LEGALWORK_VOICE_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

const LEGALWORK_VOICE_REALTIME_TOOLS = [
  {
    type: "function",
    name: "legalwork_snapshot",
    description: "Read the current LegalWork UI control snapshot: route, status, narration, and visible action metadata.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "legalwork_list_actions",
    description: "List semantic LegalWork UI actions. Call this before legalwork_execute_action when you do not know the exact action id.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "legalwork_execute_action",
    description: "Execute a semantic LegalWork UI action by id. Prefer this over screen coordinates or DOM guessing.",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "The action id from legalwork_list_actions, such as composer.set_text or composer.send." },
        args: { type: "object", description: "Optional JSON arguments for the action.", additionalProperties: true },
      },
      required: ["actionId"],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function parsePersonalizationPayload(value: unknown) {
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_personalization", "Personalisation settings are required");
  }
  if (typeof value.customInstructions !== "string") {
    throw new ApiError(400, "invalid_personalization", "customInstructions must be a string");
  }
  if (value.customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
    throw new ApiError(
      400,
      "invalid_personalization",
      `customInstructions must be ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters or fewer`,
    );
  }
  if (typeof value.localMemoriesEnabled !== "boolean") {
    throw new ApiError(400, "invalid_personalization", "localMemoriesEnabled must be a boolean");
  }
  if (typeof value.allowToolAssistedMemory !== "boolean") {
    throw new ApiError(400, "invalid_personalization", "allowToolAssistedMemory must be a boolean");
  }
  if (!isPersonality(value.personality)) {
    throw new ApiError(400, "invalid_personalization", "personality is not supported");
  }
  return {
    customInstructions: value.customInstructions,
    localMemoriesEnabled: value.localMemoriesEnabled,
    allowToolAssistedMemory: value.allowToolAssistedMemory,
    personality: value.personality,
  };
}

function recordRecordMap(value: unknown): Record<string, Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) entries[key] = item;
  }
  return Object.keys(entries).length ? entries : null;
}

const LEGACY_RUNTIME_CONFIG_KEYS = ["plugin", "mcp", "permission", "provider", "agent"] as const;
const USER_OPENCODE_RUNTIME_CONFIG_KEYS = ["default_agent", "plugin", "mcp", "disabled_providers", "provider", "agent"] as const;

type LegacyRuntimeConfigKey = typeof LEGACY_RUNTIME_CONFIG_KEYS[number];
type UserOpencodeRuntimeConfigKey = typeof USER_OPENCODE_RUNTIME_CONFIG_KEYS[number];

function legacyRuntimeConfigFromLegalworkConfig(legalwork: Record<string, unknown>): {
  config: RuntimeOpencodeConfig;
  keys: LegacyRuntimeConfigKey[];
} {
  const keys: LegacyRuntimeConfigKey[] = [];
  const plugin = Array.isArray(legalwork.plugin) ? legalwork.plugin.filter((item) => typeof item === "string") : [];
  const mcp: Record<string, Record<string, unknown>> = {};
  if (isRecord(legalwork.mcp)) {
    for (const [name, value] of Object.entries(legalwork.mcp)) {
      if (isRecord(value)) mcp[name] = value;
    }
  }
  const permission = isRecord(legalwork.permission) ? legalwork.permission : null;
  const externalDirectory = permission && isRecord(permission.external_directory) ? permission.external_directory : null;
  const provider = isRecord(legalwork.provider) ? legalwork.provider : null;
  const agent = recordRecordMap(legalwork.agent);

  if (plugin.length) keys.push("plugin");
  if (Object.keys(mcp).length) keys.push("mcp");
  if (externalDirectory && Object.keys(externalDirectory).length) keys.push("permission");
  if (provider && Object.keys(provider).length) keys.push("provider");
  if (agent && Object.keys(agent).length) keys.push("agent");

  return {
    keys,
    config: {
      ...(plugin.length ? { plugin } : {}),
      ...(Object.keys(mcp).length ? { mcp } : {}),
      ...(externalDirectory ? { permission: { external_directory: externalDirectory } } : {}),
      ...(provider ? { provider } : {}),
      ...(agent ? { agent } : {}),
    },
  };
}

function removeLegacyRuntimeConfig(legalwork: Record<string, unknown>): Record<string, unknown> {
  const next = { ...legalwork };
  for (const key of LEGACY_RUNTIME_CONFIG_KEYS) {
    delete next[key];
  }
  return next;
}

function userRuntimeConfigFromOpencodeConfig(opencode: Record<string, unknown>): {
  config: RuntimeOpencodeConfig;
  keys: UserOpencodeRuntimeConfigKey[];
} {
  const keys: UserOpencodeRuntimeConfigKey[] = [];
  const defaultAgent = opencode.default_agent === "legalwork" ? "legalwork" : undefined;
  const plugin = Array.isArray(opencode.plugin) ? opencode.plugin.filter((item) => typeof item === "string") : undefined;
  const mcp: Record<string, Record<string, unknown>> = {};
  if (isRecord(opencode.mcp)) {
    for (const [name, value] of Object.entries(opencode.mcp)) {
      if (isRecord(value)) mcp[name] = value;
    }
  }
  const disabledProviders = Array.isArray(opencode.disabled_providers)
    ? opencode.disabled_providers.filter((item) => typeof item === "string")
    : undefined;
  const provider = isRecord(opencode.provider) ? opencode.provider : undefined;
  const agent = recordRecordMap(opencode.agent) ?? undefined;

  if (defaultAgent) keys.push("default_agent");
  if (Array.isArray(opencode.plugin)) keys.push("plugin");
  if (Object.keys(mcp).length) keys.push("mcp");
  if (Array.isArray(opencode.disabled_providers)) keys.push("disabled_providers");
  if (isRecord(opencode.provider)) keys.push("provider");
  if (isRecord(opencode.agent)) keys.push("agent");

  return {
    keys,
    config: {
      ...(defaultAgent ? { default_agent: defaultAgent } : {}),
      ...(plugin?.length ? { plugin } : {}),
      ...(Object.keys(mcp).length ? { mcp } : {}),
      ...(disabledProviders?.length ? { disabled_providers: disabledProviders } : {}),
      ...(provider && Object.keys(provider).length ? { provider } : {}),
      ...(agent && Object.keys(agent).length ? { agent } : {}),
    },
  };
}

async function removeUserRuntimeConfigFromOpencode(workspaceRoot: string, keys: UserOpencodeRuntimeConfigKey[]): Promise<void> {
  if (!keys.length) return;
  const updates = Object.fromEntries(keys.map((key) => [key, undefined]));
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), updates);
}

function runtimeConfigKeys(config: RuntimeOpencodeConfig): string[] {
  const keys: string[] = [];
  if (config.default_agent) keys.push("default_agent");
  if (Array.isArray(config.plugin) && config.plugin.length) keys.push("plugin");
  if (Array.isArray(config.disabled_providers) && config.disabled_providers.length) keys.push("disabled_providers");
  if (isRecord(config.mcp) && Object.keys(config.mcp).length) keys.push("mcp");
  const permission = isRecord(config.permission) ? config.permission : null;
  if (permission && isRecord(permission.external_directory) && Object.keys(permission.external_directory).length) {
    keys.push("permission");
  }
  if (isRecord(config.provider) && Object.keys(config.provider).length) keys.push("provider");
  if (isRecord(config.agent) && Object.keys(config.agent).length) keys.push("agent");
  return keys;
}

function userOpencodeConfigKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((key) => key !== "$schema").sort();
}

function mergeLegacyRuntimeConfig(
  current: RuntimeOpencodeConfig,
  legacy: RuntimeOpencodeConfig,
): RuntimeOpencodeConfig {
  const currentPermission = isRecord(current.permission) ? current.permission : {};
  const legacyPermission = isRecord(legacy.permission) ? legacy.permission : {};
  const currentExternalDirectory = isRecord(currentPermission.external_directory) ? currentPermission.external_directory : {};
  const legacyExternalDirectory = isRecord(legacyPermission.external_directory) ? legacyPermission.external_directory : {};
  return {
    default_agent: current.default_agent ?? legacy.default_agent,
    plugin: [
      ...(Array.isArray(current.plugin) ? current.plugin.filter((item) => typeof item === "string") : []),
      ...(Array.isArray(legacy.plugin) ? legacy.plugin.filter((item) => typeof item === "string") : []),
    ].filter((item, index, list) => list.indexOf(item) === index),
    disabled_providers: [
      ...(Array.isArray(current.disabled_providers) ? current.disabled_providers.filter((item) => typeof item === "string") : []),
      ...(Array.isArray(legacy.disabled_providers) ? legacy.disabled_providers.filter((item) => typeof item === "string") : []),
    ].filter((item, index, list) => list.indexOf(item) === index),
    mcp: {
      ...(isRecord(legacy.mcp) ? legacy.mcp : {}),
      ...(isRecord(current.mcp) ? current.mcp : {}),
    },
    permission: {
      ...legacyPermission,
      ...currentPermission,
      external_directory: {
        ...legacyExternalDirectory,
        ...currentExternalDirectory,
      },
    },
    provider: {
      ...(isRecord(legacy.provider) ? legacy.provider : {}),
      ...(isRecord(current.provider) ? current.provider : {}),
    },
    agent: {
      ...(isRecord(legacy.agent) ? legacy.agent : {}),
      ...(isRecord(current.agent) ? current.agent : {}),
    },
  };
}

async function resolveOpenAiRealtimeApiKey(env: EnvService): Promise<string> {
  const records = await env.list();
  const storedKey =
    records.find((entry) => entry.key === "OPENAI_REALTIME_API_KEY")?.value.trim() ||
    records.find((entry) => entry.key === "OPENAI_API_KEY")?.value.trim() ||
    "";
  if (storedKey) return storedKey;

  return process.env.LEGALWORK_OPENAI_REALTIME_API_KEY?.trim() ||
    process.env.OPENAI_REALTIME_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
}

async function resolveLegalWorkModelsVoiceConfig(env: EnvService): Promise<{ baseUrl: string; apiKey: string } | null> {
  const records = await env.list();
  const apiKey =
    records.find((entry) => entry.key === "LEGALWORK_API_KEY")?.value.trim() ||
    records.find((entry) => entry.key === "LEGALWORK_MODELS_API_KEY")?.value.trim() ||
    process.env.LEGALWORK_API_KEY?.trim() ||
    process.env.LEGALWORK_MODELS_API_KEY?.trim() ||
    "";
  if (!apiKey) return null;

  const baseUrl =
    records.find((entry) => entry.key === "LEGALWORK_INFERENCE_BASE_URL")?.value.trim() ||
    records.find((entry) => entry.key === "LEGALWORK_MODELS_BASE_URL")?.value.trim() ||
    process.env.LEGALWORK_INFERENCE_BASE_URL?.trim() ||
    process.env.LEGALWORK_MODELS_BASE_URL?.trim() ||
    "";
  if (!baseUrl) return null;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function legalworkVoiceRealtimeInstructions(sessionContext: string) {
  const trimmedContext = sessionContext.trim();
  const contextSection = trimmedContext
    ? `

# Current Session Context

Use this recent transcript context to answer questions about what was last discussed and to resolve references such as "this" or "that" when continuing the existing session. Do not treat it as a new user request.

${trimmedContext}`
    : "";
  return `# Role and Objective

You are LegalWork Voice Mode, a voice-first control layer inside LegalWork.
Help the user control LegalWork by using the semantic LegalWork UI tools.

# Tool Policy

- Prefer legalwork_snapshot, legalwork_list_actions, and legalwork_execute_action over visual guessing.
- If the user asks to write or draft something, use composer.set_text.
- If the user asks to send or run the current prompt, use composer.send.
- For navigation, settings, session, transcript, and composer work, inspect the action list first if the action id is unknown.
- Do not claim an action completed until the tool succeeds.
- Ask for confirmation before destructive actions such as deleting a session.

# Voice Style

- Be concise, calm, and direct.
- If audio is unclear, ask the user to repeat it instead of guessing.
- Ignore background speech that is not addressed to LegalWork.
- Summarize tool results briefly and offer the next useful step.${contextSection}`;
}

function readOpenAiClientSecret(payload: unknown): { clientSecret: string; expiresAt: number | null } {
  if (!isRecord(payload)) return { clientSecret: "", expiresAt: null };
  const clientSecret = payload.client_secret;
  if (typeof clientSecret === "string") return { clientSecret, expiresAt: null };
  if (isRecord(clientSecret)) {
    const value = typeof clientSecret.value === "string" ? clientSecret.value : "";
    const expiresAt = typeof clientSecret.expires_at === "number" ? clientSecret.expires_at : null;
    return { clientSecret: value, expiresAt };
  }
  const value = typeof payload.value === "string" ? payload.value : "";
  return { clientSecret: value, expiresAt: null };
}

async function createOpenAiRealtimeVoiceSession(env: EnvService, input: unknown) {
  const managedVoice = await resolveLegalWorkModelsVoiceConfig(env);
  if (managedVoice) {
    try {
      return await createManagedVoiceSession(managedVoice, input);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        const fallbackKey = await resolveOpenAiRealtimeApiKey(env);
        if (fallbackKey) {
          console.warn("[voice] LegalWork Models broker returned 503 — falling back to direct OpenAI Realtime.");
          return createDirectOpenAiVoiceSession(fallbackKey, input);
        }
        throw new ApiError(
          503,
          "legalwork_models_voice_unavailable",
          "LegalWork Models voice is active but the server is not fully configured. Ask your admin to add an OpenAI key, or save your own OPENAI_API_KEY in Environment settings.",
        );
      }
      throw error;
    }
  }

  const apiKey = await resolveOpenAiRealtimeApiKey(env);
  if (!apiKey) {
    throw new ApiError(
      400,
      "openai_api_key_missing",
      "OpenAI API key missing. Save OPENAI_API_KEY in LegalWork Environment Variables or configure the Voice Mode extension.",
    );
  }

  return createDirectOpenAiVoiceSession(apiKey, input);
}

async function createManagedVoiceSession(config: { baseUrl: string; apiKey: string }, input: unknown) {
  const response = await fetch(`${config.baseUrl}/voice/realtime/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input ?? {}),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = typeof errorPayload?.message === "string" ? errorPayload.message : response.statusText;
    throw new ApiError(response.status, "legalwork_models_voice_failed", message || "LegalWork Models could not create a voice session");
  }
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    typeof payload.clientSecret !== "string" ||
    typeof payload.model !== "string" ||
    !Array.isArray(payload.tools) ||
    payload.tools.some((tool) => typeof tool !== "string")
  ) {
    throw new ApiError(502, "legalwork_models_voice_invalid_response", "LegalWork Models did not return a usable Realtime session payload");
  }
  return {
    ok: true,
    clientSecret: payload.clientSecret,
    expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : null,
    model: payload.model,
    transcriptionModel: typeof payload.transcriptionModel === "string" ? payload.transcriptionModel : LEGALWORK_VOICE_TRANSCRIPTION_MODEL,
    tools: payload.tools,
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
  };
}

async function createDirectOpenAiVoiceSession(apiKey: string, input: unknown) {
  const model = readStringField(input, "model") || LEGALWORK_VOICE_REALTIME_MODEL;
  const sessionContext = readStringField(input, "sessionContext").slice(0, 6_000);
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: LEGALWORK_VOICE_TRANSCRIPTION_MODEL, language: "en" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.58,
              silence_duration_ms: 320,
              prefix_padding_ms: 300,
              create_response: true,
              interrupt_response: true,
            },
          },
        },
        instructions: legalworkVoiceRealtimeInstructions(sessionContext),
        tool_choice: "auto",
        tools: LEGALWORK_VOICE_REALTIME_TOOLS,
      },
    }),
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = typeof errorPayload?.message === "string" ? errorPayload.message : response.statusText;
    throw new ApiError(response.status, "openai_realtime_failed", message || "Failed to create OpenAI Realtime session");
  }

  const { clientSecret, expiresAt } = readOpenAiClientSecret(payload);
  if (!clientSecret) {
    throw new ApiError(502, "openai_realtime_invalid_response", "OpenAI did not return a usable Realtime client secret");
  }

  return {
    ok: true,
    clientSecret,
    expiresAt,
    model,
    transcriptionModel: LEGALWORK_VOICE_TRANSCRIPTION_MODEL,
    tools: LEGALWORK_VOICE_REALTIME_TOOLS.map((tool) => tool.name),
  };
}

const reloadBaselineRefreshers = new WeakMap<
  ServerConfig,
  (workspaceId: string, reasons?: ReloadReason[]) => Promise<void>
>();

type LogLevel = "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type ServerLogger = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
};

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function createServerLogger(config: ServerConfig): ServerLogger {
  const runId = process.env.LEGALWORK_RUN_ID ?? shortId();
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": "legalwork-server",
    "service.version": SERVER_VERSION,
    "service.instance.id": runId,
  };
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": runId,
    "process.pid": process.pid,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes) => {
    const merged = { ...baseAttributes, ...(attributes ?? {}) };
    if (config.logFormat === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: merged,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    process.stdout.write(`${message}\n`);
  };

  return { log: emit };
}

function logRequest(input: {
  logger: ServerLogger;
  request: Request;
  response: Response;
  durationMs: number;
  authMode: AuthMode;
  proxyService?: "opencode";
  proxyBaseUrl?: string;
  error?: string;
}) {
  const { logger, request, response, durationMs, authMode, proxyService, proxyBaseUrl, error } = input;
  const status = response.status;
  const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const proxyLabel = proxyBaseUrl ? ` (${proxyService ?? "proxy"})` : "";
  const message = `${method} ${url.pathname} ${status} ${durationMs}ms${proxyLabel}`;
  const attributes: LogAttributes = {
    method,
    path: url.pathname,
    status,
    durationMs,
    auth: authMode,
  };
  if (proxyBaseUrl) {
    attributes["proxy.base_url"] = proxyBaseUrl;
    if (proxyService) attributes["proxy.service"] = proxyService;
  }
  if (error) {
    attributes.error = error;
  }
  logger.log(level, message, attributes);
}

function parseWorkspaceMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/w/")) return null;
  const remainder = pathname.slice(3);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) {
    return { workspaceId: decodeURIComponent(remainder), restPath: "/" };
  }
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function parseWorkspaceOpencodeMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/workspace/")) return null;
  const remainder = pathname.slice("/workspace/".length);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) return null;
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  if (restPath !== "/opencode" && !restPath.startsWith("/opencode/")) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function normalizeOpencodeProxyPath(proxyPath: string): string {
  const raw = (proxyPath ?? "").trim() || "/";
  const withoutPrefix = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function assertOpencodeProxyAllowed(actor: Actor, method: string, proxyPath: string) {
  const m = method.toUpperCase();
  const scope = actor.scope ?? "viewer";

  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    throw new ApiError(403, "forbidden", "Viewer tokens are read-only");
  }

  // Prevent viewers from self-approving OpenCode permission requests via the
  // proxy. OpenCode uses /permission/:requestId/reply (and historically also
  // a session-scoped variant). Collaborators must be allowed: the SPA's only
  // credential is the collaborator-scoped client token (LEGALWORK_TOKEN), so
  // an owner-only gate made every interactive permission dialog un-answerable
  // (403 "Only owner tokens can reply") and left tool calls stuck in
  // "running" forever (#1918).
  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    const normalized = normalizeOpencodeProxyPath(proxyPath);
    if (/\/permission\/[^/]+\/reply$/.test(normalized)) {
      throw new ApiError(403, "forbidden", "Viewer tokens cannot reply to permission requests");
    }
  }
}

function isSessionCommandProxyRequest(method: string, proxyPath: string) {
  return method === "POST" && /^\/session\/[^/]+\/command$/.test(normalizeOpencodeProxyPath(proxyPath));
}

export type StartedServer = ServeResult & {
  /** Bound port of the HTTPS Word add-in listener, when enabled and started. */
  wordAddinPort: number | null;
};

export async function startServer(config: ServerConfig): Promise<StartedServer> {
  const approvals = new ApprovalService(config.approval);
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  const env = new EnvService();
  const logger = createServerLogger(config);
  let watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  const refreshWorkspaceReloadBaseline = (workspaceId: string, reasons?: ReloadReason[]) =>
    watcherHandle.refreshWorkspace(workspaceId, reasons);
  reloadBaselineRefreshers.set(config, refreshWorkspaceReloadBaseline);
  const restartReloadWatchers = () => {
    watcherHandle.close();
    watcherHandle = startReloadWatchers({ config, reloadEvents, logger });
  };
  const officeTools = new OfficeToolRelay();
  const benchmarkRunner = new BenchmarkRunner({
    config,
    // The SDK client is structurally compatible with the runner's reduced
    // client surface, but the generics make TS unable to prove it.
    createClient: (workspace, directory) =>
      createDirectoryOpencodeClient(config, workspace, directory) as unknown as BenchmarkOpencodeClient,
  });
  const routes = createRoutes(config, approvals, tokens, env, officeTools, restartReloadWatchers, benchmarkRunner);

  const serverOptions: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  } = {
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const startedAt = Date.now();
      let authMode: AuthMode = "none";
      let proxyService: "opencode" | undefined;
      let proxyBaseUrl: string | undefined;
      let errorMessage: string | undefined;

      const finalize = (response: Response) => {
        const wrapped = withCors(response, request, config);
        if (config.logRequests) {
            logRequest({
              logger,
              request,
              response: wrapped,
              durationMs: Date.now() - startedAt,
              authMode,
              proxyService,
              proxyBaseUrl,
              error: errorMessage,
            });
        }
        return wrapped;
      };

      const proxyWorkspaceOpencodeMount = async (mount: { workspaceId: string; restPath: string }) => {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, mount.restPath);
          const workspace = await resolveWorkspace(config, mount.workspaceId);
          proxyService = "opencode";
          proxyBaseUrl = workspace.baseUrl?.trim() || undefined;
          const response = await proxyOpencodeRequest({ config, request, url, workspace, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      };

      if (request.method === "OPTIONS") {
        return finalize(new Response(null, { status: 204 }));
      }

      if (url.pathname === WORD_ADDIN_PATH_PREFIX || url.pathname.startsWith(`${WORD_ADDIN_PATH_PREFIX}/`)) {
        const addinResponse = await handleWordAddinRequest({ request, url, config });
        if (addinResponse) {
          // Deliberately not CORS-wrapped: /word-addin/bootstrap returns the
          // client token and must only be readable same-origin.
          if (config.logRequests) {
            logRequest({
              logger,
              request,
              response: addinResponse,
              durationMs: Date.now() - startedAt,
              authMode: "none",
            });
          }
          return addinResponse;
        }
      }

      const canonicalOpencodeMount = parseWorkspaceOpencodeMount(url.pathname);
      if (canonicalOpencodeMount) {
        return proxyWorkspaceOpencodeMount(canonicalOpencodeMount);
      }

      const mount = parseWorkspaceMount(url.pathname);
      if (mount && (mount.restPath === "/opencode" || mount.restPath.startsWith("/opencode/"))) {
        return proxyWorkspaceOpencodeMount(mount);
      }

      // Allow clients to use a mounted base URL (e.g. http://host:8787/w/<id>) while
      // still calling the existing /workspace/:id/* API surface.
      // Example: baseUrl + "/workspace/<id>/plugins" => "/w/<id>/workspace/<id>/plugins".
      // We strip the mount prefix and route-match on the rest path.
      //
      // Important: when using a mounted base URL, enforce that the nested /workspace/:id
      // matches the mount workspace id to preserve the "single-workspace" mental model.
      if (mount && mount.restPath.startsWith("/workspace/")) {
        const match = mount.restPath.match(/^\/workspace\/([^/]+)/);
        const nestedId = match?.[1] ? decodeURIComponent(match[1]) : null;
        if (nestedId && nestedId !== mount.workspaceId) {
          errorMessage = "not_found";
          return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
        }
        url.pathname = mount.restPath;
      }

      if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
        authMode = "client";
        proxyBaseUrl = config.workspaces[0]?.baseUrl?.trim() || undefined;
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, url.pathname);
          proxyService = "opencode";
          const response = await proxyOpencodeRequest({ config, request, url, workspace: config.workspaces[0] });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
        errorMessage = "not_found";
        return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
      }

      authMode = route.auth;
      try {
        const actor =
          route.auth === "host-token"
            ? requireHostToken(request, config)
            : route.auth === "host"
              ? await requireHost(request, config, tokens)
              : route.auth === "client"
                ? await requireClient(request, config, tokens)
                : undefined;
        const response = await route.handler({
          request,
          url,
          params: route.params,
          config,
          approvals,
          reloadEvents,
          tokens,
          actor,
        });
        return finalize(response);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          console.error("[legalwork-server] Unhandled error:", error);
        }
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "Unexpected server error");
        errorMessage = apiError.message;
        return finalize(jsonResponse(formatError(apiError), apiError.status));
      }
    },
  };

  const server = await serve({
    ...serverOptions,
    idleTimeout: 120,
  });

  // Optional HTTPS listener for the Word add-in. It shares the exact same
  // fetch handler (API, OpenCode proxy, and /word-addin static hosting), so
  // the task pane talks to a single same-origin base URL. Word requires
  // HTTPS for task pane sources, hence the dedicated TLS listener.
  let wordAddinServer: ServeResult | null = null;
  if (config.wordAddin?.enabled) {
    const tlsMaterial = await loadWordAddinTls(config.wordAddin);
    if (!tlsMaterial.tls) {
      logger.log(
        "warn",
        `Word add-in is enabled but the TLS certificate could not be loaded (${tlsMaterial.error ?? "unknown"}). ` +
          "Run `npx office-addin-dev-certs install` or pass --word-addin-cert/--word-addin-key.",
      );
    } else {
      try {
        wordAddinServer = await serve({
          hostname: config.host,
          port: config.wordAddin.port,
          fetch: serverOptions.fetch,
          idleTimeout: 120,
          tls: tlsMaterial.tls,
        });
        // Keep the manifest in sync with the actually bound port.
        config.wordAddin = { ...config.wordAddin, port: wordAddinServer.port };
        logger.log(
          "info",
          `Word add-in listening on https://localhost:${wordAddinServer.port}${WORD_ADDIN_PATH_PREFIX}/ ` +
            `(manifest: https://localhost:${wordAddinServer.port}${WORD_ADDIN_PATH_PREFIX}/manifest.xml, cert: ${tlsMaterial.certPath})`,
        );
      } catch (error) {
        logger.log("error", `Failed to start the Word add-in listener: ${String(error)}`);
      }
    }
  }

  return {
    ...server,
    wordAddinPort: wordAddinServer?.port ?? null,
    stop: async () => {
      benchmarkRunner.dispose();
      watcherHandle.close();
      reloadBaselineRefreshers.delete(config);
      await wordAddinServer?.stop();
      await server.stop();
    },
  };
}

function buildOpencodeProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode/, "");
  target.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.search = search;
  return target.toString();
}

function buildOpencodeDirectoryHeader(directory: string) {
  return /[^\x00-\x7F]/.test(directory) ? encodeURIComponent(directory) : directory;
}

function createOpencodeDirectoryFetch(directory: string): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(init?.headers ?? request.headers);
      headers.set("x-opencode-directory", buildOpencodeDirectoryHeader(directory));
      return fetch(new Request(request, { headers }));
    },
    { preconnect: fetch.preconnect },
  );
}

type OpencodeClientResult<T, E> =
  | { data: T | undefined; error: undefined; response: Response }
  | { data: undefined; error: E; response: Response };

function createWorkspaceOpencodeClient(config: ServerConfig, workspace: WorkspaceInfo) {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const directory = resolveOpencodeDirectory(workspace);
  const directoryFetch = directory ? createOpencodeDirectoryFetch(directory) : undefined;

  return createOpencodeClient({
    baseUrl: connection.baseUrl?.trim(),
    ...(directory ? { directory } : {}),
    ...(directoryFetch ? { fetch: directoryFetch } : {}),
    ...(connection.authHeader ? { headers: { Authorization: connection.authHeader } } : {}),
  });
}

/**
 * Like createWorkspaceOpencodeClient, but pinned to an explicit directory
 * (e.g. a benchmark scratch dir inside the workspace) so the directory header
 * and per-call directory params agree.
 */
function createDirectoryOpencodeClient(config: ServerConfig, workspace: WorkspaceInfo, directory: string) {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  return createOpencodeClient({
    baseUrl: connection.baseUrl?.trim(),
    directory,
    fetch: createOpencodeDirectoryFetch(directory),
    ...(connection.authHeader ? { headers: { Authorization: connection.authHeader } } : {}),
  });
}

function unwrapOpencodeResult<T, E>(result: OpencodeClientResult<T, E>, path: string): NonNullable<T> {
  if (result.data != null) {
    return result.data;
  }
  if (result.error === undefined) {
    throw new ApiError(502, "opencode_empty_response", "OpenCode returned an empty response", { path });
  }
  throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
    status: result.response.status,
    body: result.error,
    path,
  });
}

async function proxyOpencodeRequest(input: {
  config: ServerConfig;
  request: Request;
  url: URL;
  workspace?: WorkspaceInfo;
  proxyPath?: string;
}) {
  const workspace = input.workspace;
  const baseUrl = workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).baseUrl?.trim() ?? "" : "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpencodeProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-legalwork-host-token");
  headers.delete("x-legalwork-client-id");
  headers.delete("host");
  headers.delete("origin");

  const directory = workspace ? resolveOpencodeDirectory(workspace) : null;
  if (directory && !headers.has("x-opencode-directory")) {
    headers.set("x-opencode-directory", buildOpencodeDirectoryHeader(directory));
  }

  const auth = workspace ? resolveWorkspaceOpencodeConnection(input.config, workspace).authHeader ?? null : null;
  if (auth) {
    headers.set("Authorization", auth);
  }

  const method = input.request.method.toUpperCase();
  // Buffer the request body so it can be forwarded reliably across Node.js
  // stream boundaries (Readable.toWeb streams from the HTTP adapter aren't
  // always accepted directly by Node's global fetch as a body).
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await input.request.arrayBuffer().then((buf) => (buf.byteLength > 0 ? buf : undefined));
  if (isSessionCommandProxyRequest(method, proxyPath)) {
    void fetch(targetUrl, {
      method,
      headers,
      body,
    }).catch(() => {
      // Command failures are surfaced through the OpenCode event stream.
    });
    return jsonResponse({ ok: true, accepted: true });
  }
  const response = await fetch(targetUrl, {
    method,
    headers,
    body,
  });

  return sanitizeProxyResponse(response);
}

/**
 * Strip hop-by-hop and transport-level headers that Bun's native fetch keeps
 * in the upstream response even after it has already decoded the body for us.
 * Without this the browser sees `content-encoding: gzip` on a plain-text
 * payload and bails out with ERR_CONTENT_DECODING_FAILED, breaking any UI
 * code that reaches through /opencode/* (including session.create).
 */
function sanitizeProxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response: Response, request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");
  const allowedOrigins = config.corsOrigins;
  let allowOrigin: string | null = null;
  if (allowedOrigins.includes("*")) {
    allowOrigin = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  }

  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-LegalWork-Host-Token, X-LegalWork-Client-Id, X-OpenCode-Directory, X-Opencode-Directory, x-opencode-directory",
  );
  headers.set("Access-Control-Expose-Headers", "X-LegalWork-Updated-At");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function requireClient(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const scope = await tokens.scopeForToken(token);
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const clientId = request.headers.get("x-legalwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(token), scope };
}

function requireHostToken(request: Request, config: ServerConfig): Actor {
  const hostToken = request.headers.get("x-legalwork-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }
  throw new ApiError(401, "unauthorized", "Invalid host token");
}

async function requireHost(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const hostToken = request.headers.get("x-legalwork-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1];
  if (!bearer) {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const scope = await tokens.scopeForToken(bearer);
  if (scope !== "owner") {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const clientId = request.headers.get("x-legalwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(bearer), scope };
}

function buildCapabilities(config: ServerConfig): Capabilities {
  const writeEnabled = !config.readOnly;
  const schemaVersion = 1;
  const sandboxBackend = resolveSandboxBackend();
  const sandboxEnabled = resolveSandboxEnabled(sandboxBackend);
  const inboxEnabled = resolveInboxEnabled();
  const outboxEnabled = resolveOutboxEnabled();
  const maxBytes = resolveInboxMaxBytes();
  const toyUiEnabled = resolveToyUiEnabled();
  const browserProvider = resolveBrowserProvider();
  const opencodeConfigured = config.workspaces.some((workspace) => Boolean(workspace.baseUrl?.trim()));
  return {
    schemaVersion,
    serverVersion: SERVER_VERSION,
    opencodeVersion: OPENCODE_VERSION,
    skills: { read: true, write: writeEnabled, source: "legalwork" },
    skillResources: { read: true, write: writeEnabled },
    hub: {
      skills: {
        read: true,
        install: writeEnabled,
      },
    },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    sandbox: { enabled: sandboxEnabled, backend: sandboxBackend },
    ui: { toy: toyUiEnabled },
    tokens: { scoped: true, scopes: ["owner", "collaborator", "viewer"] },
    proxy: {
      opencode: opencodeConfigured,
    },
    toolProviders: {
      browser: browserProvider,
      files: {
        injection: writeEnabled && inboxEnabled,
        outbox: outboxEnabled,
        inboxPath: ".opencode/legalwork/inbox/",
        outboxPath: ".opencode/legalwork/outbox/",
        maxBytes,
      },
    },
  };
}

function resolveSandboxBackend(): Capabilities["sandbox"]["backend"] {
  const raw = (process.env.LEGALWORK_SANDBOX_BACKEND ?? "").trim().toLowerCase();
  if (raw === "docker") return "docker";
  if (raw === "container") return "container";
  return "none";
}

function resolveSandboxEnabled(backend: Capabilities["sandbox"]["backend"]): boolean {
  const raw = (process.env.LEGALWORK_SANDBOX_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return backend !== "none";
}

function resolveInboxEnabled(): boolean {
  const raw = (process.env.LEGALWORK_INBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveOutboxEnabled(): boolean {
  const raw = (process.env.LEGALWORK_OUTBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveInboxMaxBytes(): number {
  const raw = (process.env.LEGALWORK_INBOX_MAX_BYTES ?? "").trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.trunc(parsed), 250_000_000);
  }
  return 50_000_000;
}

function resolveToyUiEnabled(): boolean {
  const raw = (process.env.LEGALWORK_TOY_UI ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

// Dev-only log sink target. When LEGALWORK_DEV_LOG_FILE is set to a path, the
// /dev/log endpoint accepts JSON payloads and appends them to that file so an
// operator can `tail -f` the file to see live browser activity. Returning null
// disables the endpoint entirely.
function resolveDevLogPath(): string | null {
  const raw = (process.env.LEGALWORK_DEV_LOG_FILE ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function resolveBrowserProvider(): Capabilities["toolProviders"]["browser"] {
  const raw = (process.env.LEGALWORK_BROWSER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "sandbox-headless") {
    return { enabled: true, placement: "in-sandbox", mode: "headless" };
  }
  if (raw === "host-interactive") {
    return { enabled: true, placement: "host-machine", mode: "interactive" };
  }
  if (raw === "client-interactive") {
    return { enabled: true, placement: "client-machine", mode: "interactive" };
  }
  return { enabled: false, placement: "external", mode: "none" };
}

function emitReloadEvent(
  reloadEvents: ReloadEventStore,
  workspace: WorkspaceInfo,
  reason: ReloadReason,
  trigger?: ReloadTrigger,
) {
  reloadEvents.recordDebounced(workspace.id, reason, trigger);
}

function buildConfigTrigger(path: string): ReloadTrigger {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return {
    type: "config",
    name: name || "opencode.json",
    action: "updated",
    path,
  };
}

export type AuthorizedFoldersResponse = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot: string;
};

export type AuthorizedFoldersUpdateResponse = {
  folders: string[];
  hiddenCount: number;
  updatedAt: number;
};

type AuthorizedFoldersConfig = {
  folders: string[];
  hiddenEntries: Record<string, unknown>;
};

function normalizeAuthorizedFolderPath(input: string | null | undefined): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "/*") return "/";
  const withoutWildcard = trimmed.replace(/[\\/]\*+$/, "");
  const withoutVerbatim = /^\\\\\?\\UNC\\/i.test(withoutWildcard)
    ? `\\${withoutWildcard.slice(7)}`
    : /^\\\\\?\\[a-zA-Z]:[\\/]/.test(withoutWildcard)
      ? withoutWildcard.slice(4)
      : withoutWildcard;
  const unified = withoutVerbatim.replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  return withoutTrailing || "/";
}

function externalDirectoryKeyToAuthorizedFolder(key: string, value: unknown): string | null {
  if (value !== "allow") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed === "/*") return "/";
  if (!trimmed.endsWith("/*")) return null;
  return normalizeAuthorizedFolderPath(trimmed.slice(0, -2));
}

function authorizedFolderToExternalDirectoryKey(folder: string): string {
  return folder === "/" ? "/*" : `${folder}/*`;
}

function hasOwnKey(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readAuthorizedFoldersFromOpencodeConfig(
  opencodeConfig: Record<string, unknown>,
  workspaceRoot: string,
): AuthorizedFoldersConfig {
  const workspaceRootFolder = normalizeAuthorizedFolderPath(workspaceRoot);
  const permission = ensurePlainObject(opencodeConfig.permission);
  const externalDirectory = ensurePlainObject(permission.external_directory);
  const folders: string[] = [];
  const hiddenEntries: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(externalDirectory)) {
    const folder = externalDirectoryKeyToAuthorizedFolder(key, value);
    if (!folder) {
      hiddenEntries[key] = value;
      continue;
    }
    if (folder === workspaceRootFolder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return { folders, hiddenEntries };
}

function parseAuthorizedFoldersPayload(input: unknown, workspaceRoot: string): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "folders must be an array");
  }

  const workspaceRootFolder = normalizeAuthorizedFolderPath(workspaceRoot);
  const folders: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    if (typeof item !== "string") {
      throw new ApiError(400, "invalid_payload", "folders must be an array of strings");
    }
    const folder = normalizeAuthorizedFolderPath(item);
    if (!folder || folder === workspaceRootFolder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return folders;
}

function mergeAuthorizedFoldersIntoExternalDirectory(
  folders: string[],
  hiddenEntries: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...hiddenEntries };
  for (const folder of folders) {
    next[authorizedFolderToExternalDirectoryKey(folder)] = "allow";
  }
  return Object.keys(next).length ? next : undefined;
}

function buildAuthorizedFoldersResponse(workspace: WorkspaceInfo, config: AuthorizedFoldersConfig): AuthorizedFoldersResponse {
  return {
    folders: config.folders,
    hiddenCount: Object.keys(config.hiddenEntries).length,
    workspaceRoot: normalizeAuthorizedFolderPath(workspace.path),
  };
}

function serializeWorkspace(workspace: ServerConfig["workspaces"][number]) {
  const { opencodeUsername, opencodePassword, ...rest } = workspace;
  const opencodeDirectory = resolveOpencodeDirectory(workspace);
  const opencode =
    workspace.baseUrl || opencodeDirectory || opencodeUsername || opencodePassword
      ? {
          baseUrl: workspace.baseUrl,
          directory: opencodeDirectory ?? undefined,
          username: opencodeUsername,
          password: opencodePassword,
        }
      : undefined;
  return {
    ...rest,
    opencode,
  };
}

function createRoutes(
  config: ServerConfig,
  approvals: ApprovalService,
  tokens: TokenService,
  env: EnvService,
  officeTools: OfficeToolRelay,
  onWorkspacesChanged: () => void,
  benchmarkRunner: BenchmarkRunner,
): Route[] {
  const routes: Route[] = [];
  registerCoreRoutes({
    routes,
    config,
    tokens,
    env,
    serverVersion: SERVER_VERSION,
    opencodeVersion: OPENCODE_VERSION,
    jsonResponse,
    readJsonBody,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    buildCapabilities,
    fetchRuntimeControl,
    resolveWorkspace,
    serializeWorkspace,
    resolveToyUiEnabled,
    resolveDevLogPath,
    createOpenAiRealtimeVoiceSession,
  });

  registerWorkspaceRoutes({
    routes,
    config,
    onWorkspacesChanged,
    jsonResponse,
    readJsonBody,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    resolveWorkspace,
    serializeWorkspace,
    reloadOpencodeEngine,
  });

  registerSessionRoutes({
    routes,
    config,
    jsonResponse,
    parseOptionalBoolean,
    parseOptionalPositiveInteger,
    parseOptionalNonNegativeInteger,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    createWorkspaceOpencodeClient,
    unwrapOpencodeResult,
  });

  registerBenchmarkRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    parseOptionalBoolean,
    parseOptionalPositiveInteger,
    parseOptionalNonNegativeInteger,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    getStore: () => openBenchmarkStore(config),
    runner: benchmarkRunner,
  });

  const recorderUnavailable = () => ({
    available: false,
    recordingActive: false,
    liveTranscriptActive: false,
    fileName: null,
    error: null,
  });

  addRoute(routes, "GET", "/workspace/:id/recorder/live-transcript", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(config.recorder ? await config.recorder.status(workspace.path) : recorderUnavailable());
  });

  addRoute(routes, "POST", "/workspace/:id/recorder/live-transcript", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_recorder_state", "enabled must be a boolean");
    }
    return jsonResponse(
      config.recorder
        ? await config.recorder.setLiveTranscript(body.enabled, workspace.path)
        : recorderUnavailable(),
    );
  });

  addRoute(routes, "PUT", "/analytics/identity", "client", async (ctx) => {
    // Desktop pushes its analytics consent here and gets the per-launch
    // distinct id back; the Office pane adopts it via the word-addin
    // bootstrap. Held in memory only.
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    setAnalyticsConsent({ analyticsEnabled: body.analyticsEnabled });
    return jsonResponse({ ok: true, distinctId: launchAnalyticsId() });
  });

  addRoute(routes, "GET", "/personalization", "client", async () => {
    return jsonResponse({ settings: await readGlobalPersonalizationSettings(config) });
  });

  addRoute(routes, "PUT", "/personalization", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const settings = parsePersonalizationPayload(await readJsonBody(ctx.request));
    await writeRuntimeOpencodeConfig(config, GLOBAL_PERSONALIZATION_ID, (current) => ({
      ...current,
      personalization: settings,
    }));
    return jsonResponse({ settings, updatedAt: Date.now() });
  });

  addRoute(routes, "DELETE", "/personalization/memories", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    if (body.confirm !== true) {
      throw new ApiError(400, "confirmation_required", "confirm must be true");
    }
    const deletedDirectories = await deleteAllLocalMemories(config);
    return jsonResponse({ ok: true, deletedDirectories });
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const legalwork = mergeLegalworkWorkspaceConfigs(
      await readLegalworkConfig(workspace.path),
      await readLegalworkWorkspaceConfig(config, workspace.id),
    );
    // Tool permissions come from the global row; the workspace row only
    // contributes external_directory (see applyGlobalToolPermissions).
    const opencode = mergeOpencodeConfigs(
      await readOpencodeConfig(workspace.path),
      applyGlobalToolPermissions(
        await readRuntimeOpencodeConfig(config, workspace.id),
        await readGlobalToolPermissions(config),
      ),
    );
    const lastAudit = await readLastAudit(workspace.path, workspace.id);
    return jsonResponse({ opencode, legalwork, updatedAt: lastAudit?.timestamp ?? null });
  });

  addRoute(routes, "GET", "/workspace/:id/cloud-plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const cloudImports = await readInstalledCloudPlugins(config, workspace.id);
    return jsonResponse({ marketplaces: cloudImports.marketplaces, plugins: cloudImports.plugins });
  });

  addRoute(routes, "POST", "/workspace/:id/cloud-plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const resolved = readCloudPluginResolved(body.resolved);
    const marketplace = body.marketplace && typeof body.marketplace === "object" && !Array.isArray(body.marketplace)
      ? Object.fromEntries(Object.entries(body.marketplace))
      : null;
    const marketplaceId = typeof body.marketplaceId === "string" && body.marketplaceId.trim()
      ? body.marketplaceId.trim()
      : null;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "cloud_plugins.install",
      summary: `Install cloud plugin ${resolved.plugin.name}`,
      paths: [legalworkConfigPath(workspace.path), join(workspace.path, ".opencode")],
    });

    const imported = await installCloudPlugin({
      serverConfig: config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      marketplaceId,
      marketplace: marketplaceId
        ? {
            id: marketplaceId,
            name: typeof marketplace?.name === "string" ? marketplace.name : marketplaceId,
            updatedAt: typeof marketplace?.updatedAt === "string" ? marketplace.updatedAt : null,
          }
        : null,
      resolved,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "cloud_plugins.install",
      target: legalworkConfigPath(workspace.path),
      summary: `Installed cloud plugin ${resolved.plugin.name}`,
      timestamp: Date.now(),
    });

    for (const file of imported.files) {
      emitReloadEvent(ctx.reloadEvents, workspace, file.objectType === "mcp" ? "mcp" : file.objectType === "skill" ? "skills" : file.objectType === "agent" ? "agents" : file.objectType === "command" ? "commands" : "config", {
        type: file.objectType === "skill" || file.objectType === "agent" || file.objectType === "command" || file.objectType === "mcp" ? file.objectType : "config",
        name: file.title,
        action: "added",
      });
    }

    return jsonResponse({ item: imported });
  });

  // Claude Code plugin bundles (MCP + skills + commands + agents) installed
  // straight from a GitHub repo. `dryRun: true` returns the "Will install"
  // preview without writing anything; install reuses the cloud-plugin
  // machinery, so uninstall goes through DELETE /cloud-plugins/:pluginId.
  addRoute(routes, "POST", "/workspace/:id/claude-plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new ApiError(400, "invalid_payload", "GitHub URL is required");
    const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
    const dryRun = body.dryRun === true;

    const bundle = await resolveClaudePluginBundle({ url, ref });
    if (dryRun) {
      return jsonResponse({ preview: bundle.preview });
    }

    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "cloud_plugins.install",
      summary: `Install Claude plugin ${bundle.resolved.plugin.name} from ${bundle.preview.source.owner}/${bundle.preview.source.repo}`,
      paths: [legalworkConfigPath(workspace.path), join(workspace.path, ".opencode")],
    });

    const imported = await installCloudPlugin({
      serverConfig: config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      marketplaceId: null,
      resolved: bundle.resolved,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "cloud_plugins.install",
      target: legalworkConfigPath(workspace.path),
      summary: `Installed Claude plugin ${bundle.resolved.plugin.name} from ${url}`,
      timestamp: Date.now(),
    });

    for (const file of imported.files) {
      emitReloadEvent(ctx.reloadEvents, workspace, file.objectType === "mcp" ? "mcp" : file.objectType === "skill" ? "skills" : file.objectType === "agent" ? "agents" : file.objectType === "command" ? "commands" : "config", {
        type: file.objectType === "skill" || file.objectType === "agent" || file.objectType === "command" || file.objectType === "mcp" ? file.objectType : "config",
        name: file.title,
        action: "added",
      });
    }

    // Hot-register any bundled MCP servers with the running engine.
    await syncRuntimeMcpToOpencodeEngine(config, workspace).catch(() => undefined);

    return jsonResponse({ item: imported, preview: bundle.preview });
  });

  addRoute(routes, "DELETE", "/workspace/:id/cloud-plugins/:pluginId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const pluginId = ctx.params.pluginId ?? "";

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "cloud_plugins.remove",
      summary: `Remove cloud plugin ${pluginId}`,
      paths: [legalworkConfigPath(workspace.path), join(workspace.path, ".opencode")],
    });

    const removed = await removeCloudPlugin({
      serverConfig: config,
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      pluginId,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "cloud_plugins.remove",
      target: legalworkConfigPath(workspace.path),
      summary: `Removed cloud plugin ${removed.name}`,
      timestamp: Date.now(),
    });

    for (const file of removed.files) {
      emitReloadEvent(ctx.reloadEvents, workspace, file.objectType === "mcp" ? "mcp" : file.objectType === "skill" ? "skills" : file.objectType === "agent" ? "agents" : file.objectType === "command" ? "commands" : "config", {
        type: file.objectType === "skill" || file.objectType === "agent" || file.objectType === "command" || file.objectType === "mcp" ? file.objectType : "config",
        name: file.title,
        action: "removed",
      });
    }

    return jsonResponse({ item: removed });
  });

  addRoute(routes, "GET", "/workspace/:id/authorized-folders", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const opencode = mergeOpencodeConfigs(
      await readOpencodeConfig(workspace.path),
      await readRuntimeOpencodeConfig(config, workspace.id),
    );
    const foldersConfig = readAuthorizedFoldersFromOpencodeConfig(opencode, workspace.path);
    return jsonResponse(buildAuthorizedFoldersResponse(workspace, foldersConfig));
  });

  addRoute(routes, "PUT", "/workspace/:id/authorized-folders", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const folders = parseAuthorizedFoldersPayload(body.folders, workspace.path);
    const configPath = legalworkConfigPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.authorized_folders.write",
      summary: "Update authorized folders",
      paths: [configPath],
    });

    const persistedOpencode = await readOpencodeConfig(workspace.path);
    const runtimeOpencode = await readRuntimeOpencodeConfig(config, workspace.id);
    const existingOpencode = mergeOpencodeConfigs(persistedOpencode, runtimeOpencode);
    const existingFoldersConfig = readAuthorizedFoldersFromOpencodeConfig(existingOpencode, workspace.path);
    const nextExternalDirectory = mergeAuthorizedFoldersIntoExternalDirectory(
      folders,
      existingFoldersConfig.hiddenEntries,
    );

    await writeRuntimeOpencodeConfig(config, workspace.id, (current) => ({
      ...current,
      permission: {
        ...(ensurePlainObject(current.permission)),
        external_directory: nextExternalDirectory ?? {},
      },
    }));

    const updatedAt = Date.now();
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.authorized_folders.write",
      target: configPath,
      summary: "Updated authorized folders",
      timestamp: updatedAt,
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(configPath));

    const updatedFoldersConfig = readAuthorizedFoldersFromOpencodeConfig({
      permission: { external_directory: nextExternalDirectory ?? {} },
    }, workspace.path);

    const response: AuthorizedFoldersUpdateResponse = {
      folders: updatedFoldersConfig.folders,
      hiddenCount: Object.keys(updatedFoldersConfig.hiddenEntries).length,
      updatedAt,
    };
    return jsonResponse(response);
  });

  addRoute(routes, "POST", "/workspace/:id/runtime-config/migrate", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const configPath = legalworkConfigPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.runtime_migrate",
      summary: "Migrate legacy runtime OpenCode config",
      paths: [configPath],
    });

    const legalwork = await readLegalworkConfigForStatus(workspace.path);
    const legacy = legacyRuntimeConfigFromLegalworkConfig(legalwork.data);
    const user = userRuntimeConfigFromOpencodeConfig(await readOpencodeConfig(workspace.path));
    if (!legacy.keys.length && !user.keys.length) {
      return jsonResponse({ migrated: false, keys: [], legacyKeys: [], userOpencodeKeys: [], updatedAt: null, legacyError: legalwork.error });
    }

    await writeRuntimeOpencodeConfig(config, workspace.id, (current) => (
      mergeLegacyRuntimeConfig(mergeLegacyRuntimeConfig(current, legacy.config), user.config)
    ));
    if (legacy.keys.length && !legalwork.error) {
      await writeLegalworkConfig(workspace.path, removeLegacyRuntimeConfig(legalwork.data), false);
    }
    await removeUserRuntimeConfigFromOpencode(workspace.path, user.keys);

    const updatedAt = Date.now();
    const keys = [...legacy.keys, ...user.keys];
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.runtime_migrate",
      target: configPath,
      summary: `Migrated runtime OpenCode config: ${keys.join(", ")}`,
      timestamp: updatedAt,
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(configPath));

    return jsonResponse({ migrated: true, keys, legacyKeys: legacy.keys, userOpencodeKeys: user.keys, updatedAt, legacyError: legalwork.error });
  });

  addRoute(routes, "GET", "/workspace/:id/runtime-config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
    const legalwork = await readLegalworkConfigForStatus(workspace.path);
    const legalworkConfig = legalwork.data;
    const legacy = legacyRuntimeConfigFromLegalworkConfig(legalworkConfig);
    const rawOpencode = await readRawOpencodeConfig(opencodeConfigPath(workspace.path));
    const persistedOpencode = await readOpencodeConfig(workspace.path);
    const globalOpencodePath = resolveOpencodeConfigFilePath("global", workspace.path);
    const rawGlobalOpencode = await readRawOpencodeConfig(globalOpencodePath);
    const globalOpencode = (await readJsoncFile(globalOpencodePath, {} as Record<string, unknown>, { allowInvalid: true })).data;
    const effectiveRuntime = await buildLegalworkRuntimeConfigObject(config, workspace.id);
    const user = userRuntimeConfigFromOpencodeConfig(persistedOpencode);

    return jsonResponse({
      runtime,
      runtimeKeys: runtimeConfigKeys(runtime),
      effectiveRuntime,
      sources: {
        projectOpencode: {
          path: opencodeConfigPath(workspace.path),
          exists: rawOpencode.exists,
          keys: userOpencodeConfigKeys(persistedOpencode),
          config: persistedOpencode,
        },
        globalOpencode: {
          path: globalOpencodePath,
          exists: rawGlobalOpencode.exists,
          keys: userOpencodeConfigKeys(globalOpencode),
          config: globalOpencode,
        },
        runtimeDatabase: {
          keys: runtimeConfigKeys(runtime),
          config: runtime,
        },
        injected: {
          keys: runtimeConfigKeys(effectiveRuntime),
          config: effectiveRuntime,
        },
      },
      legacyLegalwork: {
        path: legalworkConfigPath(workspace.path),
        keys: legacy.keys,
        error: legalwork.error,
      },
      userOpencode: {
        path: opencodeConfigPath(workspace.path),
        exists: rawOpencode.exists,
        keys: userOpencodeConfigKeys(persistedOpencode),
        migratableKeys: user.keys,
      },
    });
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const scope = normalizeOpencodeScope(ctx.url.searchParams.get("scope"));
    const configPath = resolveOpencodeConfigFilePath(scope, workspace.path);
    const result = await readRawOpencodeConfig(configPath);
    return jsonResponse({ path: configPath, exists: result.exists, content: result.content });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const scope = normalizeOpencodeScope(typeof body.scope === "string" ? body.scope : null);
    const content = typeof body.content === "string" ? body.content : null;
    if (content === null) {
      throw new ApiError(400, "invalid_payload", "content must be a string");
    }

    const configPath = resolveOpencodeConfigFilePath(scope, workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: scope === "global" ? "config.global.write" : "config.write",
      summary: `Write ${scope} OpenCode config`,
      paths: [configPath],
    });

    const nextContent = content.endsWith("\n") ? content : `${content}\n`;
    const current = await readRawOpencodeConfig(configPath);
    const changed = !current.exists || current.content !== nextContent;
    if (changed) {
      await ensureDir(dirname(configPath));
      await writeFile(configPath, nextContent, "utf8");
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: scope === "global" ? "config.global.write" : "config.write",
      target: configPath,
      summary: `Updated ${scope} OpenCode config`,
      timestamp: Date.now(),
    });

    if (scope === "project" && changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(configPath));
    }

    return jsonResponse({
      ok: true,
      status: 0,
      stdout: `Wrote ${configPath}`,
      stderr: "",
    });
  });

  // Eigenwelt platform connect: the server owns the OAuth loopback + code
  // exchange (see eigenwelt-auth.ts). The app opens the authorize URL,
  // long-polls the wait endpoint for the exchange payload, and then writes
  // the provider block itself via PATCH /workspace/:id/config.
  addRoute(routes, "POST", "/api/eigenwelt/oauth/start", "client", async () => {
    try {
      return jsonResponse(await startEigenweltSignIn());
    } catch (error) {
      throw new ApiError(
        409,
        "eigenwelt_signin_unavailable",
        error instanceof Error ? error.message : "Failed to start the Eigenwelt sign-in.",
      );
    }
  });

  addRoute(routes, "GET", "/api/eigenwelt/oauth/wait/:sessionId", "client", async (ctx) => {
    try {
      return jsonResponse(await waitForEigenweltSignIn(ctx.params.sessionId));
    } catch (error) {
      throw new ApiError(
        410,
        "eigenwelt_signin_failed",
        error instanceof Error ? error.message : "Eigenwelt sign-in failed.",
      );
    }
  });

  addRoute(routes, "GET", "/api/eigenwelt/models", "client", async () => {
    try {
      return jsonResponse(await fetchEigenweltManifest());
    } catch (error) {
      throw new ApiError(
        502,
        "eigenwelt_platform_unreachable",
        error instanceof Error ? error.message : "Could not reach the Eigenwelt platform.",
      );
    }
  });

  // Eigenwelt subscription: entitlements + Firm Hub. The app persists the
  // connection (entitlements + platformURL + the secret platformToken) here
  // right after "Sign in with Eigenwelt" completes. The token is server-side
  // only (never returned to the app) and backs the hub proxy routes below.
  const resolveHubClient = async (workspaceId: string) => {
    // Refresh the short-lived access token before every hub call so proxied
    // requests never carry an expired token.
    await ensureFreshPlatformToken(config, workspaceId);
    return requireHubClient(await readEigenweltConnection(config, workspaceId));
  };

  const parseHubKind = (value: string): EigenweltHubKind => {
    if (
      value === "skill" || value === "workflow" || value === "mcp" || value === "plugin" ||
      value === "integration" || value === "preset"
    ) {
      return value;
    }
    throw new ApiError(400, "invalid_hub_kind", "kind must be skill, workflow, mcp or plugin.");
  };

  const parseSharedMcpSecret = (secretJson: string): Record<string, unknown> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(secretJson);
    } catch {
      throw new ApiError(400, "invalid_integration_secret", "The shared MCP credential is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "invalid_integration_secret", "The shared MCP credential is not a valid configuration.");
    }
    const config = parsed as Record<string, unknown>;
    validateMcpConfig(config);
    return config;
  };

  // Derive a valid hub item name ([a-z0-9][a-z0-9-_]*) from a plugin spec/path.
  const deriveHubName = (ref: string): string => {
    const base = basename(ref.replace(/^file:\/\//, "")).replace(/\.(js|ts|mjs|cjs)$/i, "");
    const cleaned = base.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return cleaned || "plugin";
  };

  // Rebuild the engine-visible config file (a single file for the primary
  // workspace, which the shared engine re-reads on every instance dispose) so a
  // change to the GLOBAL eigenwelt manifest lands across all workspaces.
  const rebuildEngineConfigFile = async () => {
    const primary = config.workspaces?.[0]?.id;
    if (primary) await writeLegalworkRuntimeConfigFile(config, primary).catch(() => undefined);
  };

  // Last-applied active-sub state. When an entitlements poll flips it (a sub
  // activated or lapsed) we rebuild the engine config once so the paid provider
  // is added or dropped live — the same fallback the recorder does for audio.
  let lastPaidEntitled: boolean | undefined;

  addRoute(routes, "PUT", "/workspace/:id/eigenwelt/connection", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const entitlements =
      body.entitlements === undefined ? undefined : parseEigenweltEntitlements(body.entitlements) ?? null;
    const account =
      body.account === undefined ? undefined : parseEigenweltAccountIdentity(body.account) ?? null;
    let platformURL: string | null | undefined;
    if (body.platformURL === undefined) {
      platformURL = undefined;
    } else if (body.platformURL === null) {
      platformURL = null;
    } else if (typeof body.platformURL === "string") {
      try {
        platformURL = validateEigenweltPlatformUrl(body.platformURL);
      } catch (error) {
        throw new ApiError(
          400,
          "invalid_eigenwelt_platform_url",
          error instanceof Error ? error.message : "Invalid Eigenwelt platform URL.",
        );
      }
    } else {
      throw new ApiError(400, "invalid_eigenwelt_platform_url", "Invalid Eigenwelt platform URL.");
    }
    const platformToken =
      body.platformToken === undefined
        ? undefined
        : typeof body.platformToken === "string"
          ? body.platformToken
          : null;

    // Sign-out (explicit): revoke the refresh-token family + clear the
    // connection AND the global paid-provider manifest, so the eigenwelt
    // provider drops out of every workspace's engine config.
    if (body.disconnect === true) {
      await revokeEigenweltConnection(config, workspace.id);
      await clearCachedEigenweltPaidManifest(config);
      await rebuildEngineConfigFile();
      return jsonResponse(await readEigenweltEntitlementsView(config, workspace.id));
    }

    const refreshToken =
      body.refreshToken === undefined
        ? undefined
        : typeof body.refreshToken === "string"
          ? body.refreshToken
          : null;
    const accessTokenExpiresAt =
      body.accessTokenExpiresAt === undefined
        ? undefined
        : typeof body.accessTokenExpiresAt === "number"
          ? body.accessTokenExpiresAt
          : null;
    const view = await writeEigenweltConnection(config, workspace.id, {
      entitlements,
      account,
      platformURL,
      platformToken,
      refreshToken,
      accessTokenExpiresAt,
    });

    // Sign-in: cache the GLOBAL paid manifest {baseURL, apiKey, models} and
    // rebuild the engine config so the eigenwelt provider is injected into
    // EVERY workspace (an account provider, not a per-workspace one).
    if (typeof body.baseURL === "string" && body.baseURL && typeof body.apiKey === "string" && body.apiKey) {
      await writeCachedEigenweltPaidManifest(config, {
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        models: parseManifestModels(body.models),
      });
      await rebuildEngineConfigFile();
    }
    return jsonResponse(view);
  });

  addRoute(routes, "GET", "/workspace/:id/eigenwelt/entitlements", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    // Opportunistically refresh (rotate the token + pull current entitlements)
    // so the plan/usage the desktop shows stays live. `?refresh=1` forces the
    // pull now (the post-checkout "waiting for your subscription" poll).
    const force = ctx.url.searchParams.get("refresh") === "1";
    const view = await readFreshEntitlementsView(config, workspace.id, { force });
    // A flip in active-sub state adds/drops the paid provider — rebuild the
    // engine config once so premium API access follows the subscription live.
    const paidEntitled = eigenweltHasPremiumModels(view.entitlements);
    if (paidEntitled !== lastPaidEntitled) {
      lastPaidEntitled = paidEntitled;
      await rebuildEngineConfigFile();
    }
    return jsonResponse(view);
  });

  // Manual "Refresh models": re-pull the gateway manifest into the GLOBAL
  // eigenwelt manifest (around the kept key) and rebuild the engine config so
  // new models appear in every workspace — no re-authentication needed.
  addRoute(routes, "POST", "/workspace/:id/eigenwelt/refresh-models", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const result = await refreshEigenweltPaidManifest(config);
    if (result.changed) await rebuildEngineConfigFile();
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/hub", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    const kindParam = ctx.url.searchParams.get("kind")?.trim();
    // `?all=1` (or no kind) returns every team category in one call — the
    // platform join carries sharer identity + key status so the app can group
    // by member and flag included keys.
    if (!kindParam || ctx.url.searchParams.get("all") === "1") {
      return jsonResponse({ items: await hubListAll(client) });
    }
    return jsonResponse({ items: await hubList(client, parseHubKind(kindParam)) });
  });

  addRoute(routes, "GET", "/workspace/:id/hub/:itemId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    return jsonResponse(await hubGet(client, ctx.params.itemId));
  });

  addRoute(routes, "POST", "/workspace/:id/hub/share/workflow", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    const body = await readJsonBodyLimited(ctx.request, 512 * 1024);
    const skill = String(body.skill ?? "").trim();
    if (!skill) throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : skill;
    const description = typeof body.description === "string" ? body.description : undefined;
    const payload = await serializeWorkflowSkill(workspace.path, skill);
    const result = await hubCreate(client, { kind: "workflow", name, description, payload });
    return jsonResponse({ ok: true, ...result });
  });

  // Matter id to title, so a source can say which matter it belongs to.
  addRoute(routes, "POST", "/workspace/:id/legalmemory/matters", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const server = resolveLegalMemoryServer(await listMcp(config, workspace.id, workspace.path));
    if (!server) throw new ApiError(409, "legalmemory_not_configured", "No LegalMemory server is configured");
    try {
      return jsonResponse({ ok: true, matters: await fetchLegalMemoryMatters(server, await engineAccessToken(server.name)) });
    } catch {
      // A source without its matter is still a usable source.
      return jsonResponse({ ok: true, matters: {} });
    }
  });

  // The caller's LegalMemory estate as a lazy file tree. The LegalWork server
  // owns the configured appliance URL and reuses the engine's MCP bearer, so
  // the renderer sees neither while each listing keeps the caller's ACLs.
  addRoute(routes, "POST", "/workspace/:id/legalmemory/tree/roots", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const server = resolveLegalMemoryServer(await listMcp(config, workspace.id, workspace.path));
    if (!server) throw new ApiError(409, "legalmemory_not_configured", "No LegalMemory server is configured");
    try {
      return jsonResponse(await fetchLegalMemoryTreeRoots(server, await engineAccessToken(server.name)));
    } catch (error) {
      throw new ApiError(502, "legalmemory_tree_failed", error instanceof Error ? error.message : "File tree failed");
    }
  });

  addRoute(routes, "POST", "/workspace/:id/legalmemory/tree/children", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBodyLimited(ctx.request, 16 * 1024);
    const sourceId = typeof body.source_id === "string" ? body.source_id.trim() : "";
    const path = typeof body.path === "string" ? body.path.trim() : "";
    const offset = typeof body.offset === "number" && Number.isInteger(body.offset) ? Math.max(0, body.offset) : 0;
    const limit = typeof body.limit === "number" && Number.isInteger(body.limit)
      ? Math.min(250, Math.max(1, body.limit))
      : 200;
    if (!sourceId) throw new ApiError(400, "invalid_source_id", "A source_id is required");
    if (path.length > 4096) throw new ApiError(400, "invalid_tree_path", "The folder path is too long");
    const server = resolveLegalMemoryServer(await listMcp(config, workspace.id, workspace.path));
    if (!server) throw new ApiError(409, "legalmemory_not_configured", "No LegalMemory server is configured");
    try {
      return jsonResponse(await fetchLegalMemoryTreeChildren(
        server,
        { sourceId, path: path || undefined, offset, limit },
        await engineAccessToken(server.name),
      ));
    } catch (error) {
      throw new ApiError(502, "legalmemory_tree_failed", error instanceof Error ? error.message : "Folder listing failed");
    }
  });

  addRoute(routes, "POST", "/workspace/:id/legalmemory/tree/search", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBodyLimited(ctx.request, 16 * 1024);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const limit = typeof body.limit === "number" && Number.isInteger(body.limit)
      ? Math.min(100, Math.max(1, body.limit))
      : 100;
    if (!query) return jsonResponse({ files: [] });
    const server = resolveLegalMemoryServer(await listMcp(config, workspace.id, workspace.path));
    if (!server) throw new ApiError(409, "legalmemory_not_configured", "No LegalMemory server is configured");
    try {
      return jsonResponse(await fetchLegalMemoryTreeSearch(
        server,
        { query, limit },
        await engineAccessToken(server.name),
      ));
    } catch (error) {
      throw new ApiError(502, "legalmemory_tree_failed", error instanceof Error ? error.message : "File search failed");
    }
  });

  // The stored relations around a cited document, fetched by the app.
  //
  // The agent is asked to traverse before concluding and does not: on a real
  // run, six searches and zero traversals. The engine exposes no way to force a
  // tool call, and the graph is the part of this index a search cannot
  // reproduce, so waiting for the model to ask means it never appears.
  addRoute(routes, "POST", "/workspace/:id/legalmemory/graph", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBodyLimited(ctx.request, 8 * 1024);
    const documentId = typeof body.document_id === "string" ? body.document_id.trim() : "";
    if (!documentId) throw new ApiError(400, "invalid_document_id", "A document_id is required");

    const server = resolveLegalMemoryServer(await listMcp(config, workspace.id, workspace.path));
    if (!server) throw new ApiError(409, "legalmemory_not_configured", "No LegalMemory server is configured");
    try {
      const graph = await fetchLegalMemoryGraph(server, documentId, await engineAccessToken(server.name));
      return jsonResponse({ ok: true, graph });
    } catch (error) {
      throw new ApiError(502, "legalmemory_graph_failed", error instanceof Error ? error.message : "Traversal failed");
    }
  });

  // Open a cited LegalMemory document. Called when the user clicks a source,
  // not by the agent: fetching a file the user asked for is the app's job.
  //
  // Takes a document_id, never a URL. The bytes come back inside the MCP tool
  // result via `inline_blob`, so there is no side-channel download endpoint to
  // be unreachable behind a proxy, no capability token to expire, and no
  // model-supplied URL for us to validate before fetching it.
  addRoute(routes, "POST", "/workspace/:id/legalmemory/open", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBodyLimited(ctx.request, 8 * 1024);

    const documentId = typeof body.document_id === "string" ? body.document_id.trim() : "";
    if (!documentId) throw new ApiError(400, "invalid_document_id", "A document_id is required");

    const server = resolveLegalMemoryServer(await listMcp(config, workspace.id, workspace.path));
    if (!server) {
      throw new ApiError(409, "legalmemory_not_configured", "No LegalMemory server is configured for this workspace");
    }

    let document: Awaited<ReturnType<typeof fetchLegalMemoryDocument>>;
    try {
      document = await fetchLegalMemoryDocument(server, documentId, await engineAccessToken(server.name));
    } catch (error) {
      throw new ApiError(502, "legalmemory_fetch_failed", error instanceof Error ? error.message : "LegalMemory download failed");
    }

    const filename = safeExportFilename(document.filename);
    if (!filename) throw new ApiError(502, "legalmemory_bad_filename", "LegalMemory returned an unusable filename");

    // Exports live in their own folder. That keeps them out of the matter's own
    // files, and it is what makes overwriting safe: everything in here was put
    // there by this route, so a same-named file is the same document fetched
    // again rather than the firm's work. Suffixing copies instead would leave a
    // trail of "Deed (2).docx" for repeat clicks on one source.
    const exportDir = join(workspace.path, LEGALMEMORY_EXPORT_DIR);
    await mkdir(exportDir, { recursive: true });
    const relativePath = `${LEGALMEMORY_EXPORT_DIR}/${filename}`;
    await writeFile(join(exportDir, filename), document.bytes);
    return jsonResponse({ ok: true, path: relativePath, bytes: document.bytes.byteLength, mimeType: document.mimeType });
  });

  addRoute(routes, "POST", "/workspace/:id/hub/share/integration", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    const body = await readJsonBodyLimited(ctx.request, 64 * 1024);
    const mcpName = String(body.mcp ?? "").trim();
    if (!mcpName) throw new ApiError(400, "invalid_mcp_name", "MCP name is required");
    const items = await listMcp(config, workspace.id, workspace.path);
    const entry = items.find((item) => item.name === mcpName);
    if (!entry) throw new ApiError(404, "mcp_not_found", `MCP not found: ${mcpName}`);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : mcpName;
    const description = typeof body.description === "string" ? body.description : undefined;
    const payload = buildIntegrationPayload(entry.name, entry.config);
    const result = await hubCreate(client, { kind: "integration", name, description, payload });
    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "POST", "/workspace/:id/hub/share/preset", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "").trim();
    if (!name) throw new ApiError(400, "invalid_hub_name", "A preset name is required");
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw new ApiError(400, "invalid_preset", "A preset payload is required");
    }
    // A preset is a SHARE TEMPLATE: keep only the safe opencode settings fragment
    // (provider shape without keys, model, small_model) and strip every secret.
    const payload = sanitizePresetFragment(body.payload as Record<string, unknown>);
    if (Object.keys(payload).length === 0) {
      throw new ApiError(400, "invalid_preset", "This preset has no shareable settings.");
    }
    const description = typeof body.description === "string" ? body.description : undefined;
    const result = await hubCreate(client, { kind: "preset", name, description, payload });
    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "POST", "/workspace/:id/hub/install/:itemId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    const body = await readJsonBodyLimited(ctx.request, 16 * 1024);
    if (body.acknowledgeExecutableRisk !== true) {
      throw new ApiError(400, "hub_install_acknowledgement_required", "Confirm that you trust the sharer and reviewed the executable content before installing.");
    }
    const allowOverwrite = body.allowOverwrite === true;
    const item = await hubGet(client, ctx.params.itemId);
    if (item.kind === "skill" || item.kind === "workflow") {
      const files =
        item.payload && typeof item.payload === "object"
          ? (item.payload as { files?: unknown }).files
          : null;
      const target = join(globalSkillsDir(), item.name);
      if (!allowOverwrite && await exists(target)) {
        throw new ApiError(409, "hub_install_would_overwrite", `A local workflow named ${item.name} already exists. Confirm replacement to continue.`);
      }
      const result = await installWorkflowFiles(workspace.path, item.name, files);
      // Record the pulled version so the Firm Hub can flag a future update.
      await recordHubInstall(config, workspace.id, item.id, {
        version: item.version,
        kind: item.kind,
        name: result.name,
        installedAt: Date.now(),
      });
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
        type: "skill",
        name: result.name,
        action: "added",
        path: result.path,
      });
      await recordAudit(workspace.path, {
        id: shortId(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" },
        action: "firm_hub.install", target: result.path,
        summary: `Installed ${item.kind} ${item.name} shared by ${item.createdByUserId}`,
        timestamp: Date.now(),
      });
      return jsonResponse({
        ok: true,
        kind: item.kind,
        name: result.name,
        path: result.path,
        written: result.written,
        version: item.version,
      });
    }
    if (item.kind === "mcp" || item.kind === "integration") {
      const integration = parseIntegrationPayload(item.payload);
      let mcpConfig = integration.mcp;
      let keyIncluded = false;
      if (item.hasSecret && item.canAccessSecret) {
        const secretJson = await hubGetSecret(client, item.id);
        if (secretJson) {
          mcpConfig = parseSharedMcpSecret(secretJson);
          keyIncluded = true;
        }
      }
      const result = await addMcp(config, workspace.id, integration.key, mcpConfig);
      await recordHubInstall(config, workspace.id, item.id, {
        version: item.version,
        kind: item.kind,
        name: integration.key,
        installedAt: Date.now(),
      });
      emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
        type: "mcp",
        name: integration.key,
        action: result.action,
      });
      await recordAudit(workspace.path, {
        id: shortId(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" },
        action: "firm_hub.install", target: integration.key,
        summary: `Installed MCP ${integration.key} shared by ${item.createdByUserId}${keyIncluded ? " with its shared credential" : " as a template"}`,
        timestamp: Date.now(),
      });
      return jsonResponse({
        ok: true,
        kind: item.kind,
        name: integration.key,
        action: result.action,
        keyIncluded,
        version: item.version,
      });
    }
    if (item.kind === "plugin") {
      if (!item.pinned) {
        throw new ApiError(403, "hub_plugin_not_approved", "An organization admin must pin this plugin before it can be installed.");
      }
      const plugin = parsePluginPayload(item.payload);
      if ("spec" in plugin) {
        await addPlugin(config, workspace.id, plugin.spec);
      } else {
        if (!allowOverwrite && await exists(projectPluginsDir(workspace.path))) {
          throw new ApiError(409, "hub_install_would_overwrite", "Plugin files already exist in this workspace. Confirm replacement to continue.");
        }
        await installFolderFiles(projectPluginsDir(workspace.path), plugin.files);
      }
      await recordHubInstall(config, workspace.id, item.id, {
        version: item.version, kind: item.kind, name: item.name, installedAt: Date.now(),
      });
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", { type: "plugin", name: item.name, action: "added" });
      await recordAudit(workspace.path, {
        id: shortId(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" },
        action: "firm_hub.install", target: item.name,
        summary: `Installed admin-approved plugin ${item.name} shared by ${item.createdByUserId}`,
        timestamp: Date.now(),
      });
      return jsonResponse({ ok: true, kind: item.kind, name: item.name, version: item.version });
    }
    // Presets are applied from settings via the config APIs, not installed here.
    throw new ApiError(400, "preset_install_unsupported", "Apply presets from settings, not the hub install action.");
  });

  // Batch share: push many local items (skills, workflows, plugins, MCP) at
  // once. MCP items may include their key (encrypted, allow-list scoped) via the
  // separate secret channel — the hub payload always stays secret-free.
  addRoute(routes, "POST", "/workspace/:id/hub/share/batch", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    const body = await readJsonBodyLimited(ctx.request, 512 * 1024);
    if (body.acknowledgeSharingRisk !== true) {
      throw new ApiError(400, "hub_share_acknowledgement_required", "Review executable content and possible client data before sharing with the firm.");
    }
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) throw new ApiError(400, "no_items", "No items to share.");
    if (rawItems.length > EIGENWELT_HUB_MAX_BATCH_ITEMS) {
      throw new ApiError(413, "too_many_items", `Share at most ${EIGENWELT_HUB_MAX_BATCH_ITEMS} items at once.`);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const raw of rawItems) {
      const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const ref = String(entry.ref ?? "").trim();
      let kind: EigenweltHubKind | undefined;
      try {
        kind = parseHubKind(String(entry.kind ?? ""));
        const description = typeof entry.description === "string" ? entry.description : undefined;
        const includeSecret = entry.includeSecret === true;
        let allow: "all" | string[];
        if (entry.allow === undefined || entry.allow === "all") {
          allow = "all";
        } else if (Array.isArray(entry.allow) && entry.allow.every((value) => typeof value === "string" && value.trim())) {
          allow = [...new Set(entry.allow.map((value) => String(value).trim()))];
        } else {
          throw new ApiError(400, "invalid_secret_allow", "Credential access must be 'all' or a list of firm member ids.");
        }
        if (!ref) throw new ApiError(400, "invalid_ref", "Each item needs a local ref.");
        if (kind === "skill" || kind === "workflow") {
          const localSkills = await listSkills(workspace.path, false);
          const localSkill = localSkills.find((skill) => skill.name === ref);
          const publishedKind = resolveHubSkillKind(localSkill, kind, ref);
          const payload = await serializeWorkflowSkill(workspace.path, ref);
          const res = await hubCreate(client, { kind: publishedKind, name: ref, description, payload });
          results.push({ ref, kind: publishedKind, ok: true, id: res.id, version: res.version });
        } else if (kind === "mcp") {
          const mcps = await listMcp(config, workspace.id, workspace.path);
          const mcp = mcps.find((m) => m.name === ref);
          if (!mcp) throw new ApiError(404, "mcp_not_found", `MCP not found: ${ref}`);
          const payload = buildIntegrationPayload(mcp.name, mcp.config); // stripped template
          const configuredSecret = JSON.stringify(mcp.config);
          if (includeSecret && Buffer.byteLength(configuredSecret, "utf8") > EIGENWELT_HUB_MAX_SECRET_BYTES) {
            throw new ApiError(413, "hub_secret_too_large", "The MCP configuration is too large to share as a credential (64 KiB max)." );
          }
          const res = await hubCreate(client, {
            kind: "mcp", name: ref, description, payload,
            secret: includeSecret ? { value: configuredSecret, allow } : null,
          });
          results.push({ ref, kind, ok: true, id: res.id, version: res.version, keyIncluded: includeSecret });
        } else if (kind === "plugin") {
          const { items: plugins } = await listPlugins(config, workspace.id, workspace.path, true);
          const pl = plugins.find((p) => p.spec === ref || p.path === ref);
          if (!pl) throw new ApiError(404, "plugin_not_found", `Plugin not found: ${ref}`);
          const name = deriveHubName(pl.path ?? pl.spec);
          let payload: unknown;
          const isLocalPlugin = pl.spec.startsWith("file:") || isAbsolute(pl.spec);
          if (pl.source === "config" && !isLocalPlugin) {
            payload = { spec: pl.spec };
          } else {
            let abs: string;
            try {
              abs = pl.spec.startsWith("file:") ? fileURLToPath(pl.spec) : pl.spec;
            } catch {
              throw new ApiError(400, "invalid_plugin", "The local plugin path is not a valid file URL.");
            }
            const sourceStat = await lstat(abs);
            if (sourceStat.isSymbolicLink()) {
              throw new ApiError(400, "invalid_plugin", "Symlinked plugins cannot be shared with the firm.");
            }
            if (sourceStat.isDirectory()) {
              payload = await serializeLocalFolder(abs);
            } else if (sourceStat.isFile()) {
              const buf = await readFile(abs);
              const filePayload = { files: [{ path: basename(abs), contentBase64: buf.toString("base64") }] };
              if (Buffer.byteLength(JSON.stringify(filePayload), "utf8") > EIGENWELT_HUB_MAX_PAYLOAD_BYTES) {
                throw new ApiError(413, "hub_payload_too_large", "The plugin is too large to share (20 MiB max).");
              }
              payload = filePayload;
            } else {
              throw new ApiError(400, "invalid_plugin", "Only plugin files and folders can be shared.");
            }
          }
          const res = await hubCreate(client, { kind: "plugin", name, description, payload });
          results.push({ ref, kind, ok: true, id: res.id, version: res.version });
        } else {
          throw new ApiError(400, "unshareable_kind", `Cannot batch-share kind: ${kind}`);
        }
      } catch (err) {
        results.push({ ref, ...(kind ? { kind } : {}), ok: false, error: err instanceof ApiError ? err.message : String(err) });
      }
    }
    const succeeded = results.filter((result) => result.ok).length;
    if (succeeded > 0) {
      await recordAudit(workspace.path, {
        id: shortId(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" },
        action: "firm_hub.share", target: workspace.id,
        summary: `Shared ${succeeded} item${succeeded === 1 ? "" : "s"} with the firm`,
        timestamp: Date.now(),
      });
    }
    return jsonResponse({ results });
  });

  // Batch install: pull many shared items at once. MCP items install fully
  // configured when the caller is on the key's allow-list, otherwise as a
  // secret-free template.
  addRoute(routes, "POST", "/workspace/:id/hub/install/batch", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    const body = await readJsonBodyLimited(ctx.request, 64 * 1024);
    if (body.acknowledgeExecutableRisk !== true) {
      throw new ApiError(400, "hub_install_acknowledgement_required", "Confirm that you trust the sharers and reviewed the executable content before installing.");
    }
    const allowOverwrite = body.allowOverwrite === true;
    const itemIds = Array.isArray(body.itemIds)
      ? [...new Set(body.itemIds.filter((v: unknown): v is string => typeof v === "string"))]
      : [];
    if (itemIds.length === 0) throw new ApiError(400, "no_items", "No items to install.");
    if (itemIds.length > EIGENWELT_HUB_MAX_BATCH_ITEMS) {
      throw new ApiError(413, "too_many_items", `Install at most ${EIGENWELT_HUB_MAX_BATCH_ITEMS} items at once.`);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const itemId of itemIds) {
      try {
        const item = await hubGet(client, itemId);
        if (item.kind === "skill" || item.kind === "workflow") {
          const files = item.payload && typeof item.payload === "object"
            ? (item.payload as { files?: unknown }).files
            : null;
          const target = join(globalSkillsDir(), item.name);
          if (!allowOverwrite && await exists(target)) {
            throw new ApiError(409, "hub_install_would_overwrite", `A local workflow named ${item.name} already exists.`);
          }
          const res = await installWorkflowFiles(workspace.path, item.name, files);
          emitReloadEvent(ctx.reloadEvents, workspace, "skills", { type: "skill", name: res.name, action: "added", path: res.path });
          await recordHubInstall(config, workspace.id, item.id, { version: item.version, kind: item.kind, name: res.name, installedAt: Date.now() });
          results.push({ id: item.id, kind: item.kind, name: res.name, ok: true });
        } else if (item.kind === "mcp" || item.kind === "integration") {
          // Prefer the full configured entry (key included) when we're allowed;
          // fall back to the secret-free template otherwise.
          const integration = parseIntegrationPayload(item.payload);
          let mcpConfig = integration.mcp;
          let keyIncluded = false;
          const secretJson = item.hasSecret && item.canAccessSecret ? await hubGetSecret(client, item.id) : null;
          if (secretJson) {
            mcpConfig = parseSharedMcpSecret(secretJson);
            keyIncluded = true;
          }
          const res = await addMcp(config, workspace.id, integration.key, mcpConfig);
          emitReloadEvent(ctx.reloadEvents, workspace, "mcp", { type: "mcp", name: integration.key, action: res.action });
          await recordHubInstall(config, workspace.id, item.id, { version: item.version, kind: item.kind, name: integration.key, installedAt: Date.now() });
          results.push({ id: item.id, kind: item.kind, name: integration.key, ok: true, keyIncluded });
        } else if (item.kind === "plugin") {
          if (!item.pinned) {
            throw new ApiError(403, "hub_plugin_not_approved", "An organization admin must pin this plugin before it can be installed.");
          }
          const plugin = parsePluginPayload(item.payload);
          if ("spec" in plugin) {
            await addPlugin(config, workspace.id, plugin.spec);
          } else {
            if (!allowOverwrite && await exists(projectPluginsDir(workspace.path))) {
              throw new ApiError(409, "hub_install_would_overwrite", "Plugin files already exist in this workspace.");
            }
            await installFolderFiles(projectPluginsDir(workspace.path), plugin.files);
          }
          emitReloadEvent(ctx.reloadEvents, workspace, "plugins", { type: "plugin", name: item.name, action: "added" });
          await recordHubInstall(config, workspace.id, item.id, { version: item.version, kind: item.kind, name: item.name, installedAt: Date.now() });
          results.push({ id: item.id, kind: item.kind, name: item.name, ok: true });
        } else {
          throw new ApiError(400, "uninstallable_kind", `Cannot install kind: ${item.kind}`);
        }
      } catch (err) {
        results.push({ id: itemId, ok: false, error: err instanceof ApiError ? err.message : String(err) });
      }
    }
    const succeeded = results.filter((result) => result.ok).length;
    if (succeeded > 0) {
      await recordAudit(workspace.path, {
        id: shortId(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" },
        action: "firm_hub.install", target: workspace.id,
        summary: `Installed ${succeeded} firm hub item${succeeded === 1 ? "" : "s"}`,
        timestamp: Date.now(),
      });
    }
    return jsonResponse({ results });
  });

  addRoute(routes, "DELETE", "/workspace/:id/hub/:itemId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const client = await resolveHubClient(workspace.id);
    await hubDelete(client, ctx.params.itemId);
    // The item no longer exists in the firm — drop any local install record so
    // it stops showing as installed/updatable.
    await forgetHubInstall(config, workspace.id, ctx.params.itemId);
    return jsonResponse({ ok: true, id: ctx.params.itemId });
  });

  // Local record of installed hub items ({id: {version, kind, name}}) that backs
  // "update available" detection. Never returns platform secrets.
  addRoute(routes, "GET", "/workspace/:id/hub/installs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ installs: await readHubInstalls(config, workspace.id) });
  });

  // Presets are applied from settings (not via the install action), so the app
  // records the pulled version here after a successful apply/update.
  addRoute(routes, "POST", "/workspace/:id/hub/installs", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const id = String(body.id ?? "").trim();
    if (!id) throw new ApiError(400, "invalid_hub_id", "A hub item id is required.");
    const version = typeof body.version === "number" ? body.version : Number(body.version);
    if (!Number.isFinite(version)) {
      throw new ApiError(400, "invalid_hub_version", "A numeric hub item version is required.");
    }
    const kind = parseHubKind(String(body.kind ?? "preset"));
    const name = typeof body.name === "string" ? body.name : "";
    const installs = await recordHubInstall(config, workspace.id, id, {
      version,
      kind,
      name,
      installedAt: Date.now(),
    });
    return jsonResponse({ ok: true, installs });
  });

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, workspace.id, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const opencode = body.opencode as Record<string, unknown> | undefined;
    const legalwork = body.legalwork as Record<string, unknown> | undefined;

    if (!opencode && !legalwork) {
      throw new ApiError(400, "invalid_payload", "opencode or legalwork updates required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [opencode || legalwork ? legalworkConfigPath(workspace.path) : null].filter(Boolean) as string[],
    });

    if (opencode) {
      const configPath = legalworkConfigPath(workspace.path);
      const nextOpencode = ensurePlainObject(opencode);
      const { permission, provider, agent, ...topLevelUpdates } = nextOpencode;
      const logicalUpdates: Record<string, unknown> = { ...topLevelUpdates };

      const providerUpdate = ensurePlainObject(provider);
      if (Object.keys(providerUpdate).length) {
        const currentRuntime = await readRuntimeOpencodeConfig(config, workspace.id);
        // A `null` value in the patch removes that provider (see
        // mergeRuntimeProviderPatch) so a client can fully disconnect it.
        logicalUpdates.provider = mergeRuntimeProviderPatch(
          ensurePlainObject(currentRuntime.provider),
          providerUpdate,
        );
      }

      const agentUpdate = ensurePlainObject(agent);
      if (Object.keys(agentUpdate).length) {
        const currentRuntime = await readRuntimeOpencodeConfig(config, workspace.id);
        logicalUpdates.agent = mergeRuntimeProviderPatch(
          ensurePlainObject(currentRuntime.agent),
          agentUpdate,
        );
      }

      const permissionUpdate = ensurePlainObject(permission);
      if (Object.keys(permissionUpdate).length) {
        const { external_directory: externalDirectoryUpdate, ...toolPermissionUpdate } = permissionUpdate;

        // Tool permissions are GLOBAL — one safety posture for every
        // workspace — so they merge into the reserved global row. A `null`
        // value in the patch removes that key (JSON cannot carry
        // `undefined`); unmentioned keys are preserved as-is.
        if (Object.keys(toolPermissionUpdate).length) {
          const globalRuntime = await readRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID);
          const nextGlobal = mergeRuntimeProviderPatch(
            ensurePlainObject(globalRuntime.permission),
            toolPermissionUpdate,
          );
          await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, (current) => ({
            ...current,
            permission: Object.keys(nextGlobal).length
              ? (nextGlobal as RuntimeOpencodeConfig["permission"])
              : undefined,
          }));
        }

        // external_directory stays workspace-scoped: it is owned by the
        // authorized-folders routes and describes this workspace's folders.
        if (externalDirectoryUpdate !== undefined) {
          const existingRuntime = await readRuntimeOpencodeConfig(config, workspace.id);
          const nextPermission = mergeRuntimeProviderPatch(
            ensurePlainObject(existingRuntime.permission),
            { external_directory: externalDirectoryUpdate },
          );
          logicalUpdates.permission = Object.keys(nextPermission).length ? nextPermission : undefined;
        }
      }

      if (Object.keys(logicalUpdates).length || Object.prototype.hasOwnProperty.call(logicalUpdates, "permission")) {
        await writeRuntimeOpencodeConfig(config, workspace.id, (current) => ({
          ...current,
          ...logicalUpdates,
        }));
      }
    }
    if (legalwork) {
      await writeLegalworkWorkspaceConfig(config, workspace.id, (current) => ({
        ...current,
        ...legalwork,
      }));
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: legalworkConfigPath(workspace.path),
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    if (opencode) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(legalworkConfigPath(workspace.path)));
    }

    return jsonResponse({ updatedAt: Date.now() });
  });

  registerOperationRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    requireClientScope,
    resolveWorkspace,
    reloadOpencodeEngine,
  });

  registerOfficeToolRoutes({
    routes,
    config,
    officeTools,
    jsonResponse,
    readJsonBody,
    requireClientScope,
    resolveWorkspace,
  });

  registerFileRoutes({
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireApproval,
    requireClientScope,
    resolveWorkspace,
    resolveInboxEnabled,
    resolveOutboxEnabled,
    resolveInboxMaxBytes,
    scopeRank,
  });

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const result = await listPlugins(config, workspace.id, workspace.path, includeGlobal);
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    const normalized = normalizePluginSpec(spec);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [legalworkConfigPath(workspace.path)],
    });
    const changed = await addPlugin(config, workspace.id, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: legalworkConfigPath(workspace.path),
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    if (changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "added",
      });
    }
    const result = await listPlugins(config, workspace.id, workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const normalized = normalizePluginSpec(name);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${name}`,
      paths: [legalworkConfigPath(workspace.path)],
    });
    const removed = await removePlugin(config, workspace.id, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: legalworkConfigPath(workspace.path),
      summary: `Removed ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "removed",
      });
    }
    const result = await listPlugins(config, workspace.id, workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/hub/skills", "client", async (ctx) => {
    const owner = ctx.url.searchParams.get("owner")?.trim();
    const repo = ctx.url.searchParams.get("repo")?.trim();
    const ref = ctx.url.searchParams.get("ref")?.trim();
    if (!owner || !repo) {
      throw new ApiError(400, "hub_repo_required", "Hub owner and repo are required.");
    }
    const items = await listHubSkills({
      owner,
      repo,
      ref: ref || "main",
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const items = await listSkills(workspace.path, includeGlobal);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/skills/hub/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const body = await readJsonBody(ctx.request);
    const overwrite = body?.overwrite === true;
    const repoPayload = body?.repo && typeof body.repo === "object" ? (body.repo as Record<string, unknown>) : undefined;
    const repo = repoPayload
      ? {
          owner: typeof repoPayload.owner === "string" ? repoPayload.owner : undefined,
          repo: typeof repoPayload.repo === "string" ? repoPayload.repo : undefined,
          ref: typeof repoPayload.ref === "string" ? repoPayload.ref : undefined,
        }
      : undefined;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.install_hub",
      summary: `Install hub skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });

    const result = await installHubSkill(workspace.path, { name, overwrite, repo });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.install_hub",
      target: result.path,
      summary: `Installed hub skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "POST", "/workspace/:id/github-skills/scan", "client", async (ctx) => {
    await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const url = String(body?.url ?? "").trim();
    if (!url) throw new ApiError(400, "invalid_github_url", "A GitHub repo URL is required");
    const ref = body?.ref ? String(body.ref).trim() : undefined;
    const result = await scanGithubSkills({ url, ref });
    return jsonResponse(result);
  });

  // Resolves the picked skills into ready-to-write content. It does NOT write to
  // disk — the client writes each skill to the correct location (global skills
  // dir on desktop, project for remote workspaces), so this is a read-only fetch.
  addRoute(routes, "POST", "/workspace/:id/github-skills/install", "client", async (ctx) => {
    await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const url = String(body?.url ?? "").trim();
    if (!url) throw new ApiError(400, "invalid_github_url", "A GitHub repo URL is required");
    const ref = body?.ref ? String(body.ref).trim() : undefined;
    const asWorkflow = body?.asWorkflow === true;
    const paths = Array.isArray(body?.paths)
      ? (body.paths as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (!paths.length) throw new ApiError(400, "no_skills_selected", "Select at least one skill to import");
    const result = await installGithubSkills({ url, ref, paths, asWorkflow });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/skills/:name/promote-workflow", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Mark ${name} as a workflow`,
      paths: [join(workspace.path, ".opencode", "skills")],
    });
    const result = await promoteSkillToWorkflow(workspace.path, name);
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name: result.name,
      action: "added",
      path: result.path,
    });
    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const items = await listSkills(workspace.path, includeGlobal);
    const item = items.find((skill) => skill.name === name);
    if (!item) {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    const content = await readFile(item.path, "utf8");
    return jsonResponse({ item, content });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const result = await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: result.path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    return jsonResponse({ name, path: result.path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.delete",
      summary: `Delete skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });
    const result = await deleteSkill(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.delete",
      target: result.path,
      summary: `Deleted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: "removed",
      path: result.path,
    });
    return jsonResponse({ ok: true, name, path: result.path });
  });

  // Attached files (firm templates/playbooks) live INSIDE the skill's own
  // folder — .opencode/skills/<name>/resources/<file> — so a workflow plus its
  // templates is one self-contained folder that can be shared as a zip.
  // Mutations also regenerate the managed "Attached resources" SKILL.md section.
  addRoute(routes, "GET", "/workspace/:id/skills/:skill/resources", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listSkillResources(workspace.path, String(ctx.params.skill ?? ""));
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:skill/resources/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await readSkillResource(
      workspace.path,
      String(ctx.params.skill ?? ""),
      String(ctx.params.name ?? "").trim(),
    );
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/skills/:skill/resources", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const skill = String(ctx.params.skill ?? "").trim();
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "").trim();
    const content = typeof body.content === "string" ? body.content : undefined;
    const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : undefined;
    // Validate + resolve up front so the approval prompt shows the real path.
    validateResourceName(name);
    const skillDir = await resolveSkillDir(workspace.path, skill);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.resource.upsert",
      summary: `Attach ${name} to skill ${skill}`,
      paths: [join(skillDir, "resources", name)],
    });
    const result = await upsertSkillResource(workspace.path, skill, { name, content, contentBase64 });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.resource.upsert",
      target: result.path,
      summary: `Attached ${name} to skill ${skill}`,
      timestamp: Date.now(),
    });
    // The mutation rewrote the skill's SKILL.md section — reload like a skill edit.
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name: skill,
      action: "updated",
      path: result.skillPath,
    });
    return jsonResponse({ ok: true, name: result.name, path: result.path, action: result.action });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:skill/resources/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const skill = String(ctx.params.skill ?? "").trim();
    const name = String(ctx.params.name ?? "").trim();
    validateResourceName(name);
    const skillDir = await resolveSkillDir(workspace.path, skill);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.resource.delete",
      summary: `Remove ${name} from skill ${skill}`,
      paths: [join(skillDir, "resources", name)],
    });
    const result = await deleteSkillResource(workspace.path, skill, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.resource.delete",
      target: result.path,
      summary: `Removed ${name} from skill ${skill}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name: skill,
      action: "updated",
      path: result.skillPath,
    });
    return jsonResponse({ ok: true, name, path: result.path });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listMcp(config, workspace.id, workspace.path);
    return jsonResponse({ items, engineSync: engineMcpSyncState(workspace.id) });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const configPayload = body.config as Record<string, unknown> | undefined;
    if (!configPayload) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add MCP ${name}`,
      paths: [legalworkConfigPath(workspace.path)],
    });
    const result = await addMcp(config, workspace.id, name, configPayload);
    // Hot-add into the running engine so connect/auth works immediately,
    // without waiting for an engine instance rebuild.
    await syncRuntimeMcpToOpencodeEngine(config, workspace, [name]).catch(() => undefined);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: legalworkConfigPath(workspace.path),
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: result.action,
    });
    const items = await listMcp(config, workspace.id, workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [legalworkConfigPath(workspace.path)],
    });
    const removed = await removeMcp(config, workspace.id, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: legalworkConfigPath(workspace.path),
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      await disconnectMcpFromOpencodeEngine(config, workspace, name).catch(() => undefined);
      emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
        type: "mcp",
        name,
        action: "removed",
      });
    }
    const items = await listMcp(config, workspace.id, workspace.path);
    return jsonResponse({ items });
  });

  // Toggle `enabled` on a workspace MCP. Strict body validation — `Boolean(body.enabled)`
  // would silently disable on `{}` or coerce `"false"` to true.
  addRoute(routes, "POST", "/workspace/:id/mcp/:name/enabled", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
    }
    const enabled = body.enabled;
    const action = enabled ? "mcp.enable" : "mcp.disable";
    const summary = `${enabled ? "Enable" : "Disable"} MCP ${name}`;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action,
      summary,
      paths: [legalworkConfigPath(workspace.path)],
    });
    const updated = await setMcpEnabled(config, workspace.id, name, enabled);
    if (!updated) {
      throw new ApiError(404, "mcp_not_found", `MCP ${name} not found in workspace config`);
    }
    await syncRuntimeMcpToOpencodeEngine(config, workspace, [name]).catch(() => undefined);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: legalworkConfigPath(workspace.path),
      summary: `${enabled ? "Enabled" : "Disabled"} MCP ${name}`,
      timestamp: Date.now(),
    });
    // ReloadTrigger.action only allows added/removed/updated, so toggle => "updated".
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: "updated",
    });
    const items = await listMcp(config, workspace.id, workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name/auth", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);

    const authStorePath = join(homedir(), ".config", "opencode", "mcp-auth.json");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [authStorePath],
    });

    // Best-effort disconnect so any active connection is torn down.
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      unwrapOpencodeResult(await opencode.mcp.disconnect({ name }), `/mcp/${encodeURIComponent(name)}/disconnect`);
    } catch {
      // ignore
    }

    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      unwrapOpencodeResult(await opencode.mcp.auth.remove({ name }), `/mcp/${encodeURIComponent(name)}/auth`);
    } catch (error) {
      // Treat missing credentials as a successful logout (idempotent).
      if (
        error instanceof ApiError &&
        error.code === "opencode_request_failed" &&
        error.details &&
        typeof error.details === "object" &&
        "status" in (error.details as Record<string, unknown>) &&
        (error.details as { status?: unknown }).status === 404
      ) {
        // ok
      } else {
        throw error;
      }
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: authStorePath,
      summary: `Logged out MCP ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      await requireHost(ctx.request, config, tokens);
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listCommands(workspace.path, scope);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const path = await upsertCommand(workspace.path, {
      name,
      description: body.description ? String(body.description) : undefined,
      template,
      agent: body.agent ? String(body.agent) : undefined,
      model: body.model ? String(body.model) : undefined,
      subtask: typeof body.subtask === "boolean" ? body.subtask : undefined,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "updated",
      path,
    });
    const items = await listCommands(workspace.path, "workspace");
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "removed",
      path: join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sensitiveMode = parseWorkspaceExportSensitiveMode(ctx.url.searchParams.get("sensitive"));
    const exportPayload = await exportWorkspace(workspace, { sensitiveMode });
    return jsonResponse(exportPayload);
  });

  addRoute(routes, "POST", "/workspace/:id/import/preview", "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const preview = await buildWorkspaceImportPreview(workspace.path, body);
    return jsonResponse(publicWorkspaceImportPreview(preview));
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const expectedFingerprint = parseWorkspaceImportPreviewFingerprint(body);
    const preview = await buildWorkspaceImportPreview(workspace.path, body);
    if (expectedFingerprint && expectedFingerprint !== preview.fingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_stale",
          message: "Workspace changed after this import was previewed. Review the latest preview before importing.",
          preview: publicWorkspaceImportPreview(preview),
        },
        409,
      );
    }
    const approvalPaths = workspaceImportPreviewApprovalPaths(preview);
    if (approvalPaths.length === 0) {
      return jsonResponse({ ok: true, preview: publicWorkspaceImportPreview(preview) });
    }
    if (!expectedFingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_required",
          message: "Review this import preview before applying workspace changes.",
          preview: publicWorkspaceImportPreview(preview),
        },
        409,
      );
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: summarizeWorkspaceImportPreview(preview),
      paths: approvalPaths,
    });
    const latestPreview = await buildWorkspaceImportPreview(workspace.path, body);
    if (latestPreview.fingerprint !== expectedFingerprint) {
      return jsonResponse(
        {
          ok: false,
          code: "workspace_import_preview_stale",
          message: "Workspace changed after this import was previewed. Review the latest preview before importing.",
          preview: publicWorkspaceImportPreview(latestPreview),
        },
        409,
      );
    }
    const configFingerprintBefore = await computeReloadFingerprint(workspace.path, "config");
    await importWorkspace(workspace, body, latestPreview);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: summarizeWorkspaceImportApplied(latestPreview),
      timestamp: Date.now(),
    });
    if (configFingerprintBefore !== await computeReloadFingerprint(workspace.path, "config")) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    }
    return jsonResponse({ ok: true, preview: publicWorkspaceImportPreview(latestPreview) });
  });

  addRoute(routes, "POST", "/workspace/:id/blueprint/sessions/materialize", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await materializeBlueprintSessions(config, workspace);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "blueprint.sessions.materialize",
      target: "workspace",
      summary: result.created.length
        ? `Materialized ${result.created.length} template starter session${result.created.length === 1 ? "" : "s"}`
        : "Checked template starter sessions",
      timestamp: Date.now(),
    });
    return jsonResponse(result);
  });

  return routes;
}

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspaceId = id.trim();
  const aliasWorkspaceId = workspaceId.startsWith("rem_") ? workspaceId.slice("rem_".length) : "";
  const workspace =
    config.workspaces.find((entry) => entry.id === workspaceId) ??
    (aliasWorkspaceId ? config.workspaces.find((entry) => entry.id === aliasWorkspaceId) : undefined);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = await isAuthorizedRoot(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  if (!config.readOnly) {
    const ensured = await ensureWorkspaceFiles(resolvedWorkspace, workspace.preset ?? "starter");
    const bootstrapReloadReasons = new Set<ReloadReason>(ensured.reloadReasons);
    if (await repairCommands(resolvedWorkspace)) {
      bootstrapReloadReasons.add("commands");
    }
    if (bootstrapReloadReasons.size > 0) {
      await reloadBaselineRefreshers.get(config)?.(workspace.id, Array.from(bootstrapReloadReasons));
      reloadOpencodeEngineAfterInternalBootstrap(config, { ...workspace, path: resolvedWorkspace });
    }
  }
  return { ...workspace, path: resolvedWorkspace };
}

function reloadOpencodeEngineAfterInternalBootstrap(config: ServerConfig, workspace: WorkspaceInfo): void {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  if (!connection.baseUrl?.trim()) return;
  void reloadOpencodeEngine(config, workspace).catch(() => undefined);
}

async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const resolvedWorkspace = resolve(workspacePath);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

function scopeRank(scope: TokenScope): number {
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

function requireClientScope(ctx: RequestContext, required: TokenScope): void {
  const scope = ctx.actor?.scope;
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Missing token scope");
  }
  if (scopeRank(scope) < scopeRank(required)) {
    throw new ApiError(403, "forbidden", "Insufficient token scope", { required, scope });
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const json = await request.json();
    return json as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

async function readJsonBodyLimited(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "request_too_large", `Request body exceeds ${maxBytes} bytes.`);
  }
  if (!request.body) throw new ApiError(400, "invalid_json", "JSON body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "request_too_large", `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return ensurePlainObject(parsed);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

async function readOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return ensurePlainObject(JSON.parse(text));
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function parseOptionalPositiveInteger(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ApiError(400, "invalid_query", `${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_query", `${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalBoolean(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ApiError(400, "invalid_query", `${name} must be a boolean`);
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeOpencodeScope(value: string | null | undefined): "project" | "global" {
  return value?.trim().toLowerCase() === "global" ? "global" : "project";
}

function resolveOpencodeConfigFilePath(scope: "project" | "global", workspaceRoot: string): string {
  if (scope === "global") {
    const base = join(homedir(), ".config", "opencode");
    const jsoncPath = join(base, "opencode.jsonc");
    const jsonPath = join(base, "opencode.json");
    if (existsSync(jsoncPath)) return jsoncPath;
    if (existsSync(jsonPath)) return jsonPath;
    return jsoncPath;
  }
  return opencodeConfigPath(workspaceRoot);
}

function getRuntimeControlConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.LEGALWORK_CONTROL_BASE_URL?.trim() ?? "";
  const token = process.env.LEGALWORK_CONTROL_TOKEN?.trim() ?? "";
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

async function fetchRuntimeControl(path: string, init?: { method?: string; body?: unknown }) {
  const control = getRuntimeControlConfig();
  if (!control) {
    throw new ApiError(501, "runtime_upgrade_unavailable", "Worker runtime control is not configured on this host");
  }
  const response = await fetch(`${control.baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${control.token}`,
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, "runtime_upgrade_failed", "Worker runtime control request failed", json);
  }
  return json;
}

async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  return data;
}

async function readLegalworkConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = legalworkConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse legalwork.json");
  }
}

async function readLegalworkConfigForStatus(workspaceRoot: string): Promise<{
  data: Record<string, unknown>;
  error: string | null;
}> {
  try {
    return { data: await readLegalworkConfig(workspaceRoot), error: null };
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_json") {
      return { data: {}, error: error.message };
    }
    throw error;
  }
}

function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) return normalizeOpencodeDirectory(explicit);
  if (workspace.workspaceType === "local") return normalizeOpencodeDirectory(workspace.path);
  return null;
}

function normalizeOpencodeDirectory(directory: string): string {
  // OpenCode stores/list-filters Windows sessions by regular drive paths
  // (`C:\Users\...`). Electron can persist local workspaces as extended-length
  // paths (`\\?\C:\Users\...`); passing those through as the directory query
  // makes OpenCode return an empty session list even though the sessions exist.
  if (process.platform === "win32") {
    return directory.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  }
  return directory;
}

function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = "/instance/dispose";
    url.search = "";
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "opencode_url_invalid", "OpenCode base URL is invalid");
  }
}

function parseOpencodeErrorBody(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

async function reloadOpencodeEngine(config: ServerConfig, workspace: WorkspaceInfo): Promise<void> {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const directory = resolveOpencodeDirectory(workspace);
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);
  const headers: Record<string, string> = {};
  const auth = connection.authHeader ?? null;
  if (auth) headers.Authorization = auth;

  const response = await fetch(targetUrl, { method: "POST", headers });
  if (!response.ok) {
    const body = parseOpencodeErrorBody(await response.text());
    throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
      status: response.status,
      body,
    });
  }

  // Re-register runtime-DB MCPs: dispose rebuilds engine state from disk
  // configs (including the server-managed runtime config file for the
  // primary workspace), but other workspaces' runtime MCPs only reach the
  // engine through this dynamic push.
  await syncRuntimeMcpToOpencodeEngine(config, workspace).catch(() => undefined);
}

// Push runtime-DB MCP entries into the running OpenCode engine via its dynamic
// add endpoint, so adds/toggles take effect without waiting for an engine
// instance rebuild. Best-effort: callers treat engine sync as advisory and
// swallow failures; outcomes are recorded per workspace (engineMcpSyncState)
// and logged so failures aren't silent.
async function syncRuntimeMcpToOpencodeEngine(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  onlyNames?: string[],
): Promise<void> {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  if (!baseUrl) return;

  const runtimeConfig = await readRuntimeOpencodeConfig(config, workspace.id);
  const entries = Object.entries(runtimeMcpMap(runtimeConfig)).filter(
    ([name]) => !onlyNames || onlyNames.includes(name),
  );
  if (entries.length === 0) return;

  const url = new URL(baseUrl);
  url.pathname = "/mcp";
  url.search = "";
  const directory = resolveOpencodeDirectory(workspace);
  if (directory) url.searchParams.set("directory", directory);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (connection.authHeader) headers.Authorization = connection.authHeader;

  // Keep going past per-entry failures: one dead or invalid MCP must not
  // block re-registration of every entry after it (e.g. legalwork-ui) on
  // each engine reload.
  const failures: EngineMcpSyncFailure[] = [];
  for (const [name, mcpConfig] of entries) {
    const failure = await postMcpEntryWithRetry(url, headers, name, mcpConfig);
    if (failure) failures.push(failure);
  }

  recordEngineMcpSyncResult(workspace.id, {
    syncedNames: entries.map(([name]) => name),
    failures,
    // A full sync covered every runtime entry, so its result replaces any
    // previously recorded failures (e.g. for since-removed MCPs).
    replace: !onlyNames,
  });

  if (failures.length > 0) {
    const names = failures.map((failure) => failure.name).join(", ");
    createServerLogger(config).log("warn", `Engine MCP sync failed for workspace ${workspace.id}: ${names}`, {
      "workspace.id": workspace.id,
      "mcp.failed": names,
    });
    throw new ApiError(502, "opencode_mcp_sync_failed", `Failed to register MCPs with the engine: ${names}`, {
      failures,
    });
  }
}

// POST one MCP entry to the engine, retrying once on 5xx/network errors
// (the engine is often mid-rebuild right after a dispose). 4xx responses
// are not retried — they won't change.
async function postMcpEntryWithRetry(
  url: URL,
  headers: Record<string, string>,
  name: string,
  mcpConfig: Record<string, unknown>,
): Promise<EngineMcpSyncFailure | null> {
  let failure: EngineMcpSyncFailure | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, engineMcpSyncRetryDelayMs()));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, config: mcpConfig }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return null;
      failure = { name, status: response.status, body: parseOpencodeErrorBody(await response.text()) };
      if (response.status < 500) return failure;
    } catch (error) {
      failure = { name, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return failure;
}

// Read lazily so tests can shrink the delay at runtime.
function engineMcpSyncRetryDelayMs(): number {
  const parsed = Number(process.env.LEGALWORK_MCP_SYNC_RETRY_DELAY_MS ?? "750");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 750;
}

export type EngineMcpSyncFailure = { name: string; status?: number; body?: unknown; message?: string };
export type EngineMcpSyncState = { status: "ok" | "failed"; at: number; failures: EngineMcpSyncFailure[] };

// Last engine sync outcome per workspace, surfaced on GET /workspace/:id/mcp
// so the UI can explain why an enabled MCP shows as disconnected instead of
// failing silently.
const engineMcpSyncStateByWorkspace = new Map<string, EngineMcpSyncState>();

function recordEngineMcpSyncResult(
  workspaceId: string,
  result: { syncedNames: string[]; failures: EngineMcpSyncFailure[]; replace: boolean },
): void {
  const previous = engineMcpSyncStateByWorkspace.get(workspaceId);
  // Partial syncs (onlyNames) shouldn't clear recorded failures for entries
  // they didn't touch; merge by name instead.
  const remaining = result.replace
    ? []
    : (previous?.failures ?? []).filter((failure) => !result.syncedNames.includes(failure.name));
  const merged = [...remaining, ...result.failures];
  engineMcpSyncStateByWorkspace.set(workspaceId, {
    status: merged.length > 0 ? "failed" : "ok",
    at: Date.now(),
    failures: merged,
  });
}

export function engineMcpSyncState(workspaceId: string): EngineMcpSyncState | null {
  return engineMcpSyncStateByWorkspace.get(workspaceId) ?? null;
}

// Re-push every workspace's runtime-DB MCPs into the engine. Used at startup:
// the runtime config file injected via OPENCODE_CONFIG covers workspaces[0]
// only, so other workspaces' runtime MCPs are invisible to the engine until
// something re-syncs them. Best-effort.
export async function syncAllWorkspacesRuntimeMcpToEngine(config: ServerConfig): Promise<void> {
  for (const workspace of config.workspaces) {
    await syncRuntimeMcpToOpencodeEngine(config, workspace).catch(() => undefined);
  }
}

// Counterpart of syncRuntimeMcpToOpencodeEngine for removals: tell the engine
// to drop the MCP's client so deleted MCPs stop serving tools immediately
// instead of lingering until the next engine restart. Best-effort.
async function disconnectMcpFromOpencodeEngine(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  name: string,
): Promise<void> {
  const connection = resolveWorkspaceOpencodeConnection(config, workspace);
  const baseUrl = connection.baseUrl?.trim() ?? "";
  if (!baseUrl) return;

  const url = new URL(baseUrl);
  url.pathname = `/mcp/${encodeURIComponent(name)}/disconnect`;
  url.search = "";
  const directory = resolveOpencodeDirectory(workspace);
  if (directory) url.searchParams.set("directory", directory);
  const headers: Record<string, string> = {};
  if (connection.authHeader) headers.Authorization = connection.authHeader;

  const response = await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = parseOpencodeErrorBody(await response.text());
    throw new ApiError(502, "opencode_mcp_disconnect_failed", `Failed to disconnect MCP ${name} from the engine`, {
      status: response.status,
      body,
    });
  }
}

async function writeLegalworkConfig(workspaceRoot: string, payload: Record<string, unknown>, merge: boolean): Promise<void> {
  const path = legalworkConfigPath(workspaceRoot);
  const next = merge ? { ...(await readLegalworkConfig(workspaceRoot)), ...payload } : payload;
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

async function exportWorkspace(
  workspace: WorkspaceInfo,
  options?: { sensitiveMode?: WorkspaceExportSensitiveMode },
) {
  const sensitiveMode = options?.sensitiveMode ?? "auto";
  const rawOpencode = await readOpencodeConfig(workspace.path);
  let opencode = sanitizePortableOpencodeConfig(rawOpencode);
  const legalwork = sanitizeLegalworkTemplateConfig(await readLegalworkConfig(workspace.path));
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  let files = await listPortableFiles(workspace.path);
  const warnings = collectWorkspaceExportWarnings({ opencode: rawOpencode, files });
  if (warnings.length && sensitiveMode === "auto") {
    throw new ApiError(
      409,
      "workspace_export_requires_decision",
      "This workspace includes sensitive config. Choose whether to exclude it or include it before exporting.",
      { warnings },
    );
  }
  if (sensitiveMode === "exclude") {
    const sanitized = stripSensitiveWorkspaceExportData({ opencode, files });
    opencode = sanitized.opencode;
    files = sanitized.files;
  }
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    legalwork,
    skills: skillContents,
    commands: commandContents,
    ...(files.length ? { files } : {}),
  };
}

function parseWorkspaceExportSensitiveMode(input: string | null): WorkspaceExportSensitiveMode {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "auto";
  if (trimmed === "auto" || trimmed === "include" || trimmed === "exclude") {
    return trimmed;
  }
  throw new ApiError(400, "invalid_workspace_export_sensitive_mode", `Invalid workspace export sensitive mode: ${trimmed}`);
}

function parseWorkspaceImportPreviewFingerprint(payload: Record<string, unknown>): string | null {
  const value = payload.previewFingerprint;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "invalid_workspace_import_preview_fingerprint",
      "Workspace import preview fingerprint must be a string",
    );
  }
  return value;
}

function workspaceImportRelativePath(workspace: WorkspaceInfo, path: string): string {
  return relative(workspace.path, path).replaceAll("\\", "/");
}

async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>, preview: WorkspaceImportPlan): Promise<void> {
  const input = normalizeWorkspaceImportPayload(workspace.path, payload);
  const changed = new Set(
    preview.changes
      .filter((change) => change.action !== "unchanged")
      .map((change) => `${change.kind}:${change.path}`),
  );
  const changedPath = (kind: string, path: string) => changed.has(`${kind}:${path}`);

  if (
    input.opencode !== undefined &&
    changedPath("opencode", workspaceImportRelativePath(workspace, opencodeConfigPath(workspace.path)))
  ) {
    if (input.modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), input.opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), input.opencode);
    }
  }

  if (
    input.legalwork !== undefined &&
    changedPath("legalwork", workspaceImportRelativePath(workspace, legalworkConfigPath(workspace.path)))
  ) {
    if (input.modes.legalwork === "replace") {
      await writeLegalworkConfig(workspace.path, input.legalwork, false);
    } else {
      await writeLegalworkConfig(workspace.path, input.legalwork, true);
    }
  }

  if (input.sections.skills) {
    for (const skill of input.skills) {
      const path = workspaceImportRelativePath(workspace, join(projectSkillsDir(workspace.path), skill.name, "SKILL.md"));
      if (!changedPath("skill", path)) continue;
      await upsertSkill(workspace.path, skill);
    }
    if (input.modes.skills === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "skill" && change.action === "delete") {
          await rm(change.absolutePath, { recursive: true, force: true });
        }
      }
    }
  }

  if (input.sections.commands) {
    for (const command of input.commands) {
      const path = workspaceImportRelativePath(workspace, join(projectCommandsDir(workspace.path), `${command.name}.md`));
      if (!changedPath("command", path)) continue;
      await upsertCommand(workspace.path, command);
    }
    if (input.modes.commands === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "command" && change.action === "delete") {
          await rm(change.absolutePath, { force: true });
        }
      }
    }
  }

  if (input.sections.files) {
    for (const file of input.files) {
      if (!changedPath("file", file.path)) continue;
      const path = join(workspace.path, file.path);
      await ensureDir(dirname(path));
      await writeFile(path, file.content, "utf8");
    }
    if (input.modes.files === "replace") {
      for (const change of preview.changes) {
        if (change.kind === "file" && change.action === "delete") {
          await rm(change.absolutePath, { force: true });
        }
      }
    }
  }
}

async function materializeBlueprintSessions(config: ServerConfig, workspace: WorkspaceInfo): Promise<{
  ok: boolean;
  created: Array<{ templateId: string; sessionId: string; title: string }>;
  existing: Array<{ templateId: string; sessionId: string }>;
  openSessionId: string | null;
}> {
  const legalwork = await readLegalworkConfig(workspace.path);
  const templates = normalizeBlueprintSessionTemplates(legalwork);
  if (!templates.length) {
    return { ok: true, created: [], existing: [], openSessionId: null };
  }

  const existing = readMaterializedBlueprintSessions(legalwork);
  if (existing.length > 0) {
    const preferredTemplate = templates.find((template) => template.openOnFirstLoad) ?? templates[0] ?? null;
    const openSessionId = preferredTemplate
      ? existing.find((item) => item.templateId === preferredTemplate.id)?.sessionId ?? existing[0]?.sessionId ?? null
      : existing[0]?.sessionId ?? null;
    return { ok: true, created: [], existing, openSessionId };
  }

  const created: Array<{ templateId: string; sessionId: string; title: string }> = [];
  const opencode = createWorkspaceOpencodeClient(config, workspace);
  for (const template of templates) {
    const result = unwrapOpencodeResult(await opencode.session.create({ title: template.title }), "/session");
    const sessionId =
      result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id.trim() : "";
    if (!sessionId) {
      throw new ApiError(502, "opencode_failed", "OpenCode session did not return an id");
    }
    seedOpencodeSessionMessages({
      sessionId,
      workspaceRoot: resolveOpencodeDirectory(workspace) ?? workspace.path,
      messages: template.messages,
    });
    created.push({ templateId: template.id, sessionId, title: template.title });
  }

  const now = Date.now();
  const nextLegalwork = applyMaterializedBlueprintSessions(
    legalwork,
    created.map(({ templateId, sessionId }) => ({ templateId, sessionId })),
    now,
  );
  await writeLegalworkConfig(workspace.path, nextLegalwork, false);

  const preferredTemplate = templates.find((template) => template.openOnFirstLoad) ?? templates[0] ?? null;
  const openSessionId = preferredTemplate
    ? created.find((item) => item.templateId === preferredTemplate.id)?.sessionId ?? created[0]?.sessionId ?? null
    : created[0]?.sessionId ?? null;

  return { ok: true, created, existing: [], openSessionId };
}
