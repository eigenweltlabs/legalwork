/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { LearningsPane } from "./learnings-route";
import { RecorderPane } from "../domains/recorder/recorder-pane";
import {
  RECORDER_TRANSCRIPT_EVENT,
  registerRecorderCopilotContext,
  useRecorderStore,
} from "../domains/recorder/recorder-store";
import { toast } from "@/components/ui/sonner";
import type {
  AgentPartInput,
  FilePartInput,
  ProviderListResponse,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import { analyticsSurface, captureAnalyticsEvent, markTaskRunStart } from "@/app/lib/analytics";
import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSessionSafe, forkSession, listCommands, revertSession, setSessionArchived, shellInSession } from "@/app/lib/opencode-session";
import { useSessionManagementStore as sessionManagementStore } from "@/react-app/domains/session/sidebar/session-management-store";
import {
  buildLegalworkWorkspaceBaseUrl,
  createLegalworkServerClient,
  readLegalworkServerSettings,
  type LegalworkServerClient,
  type LegalworkWorkspaceInfo,
} from "@/app/lib/legalwork-server";
import {
  resolveWorkspaceEndpoint,
  workspaceServerId,
  type ResolvedWorkspaceEndpoint,
} from "@/app/lib/workspace-endpoint";
import { buildLegalworkEnvRuntimeKey } from "@/app/lib/legalwork-env-runtime";
import {
  revealDesktopItemInDir,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type LegalworkServerInfo,
  type WorkspaceInfo,
  type WorkspaceList,
} from "@/app/lib/desktop";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ModelOption,
  ModelRef,
  SlashCommandOption,
  WorkspacePreset,
  WorkspaceConnectionState,
  ProviderListItem,
  WorkspaceDisplay,
  WorkspaceSessionGroup,
} from "@/app/types";
import {
  getWorkspaceTaskLoadErrorDisplay,
  isDesktopRuntime,
  isOfficeAddinRuntime,
  isSandboxWorkspace,
  normalizeDirectoryPath,
  normalizeSessionStatus,
  resolveModelDisplayName,
  safeStringify,
} from "@/app/utils";
import { t } from "@/i18n";
import {
  type RouteWorkspace,
  type RouteSession,
  describeRouteError,
  describeWorkspaceCreateError,
  downloadWorkspaceJson,
  folderNameFromPath,
  getSessionStatus,
  isActiveSessionStatus,
  isTransientStartupError,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  toSessionGroups,
  workspaceExportFilename,
  workspaceLabel,
} from "@/react-app/shell/route-workspaces";
import { useLocal } from "@/react-app/kernel/local-provider";
import { usePlatform } from "@/react-app/kernel/platform";
import { SessionPage, type OpenSessionTab } from "@/react-app/domains/session/chat/session-page";
import { ReactSessionRuntime } from "@/react-app/domains/session/sync/runtime-sync";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { buildLegalworkEnvSystemContext } from "@/react-app/domains/session/sync/env-context";
import {
  applySessionRevert,
} from "@/react-app/domains/session/sync/session-sync";
import { firstLineLocalFileParts } from "@/react-app/domains/session/sync/prompt-file-parts";
import { useSessionInteractions } from "@/react-app/domains/session/sync/use-session-interactions";
import { useModelBehavior } from "@/react-app/domains/session/surface/use-model-behavior";
import { runFusionSend } from "@/react-app/domains/session/fusion/fusion-controller";
import { getFusionSelectedModels, isFusionEnabled } from "@/react-app/domains/session/fusion/fusion-store";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import { appMentionInstruction } from "@/react-app/domains/session/surface/composer/app-mentions";
import { CreateWorkspaceModal } from "@/react-app/domains/workspace/create-workspace-modal";
import { useSessionProviderAuth } from "@/react-app/domains/connections/provider-auth/use-session-provider-auth";
import { ProviderSelectionStep } from "@/react-app/domains/onboarding/provider-selection-step";
import { TemplateWorkflowsStep } from "@/react-app/domains/onboarding/template-workflows-step";
import { TranscriptionSetupStep } from "@/react-app/domains/onboarding/transcription-setup-step";
import {
  ensureTemplateWorkflowWatcher,
  startTemplateWorkflowGeneration,
  useHiddenTemplateWorkspaceIds,
  useTemplateWorkflowRun,
} from "@/react-app/domains/settings/state/template-workflow-generation";
import { useMcpConnectedCount } from "@/react-app/domains/connections/use-mcp-connected-count";
import { RenameWorkspaceModal } from "@/react-app/domains/workspace/rename-workspace-modal";
import { ModelPickerModal } from "@/react-app/domains/session/modals/model-picker-modal";
import { CommandPalette, type PaletteItem, type SessionGroupOption, type SessionOption as PaletteSessionOption } from "./command-palette";
import { SessionSearchDialog } from "./session-search-dialog";
import { WhatsNewDialog } from "./whats-new";
import { TranscriptionIntroDialog } from "./transcription-intro";
import type { SessionMessageFetcher } from "@/react-app/domains/session/search/session-search";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { useBootState } from "./boot-state";
import {
  forgetWorkspaceMemory,
  readActiveWorkspaceId,
  readLastSessionFor,
  readWorkspaceOrderIds,
  writeActiveWorkspaceId,
  writeLastSessionFor,
  writeWorkspaceOrderIds,
} from "./session-memory";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "../../app/lib/app-inspector";
import { saveSessionDraft } from "@/react-app/domains/session/sync/draft-store";
import { useControlAction, type LegalworkControlAction } from "./control/control-provider";
import { useReactRenderWatchdog } from "./react-render-watchdog";

import { filterProviderList } from "@/app/utils/providers";
import { ensureDesktopLocalLegalworkConnection } from "./desktop-local-legalwork";
import { resolveLegalworkConnection } from "./legalwork-connection";
import { useReloadCoordinator } from "./reload-coordinator";
import { useShellConfig } from "./shell-config";
import { useShellShortcuts } from "./use-shell-shortcuts";
import { useEngineReload } from "./use-engine-reload";
import { useSessionGroupSync } from "./use-session-group-sync";
import { useWorkspaceRouteState } from "./use-workspace-route-state";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useSessionControlActions } from "@/react-app/domains/session/control/session-control-actions";
import { legacySessionRoute, workspaceSessionRoute, workspaceSettingsRoute } from "./workspace-routes";
import { WorkspaceProvider } from "./workspace-provider";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { SettingsSurface } from "./settings-route";
import {
  ensureProviderListQuery,
  getConnectedProviderItems,
  isFreeOpencodeModel,
  isModelAvailableInConnectedProviders,
  refreshProviderListQueries,
  remapZenSelectionToEigenweltFree,
  useProviderListQuery,
} from "@/react-app/infra/provider-list-query";

/**
 * Serialize an SDK error value into a string that parseSessionError can parse.
 * Preserves the original shape (name, data, message) as JSON when possible,
 * so the session surface can detect ProviderModelNotFoundError and offer
 * recovery actions like "Change model".
 */
function serializeSDKError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      const msg = (error as Record<string, unknown>).message;
      return typeof msg === "string" ? msg : String(error);
    }
  }
  return String(error);
}

function describeTaskCreateError(error: unknown) {
  const message = describeRouteError(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("failed to fetch") ||
    lower.includes("connection") ||
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("connection lost") ||
    lower.includes("internal_error") ||
    lower.includes("unexpected server error")
  ) {
    return "OpenCode is unavailable for this workspace. Retry once it restarts, or restart LegalWork if the problem continues.";
  }
  return message;
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("legalwork:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

// All workspace-scoped server URLs/clients/tokens come from
// `resolveWorkspaceEndpoint` in apps/app/src/app/lib/workspace-endpoint.ts.
// Don't compose `<baseUrl>/workspace/<id>` here.

async function fileToDataUrl(file: File, mimeType: string) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read attachment: ${file.name}`));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(new Blob([file], { type: mimeType }));
  });
}

function attachmentMime(attachment: ComposerAttachment) {
  if (attachment.kind === "image") return attachment.mimeType;
  if (attachment.mimeType === "application/pdf") return attachment.mimeType;
  // Everything else is sent as text; unsupported binary mimes poison
  // server-side session history (see sync/attachment-support.ts).
  return "text/plain";
}

async function draftToParts(draft: ComposerDraft, workspaceRoot: string) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
    if (!root) return "";
    return `${root}/${trimmed}`.replace(/\/\/+/g, "/");
  };

  const filenameFromPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "file";
  };

  for (const part of draft.parts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "paste") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "agent") {
      parts.push({ type: "agent", name: part.name });
      continue;
    }
    if (part.type === "skill") {
      parts.push({ type: "text", text: `Load [skill ${part.name}] and follow its instructions.` });
      continue;
    }
    if (part.type === "app") {
      parts.push({ type: "text", text: appMentionInstruction(part.name) });
      continue;
    }
    if (part.type === "file") {
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      });
    }
  }

  parts.push(...firstLineLocalFileParts(draft.resolvedText ?? draft.text, root));

  parts.push(
    ...(await Promise.all(
      draft.attachments.map(async (attachment) => {
        const mime = attachmentMime(attachment);
        return {
          type: "file" as const,
          url: await fileToDataUrl(attachment.file, mime),
          filename: attachment.name,
          mime,
        };
      }),
    )),
  );

  return parts;
}

export function SessionRoute() {
  const navigate = useNavigate();
  const [showLearnings, setShowLearnings] = useState(false);
  // Top-level pages that live in the main shell (sidebar stays, main pane swaps),
  // same mechanism as Learnings. Mutually exclusive — only one main pane at a time.
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [showExtensions, setShowExtensions] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);
  const showLearningsPane = useCallback(() => {
    setShowLearnings(true);
    setShowWorkflows(false);
    setShowExtensions(false);
    setShowRecorder(false);
  }, []);
  const showWorkflowsPane = useCallback(() => {
    setShowWorkflows(true);
    setShowLearnings(false);
    setShowExtensions(false);
    setShowRecorder(false);
  }, []);
  const showExtensionsPane = useCallback(() => {
    setShowExtensions(true);
    setShowLearnings(false);
    setShowWorkflows(false);
    setShowRecorder(false);
  }, []);
  const showRecorderPane = useCallback(() => {
    setShowRecorder(true);
    setShowLearnings(false);
    setShowWorkflows(false);
    setShowExtensions(false);
  }, []);
  const platform = usePlatform();
  const { config: shellConfig } = useShellConfig();
  const local = useLocal();
  const reloadCoordinator = useReloadCoordinator();
  const [legalworkServerHostInfoState, setLegalworkServerHostInfoState] = useState<LegalworkServerInfo | null>(null);
  const [legalworkServerSettingsVersion, setLegalworkServerSettingsVersion] = useState(0);
  const {
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    loading,
    effectiveLoading,
    client,
    baseUrl,
    token,
    workspaces,
    setWorkspaces,
    workspacesRef,
    workspaceOrderIds,
    setWorkspaceOrderIds,
    workspaceOrderIdsRef,
    sessionsByWorkspaceId,
    setSessionsByWorkspaceId,
    sessionsByWorkspaceIdRef,
    errorsByWorkspaceId,
    setErrorsByWorkspaceId,
    workspaceConnectionOverrides,
    routeError,
    setRouteError,
    legacySelectedWorkspaceId,
    setLegacySelectedWorkspaceId,
    retryingWorkspaceIds,
    setRetryingWorkspaceIds,
    refreshInFlightRef,
    startupRetryTimerRef,
    selectedWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceRoot,
    selectedWorkspaceEndpoint,
    selectedWorkspaceServerToken,
    opencodeBaseUrl,
    opencodeClient,
    selectedWorkspaceIsLoading,
    selectedWorkspaceError,
    routeNotFoundMessage,
    endpointForWorkspace,
    refreshRouteState,
    loadWorkspaceSessionsInBackground,
    rememberPendingCreatedSession,
    handleRuntimeSessionUpdated,
  } = useWorkspaceRouteState({
    onServerSettingsChanged: () => setLegalworkServerSettingsVersion((value) => value + 1),
    onHostInfo: setLegalworkServerHostInfoState,
  });
  // Agent selection is persisted in local prefs (like the model variant) so
  // it survives reloads instead of silently falling back to "build" (#2101).
  const selectedAgent = local.prefs.selectedAgent;
  const setSelectedAgent = useCallback(
    (agent: string | null) => {
      local.setPrefs((previous) => ({ ...previous, selectedAgent: agent }));
    },
    [local.setPrefs],
  );
  // One-way latch for "a refreshRouteState is currently running"; prevents
  // overlapping route refreshes from queueing up when the user clicks fast.
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [developerMode, setDeveloperMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("legalwork.developerMode") === "1";
  });
  const [paletteAccessibleTargets, setPaletteAccessibleTargets] = useState<OpenTarget[]>([]);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [disabledProviderIds, setDisabledProviderIds] = useState<string[]>([]);

  // Provider IDs that were just added — used to highlight them as
  useEffect(() => {
    setPaletteAccessibleTargets([]);
  }, [selectedSessionId, selectedWorkspaceId]);

  // Provider catalog cache. Used to compute the reasoning/thinking variant
  // options for whichever model is currently selected so the composer's
  // behavior pill actually shows its options (bug: was empty before).

  const legalworkServerSettings = useMemo(
    () => readLegalworkServerSettings(),
    [legalworkServerSettingsVersion],
  );

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .flatMap((session) => {
          if (!isActiveSessionStatus(getSessionStatus(session))) return [];
          const id = String(session?.id ?? "");
          if (!id) return [];
          return [{
            id,
            title:
              String(session?.title ?? session?.slug ?? session?.id ?? "").trim() ||
              t("session.untitled"),
          }];
        }),
    [sessionsByWorkspaceId],
  );
  const activeSelectedWorkspaceSessionIds = useMemo(
    () =>
      (sessionsByWorkspaceId[selectedWorkspaceId] ?? []).flatMap((session) => {
        if (!isActiveSessionStatus(getSessionStatus(session))) return [];
        const id = String(session?.id ?? "").trim();
        return id ? [id] : [];
      }),
    [selectedWorkspaceId, sessionsByWorkspaceId],
  );

  const { engineReloadVersion, routeEngineInfo, reloadWorkspaceEngineFromUi } = useEngineReload({
    client,
    workspaceId: selectedWorkspaceId,
    workspace: selectedWorkspace,
    endpointForWorkspace,
    activeReloadBlockingSessions,
    onError: setRouteError,
    refreshRouteState,
  });

  const environmentRuntimeKey = useMemo(
    () => buildLegalworkEnvRuntimeKey({
      baseUrl: client?.baseUrl ?? null,
      pid: legalworkServerHostInfoState?.pid ?? null,
      port: legalworkServerHostInfoState?.port ?? null,
    }),
    [client?.baseUrl, legalworkServerHostInfoState?.pid, legalworkServerHostInfoState?.port],
  );

  const handleApplyEnvironmentChanges = useCallback(async () => {
    if (!isDesktopRuntime()) {
      throw new Error(t("settings.environment.apply_unavailable"));
    }
    if (activeReloadBlockingSessions.length > 0) {
      throw new Error(t("settings.environment.apply_blocked_active_tasks"));
    }
    if (!selectedWorkspaceRoot) {
      throw new Error(t("settings.environment.apply_no_local_workspace"));
    }
    const reloaded = await reloadWorkspaceEngineFromUi();
    if (!reloaded) {
      throw new Error(t("app.error_connect_first"));
    }
  }, [activeReloadBlockingSessions.length, reloadWorkspaceEngineFromUi, selectedWorkspaceRoot]);

  // Templates workspaces (created by workflow generation) are utility plumbing:
  // they stay out of the sidebar; their session is reached via the Workflows
  // progress banner. Route resolution keeps using the unfiltered list so that
  // navigation still works.
  const hiddenTemplateWorkspaceIds = useHiddenTemplateWorkspaceIds();
  const sidebarWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !hiddenTemplateWorkspaceIds.includes(workspace.id)),
    [hiddenTemplateWorkspaceIds, workspaces],
  );
  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(sidebarWorkspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set(retryingWorkspaceIds)),
    [errorsByWorkspaceId, retryingWorkspaceIds, sessionsByWorkspaceId, sidebarWorkspaces],
  );
  useSessionGroupSync({ workspaces, endpointForWorkspace });
  const selectedWorkspaceGroupState = sessionManagementStore((state) => (
    selectedWorkspaceId ? state.groupsByWorkspace[selectedWorkspaceId] : undefined
  ));
  const assignSessionToGroup = sessionManagementStore((state) => state.assignGroup);
  const seedWorkspaceActivitySessions = useSessionActivityStore((state) => state.seedWorkspaceSessions);
  const sessionActivityByWorkspaceId = useSessionActivityStore((state) => state.statusesByWorkspaceId);

  useEffect(() => {
    for (const group of workspaceSessionGroups) {
      seedWorkspaceActivitySessions(group.workspace.id, group.sessions);
      const serverId = workspaceServerId(group.workspace);
      if (serverId && serverId !== group.workspace.id) {
        seedWorkspaceActivitySessions(serverId, group.sessions);
      }
    }
  }, [seedWorkspaceActivitySessions, workspaceSessionGroups]);

  const sidebarSessionStatusById = useMemo(() => {
    const next: Record<string, string> = {};
    for (const group of workspaceSessionGroups) {
      const serverId = workspaceServerId(group.workspace);
      const workspaceStatuses = {
        ...(sessionActivityByWorkspaceId[group.workspace.id] ?? {}),
        ...(serverId ? sessionActivityByWorkspaceId[serverId] ?? {} : {}),
      };
      for (const session of group.sessions) {
        const status = workspaceStatuses[session.id];
        if (status) next[session.id] = status;
      }
    }
    return next;
  }, [sessionActivityByWorkspaceId, workspaceSessionGroups]);

  const sidebarActiveWorkspaceId = useMemo(() => {
    const sessionId = selectedSessionId?.trim() ?? "";
    if (sessionId) {
      const owner = workspaceSessionGroups.find((group) =>
        group.sessions.some((session) => session?.id === sessionId),
      );
      if (owner?.workspace.id) return owner.workspace.id;
    }
    return selectedWorkspaceId;
  }, [selectedSessionId, selectedWorkspaceId, workspaceSessionGroups]);

  const workspaceConnectionStateById = useMemo(() => {
    const next: Record<string, WorkspaceConnectionState> = { ...workspaceConnectionOverrides };
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") continue;
      const error = errorsByWorkspaceId[workspace.id]?.trim();
      if (!error || next[workspace.id]?.status === "connecting") continue;
      next[workspace.id] ??= {
        status: "error",
        message: getWorkspaceTaskLoadErrorDisplay(workspace, error).message || error,
        checkedAt: null,
      };
    }
    return next;
  }, [errorsByWorkspaceId, workspaceConnectionOverrides, workspaces]);

  const mcpConnectedCount = useMcpConnectedCount(opencodeClient, selectedWorkspaceRoot);

  // Recorder: subscribe to recorder events app-wide (the call overlay asks
  // must work even when the Recorder pane is closed) and keep the copilot
  // pointed at the active workspace's OpenCode client.
  useEffect(() => {
    void useRecorderStore.getState().init();
  }, []);
  useEffect(() => {
    registerRecorderCopilotContext({
      getClient: () => opencodeClient,
      getDirectory: () => selectedWorkspaceRoot || null,
    });
    return () => registerRecorderCopilotContext(null);
  }, [opencodeClient, selectedWorkspaceRoot]);

  const providerListQuery = useProviderListQuery({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    directory: selectedWorkspaceRoot || undefined,
  });
  const { providerCatalog, modelVariantLabel, modelBehaviorOptions, modelVariantValue } =
    useModelBehavior({
      providerList: providerListQuery.data,
      defaultModel: local.prefs.defaultModel,
      modelVariant: local.prefs.modelVariant ?? null,
    });
  const modelPicker = useModelPicker({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
  });
  const selectedModelUnavailable = Boolean(
    local.prefs.defaultModel &&
      providerListQuery.data &&
      !isModelAvailableInConnectedProviders(providerListQuery.data, local.prefs.defaultModel),
  );
  const hasUsableModel = Boolean(local.prefs.defaultModel && !selectedModelUnavailable);
  // One-time free-tier migration for existing installs: a persisted default
  // model on the engine's built-in Zen provider ("opencode") strands when the
  // server injects the eigenwelt-free provider and disables zen. Auto-switch
  // to the free provider's first model instead of leaving the user stuck on
  // "model no longer available". Idempotent: after the switch (or any manual
  // pick of a non-zen model) the remap returns null.
  const { setPrefs } = local;
  useEffect(() => {
    const replacement = remapZenSelectionToEigenweltFree(
      providerListQuery.data,
      local.prefs.defaultModel,
    );
    if (!replacement) return;
    setPrefs((previous) => ({ ...previous, defaultModel: replacement, modelVariant: null }));
    toast(`Free models are now served by Eigenwelt — switched to ${resolveModelDisplayName(replacement.modelID)}.`);
  }, [providerListQuery.data, local.prefs.defaultModel, setPrefs]);
  // Warn above the composer whenever the active model is a free-tier model
  // (the no-key fallback — Eigenwelt free gateway, or OpenCode Zen when the
  // platform is unreachable). Free models are for testing only (usage data
  // is logged) — never for privileged, client, or matter data.
  const freeModelSelected = useMemo(
    () => isFreeOpencodeModel(providerListQuery.data, local.prefs.defaultModel),
    [providerListQuery.data, local.prefs.defaultModel],
  );
  const canCreateTask = Boolean(
    opencodeClient && selectedWorkspaceId && !loading && !selectedWorkspaceError && !selectedModelUnavailable,
  );

  const { store: sessionProviderAuthStore, snapshot: sessionProviderAuthSnapshot, onboardingStep, goToTemplates, goToSetup, finishOnboarding } =
    useSessionProviderAuth({
      opencodeClient,
      providers,
      providerDefaults,
      providerConnectedIds,
      disabledProviderIds,
      selectedWorkspace,
      selectedWorkspaceEndpoint,
      selectedWorkspaceRoot,
      selectedWorkspaceId,
      setProviders,
      setProviderDefaults,
      setProviderConnectedIds,
      setDisabledProviderIds,
    });
  // The templates onboarding step needs the desktop runtime (folder picker,
  // skill import IPC); anywhere else it finishes onboarding straight away
  // (usage-analytics consent already lives on the welcome step).
  // The start handler carries its own connection guard.
  const templatesStepEligible = isDesktopRuntime();
  useEffect(() => {
    if (onboardingStep === "templates" && !templatesStepEligible) finishOnboarding();
  }, [finishOnboarding, onboardingStep, templatesStepEligible]);

  // Resume the generation-completion watcher after a reload: a persisted
  // "running" run keeps its Workflows spinner honest only while someone polls.
  useEffect(() => {
    if (baseUrl && token) ensureTemplateWorkflowWatcher(baseUrl, token);
  }, [baseUrl, token]);

  // The generation run's hidden workspace is registered server-side without
  // going through the manual create flow, so route state doesn't know it yet —
  // and navigating to /workspace/<id>/... from the Workflows banner would show
  // "Workspace was not found". Pull it in once per run (guarded so a stale run
  // pointing at a forgotten workspace can't refresh-loop).
  const templateWorkflowRun = useTemplateWorkflowRun();
  const templateRunRefreshAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    const workspaceId = templateWorkflowRun?.workspaceId;
    if (!workspaceId) return;
    if (workspaces.some((workspace) => workspace.id === workspaceId)) return;
    if (templateRunRefreshAttemptedRef.current === workspaceId) return;
    templateRunRefreshAttemptedRef.current = workspaceId;
    void refreshRouteState();
  }, [refreshRouteState, templateWorkflowRun?.workspaceId, workspaces]);

  const startTemplateWorkflowsFromOnboarding = async (): Promise<{ started: boolean; message?: string }> => {
    const selection = await pickDirectory({ title: "Choose your templates folder" });
    const folder = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
    if (!folder?.trim()) return { started: false };
    if (!client || !baseUrl || !token) {
      return { started: false, message: "Still connecting to the LegalWork server. Try again in a moment." };
    }
    const result = await startTemplateWorkflowGeneration({
      environmentClient: client,
      baseUrl,
      token,
      templatesDir: folder.trim(),
      model: local.prefs.defaultModel,
    });
    if (!result.ok) return { started: false, message: result.message };
    // The templates folder is a workspace now — pull it into the sidebar list.
    void refreshRouteState();
    // Templates → the final install step (Office add-ins + transcription model).
    goToSetup();
    return { started: true };
  };

  const {
    activePermission,
    permissionReplyBusy,
    respondPermission,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    todos,
  } = useSessionInteractions({
    client: opencodeClient,
    workspaceId: selectedWorkspaceId,
    sessionId: selectedSessionId,
    workspaceRoot: selectedWorkspaceRoot,
  });
  const showPreparingStatus =
    effectiveLoading ||
    (!canCreateTask && !routeError && !selectedWorkspaceError);

  useEffect(() => {
    if (!opencodeClient) {
      setProviders([]);
      setProviderDefaults({});
      setProviderConnectedIds([]);
      return;
    }

    let cancelled = false;

    const applyProviderState = (value: ProviderListResponse) => {
      if (cancelled) return;
      const all = (value.all ?? []) as ProviderListItem[];
      const connected = value.connected ?? [];
      setProviders(all);
      setProviderConnectedIds(connected);
      // New-provider detection is handled globally by the provider auth
      // store's applyProviderListState, which fires dispatchNewProviders.
    };

    void (async () => {
      let disabledProviders: string[] = [];
      try {
        const config = unwrap(
          await opencodeClient.config.get({
            directory: selectedWorkspaceRoot || undefined,
          }),
        ) as { disabled_providers?: string[] };
        disabledProviders = Array.isArray(config.disabled_providers)
          ? config.disabled_providers
          : [];
        if (!cancelled) setDisabledProviderIds(disabledProviders);
      } catch {
        // ignore config read failures and continue with provider discovery
      }

      try {
        applyProviderState(
          filterProviderList(
            await ensureProviderListQuery(getReactQueryClient(), {
              client: opencodeClient,
              baseUrl: opencodeBaseUrl,
              directory: selectedWorkspaceRoot || undefined,
            }),
            disabledProviders,
          ),
        );
      } catch {
        if (cancelled) return;
        setProviders([]);
        setProviderDefaults({});
        setProviderConnectedIds([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [opencodeBaseUrl, opencodeClient, selectedWorkspaceRoot]);

  const modelLabel = local.prefs.defaultModel
    ? resolveModelDisplayName(local.prefs.defaultModel.modelID)
    : t("session.default_model");

  const listSlashCommands = useCallback(async (): Promise<SlashCommandOption[]> => {
    // engineReloadVersion is included so the callback identity changes after
    // an engine reload, which invalidates the composer's command list cache
    // and causes it to re-fetch (picking up newly created skills).
    void engineReloadVersion;
    if (!opencodeClient) return [];
    return listCommands(opencodeClient, selectedWorkspaceRoot || undefined);
  }, [engineReloadVersion, opencodeClient, selectedWorkspaceRoot]);

  // Shared by the composer (plug menu, @ mentions) and the command palette.
  // Hidden and subagent-only entries are excluded — those are task-tool
  // delegation targets, not agents the user can run a session as.
  const listAgents = useCallback(async () => {
    // Include engineReloadVersion so the composer refetches after newly added
    // agent files become available, even when the inline picker is hidden.
    void engineReloadVersion;
    if (!opencodeClient) return [];
    const list = unwrap(await opencodeClient.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }, [engineReloadVersion, opencodeClient]);

  const handleOpenSettings = useCallback((route = "/settings/general", workspaceId = sidebarActiveWorkspaceId) => {
    const sessionId = workspaceId === sidebarActiveWorkspaceId ? selectedSessionId : null;
    const tab = route.replace(/^\/settings\/?/, "").replace(/^\/+|\/+$/g, "") || "general";
    const target = workspaceId ? workspaceSettingsRoute(workspaceId, tab) : route;
    writeActiveWorkspaceId(workspaceId || null);
    navigate(target, { state: { workspaceId, sessionId } });
  }, [navigate, selectedSessionId, sidebarActiveWorkspaceId]);

  const surfaceProps = useMemo(() => {
    if (!client || !selectedWorkspaceId || !selectedSessionId || !opencodeBaseUrl || !token || !opencodeClient) {
      return null;
    }

    // Transient-safety: when the user switches workspaces the URL-driven
    // selectedSessionId may still point at a session from the old workspace
    // for one render tick. Only block rendering when we KNOW the session
    // belongs to a different workspace (i.e., it exists in another
    // workspace's list). A brand-new session that hasn't been refreshed
    // into any list yet must still render so "New task" feels instant.
    let sessionOwnedByOtherWorkspace = false;
    for (const [workspaceId, sessions] of Object.entries(sessionsByWorkspaceId)) {
      if (workspaceId === selectedWorkspaceId) continue;
      if ((sessions ?? []).some((session) => session?.id === selectedSessionId)) {
        sessionOwnedByOtherWorkspace = true;
        break;
      }
    }
    if (sessionOwnedByOtherWorkspace) {
      return null;
    }

    // Note: do NOT include `client`, `workspaceId`, `sessionId`,
    // `opencodeBaseUrl`, or `legalworkToken` here. SessionPage forwards those
    // explicitly to SessionSurface from the per-workspace endpoint resolved
    // by `resolveWorkspaceEndpoint`. If we leak them in here, the spread of
    // `surfaceProps` in SessionPage overrides those correct values with the
    // local server's, and remote workspaces silently end up calling the
    // local server with the local `rem_*` id.
    return {
      workspaceRoot: selectedWorkspaceRoot,
      developerMode: false,
      modelLabel,
      onModelClick: () => {
        modelPicker.setQuery("");
        modelPicker.setOpen(true);
      },
      modelPickerOpen: modelPicker.compactOpen,
      modelUnavailable: selectedModelUnavailable,
      selectedModel: local.prefs.defaultModel ?? { providerID: "", modelID: "" },
      freeModelSelected,
      onModelPickerOpenChange: modelPicker.setCompactOpen,
      onModelChange: (model: ModelRef) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
            ? previous.modelVariant
            : null,
        }));
        modelPicker.setCompactOpen(false);
      },
      providerConnectedCount: hasUsableModel ? 1 : providerConnectedIds.length,
      onOpenSettingsSection: (section: "commands" | "skills" | "mcps" | "plugins" | "providers") => {
        handleOpenSettings(section === "skills" ? "/settings/extensions/skills" : section === "mcps" ? "/settings/extensions/mcp" : section === "plugins" ? "/settings/extensions/plugins" : section === "providers" ? "/settings/ai" : "/settings/general");
      },
      onSendDraft: async (draft: ComposerDraft, sessionId: string) => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return;
        const text = (draft.resolvedText ?? draft.text).trim();
        if (!text && draft.attachments.length === 0) return;
        if (selectedModelUnavailable) throw new Error("Selected model is unavailable. Choose another model before sending.");

        const fusionModels = getFusionSelectedModels(targetSessionId);
        captureAnalyticsEvent("task_message_sent", {
          session_id: targetSessionId,
          is_command: Boolean(draft.command),
          provider_id: local.prefs.defaultModel?.providerID ?? null,
          model_id: local.prefs.defaultModel?.modelID ?? null,
          surface: analyticsSurface(),
          fusion_enabled: isFusionEnabled(targetSessionId),
          fusion_model_count: fusionModels.length,
          fusion_models: fusionModels.map((m) => `${m.providerID}/${m.modelID}`),
        });
        markTaskRunStart(targetSessionId);

        if (draft.mode === "shell") {
          await shellInSession(opencodeClient, targetSessionId, text);
          return;
        }

        if (draft.command) {
          const result = await opencodeClient.session.command({
            sessionID: targetSessionId,
            command: draft.command.name,
            arguments: draft.command.arguments,
          });
          if (result.error) {
            throw new Error(serializeSDKError(result.error));
          }
          return;
        }

        const parts = await draftToParts(draft, selectedWorkspaceRoot);
        const envSystemContext = await buildLegalworkEnvSystemContext(client, {
          cacheKey: targetSessionId,
          runtimeKey: environmentRuntimeKey,
        });

        if (!isOfficeAddinRuntime() && isFusionEnabled(targetSessionId)) {
          const candidateModels = getFusionSelectedModels(targetSessionId);
          if (candidateModels.length === 0) {
            // No candidates picked for this chat: warn and fall through to a
            // normal single-model send.
            toast.error(t("fusion.not_configured"));
          } else {
            // Deliberately not awaited: the composer should clear as soon as
            // the message is handed off, not when the whole fusion turn
            // (task calls + synthesis) finishes. Progress streams
            // through the fusion store; failures surface as a session error.
            void runFusionSend({
              client: opencodeClient,
              directory: selectedWorkspaceRoot || undefined,
              mainSessionId: targetSessionId,
              parts,
              userText: text,
              candidateModels,
              mainModel: local.prefs.defaultModel ?? undefined,
              agent: selectedAgent ?? undefined,
              variant: modelVariantValue ?? undefined,
              baseSystem: envSystemContext ?? undefined,
            }).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              toast.error(t("fusion.turn_failed"), { description: message });
              useSessionActivityStore.getState().setError(selectedWorkspaceId, targetSessionId, message);
            });
            return;
          }
        }

        const result = await opencodeClient.session.promptAsync({
          sessionID: targetSessionId,
          parts,
          model: local.prefs.defaultModel ?? undefined,
          agent: selectedAgent ?? undefined,
          ...(modelVariantValue ? { variant: modelVariantValue } : {}),
          ...(envSystemContext ? { system: envSystemContext } : {}),
        });
        if (result.error) {
          throw new Error(serializeSDKError(result.error));
        }
      },
      onDraftChange: () => {
        // Draft persistence will be wired once the full React shell owns session state.
      },
      attachmentsEnabled: true,
      attachmentsDisabledReason: null,
      modelVariantLabel,
      modelVariant: modelVariantValue,
      modelBehaviorOptions,
      onModelVariantChange: (value: string | null) => {
        local.setPrefs((previous) => ({ ...previous, modelVariant: value }));
      },
      agentLabel: selectedAgent ? selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1) : t("session.default_agent"),
      selectedAgent,
      listAgents,
      onSelectAgent: (agent: string | null) => setSelectedAgent(agent),
      listCommands: listSlashCommands,
      recentFiles: [],
      searchFiles: async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const result = unwrap(
          await opencodeClient.find.files({
            query: trimmed,
            dirs: "true",
            limit: 50,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        return result;
      },
      isRemoteWorkspace: selectedWorkspace?.workspaceType === "remote",
      isSandboxWorkspace: selectedWorkspace ? isSandboxWorkspace(selectedWorkspace) : false,
      onRevertToMessage: async (messageId: string, sessionId: string) => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return false;
        try {
          // Abort any running generation first; OpenCode rejects revert on busy sessions.
          await abortSessionSafe(opencodeClient, targetSessionId, selectedWorkspaceRoot || undefined);
          const reverted = await revertSession(opencodeClient, targetSessionId, messageId);
          // Stamp the revert cursor into the local caches so the transcript
          // rewinds immediately instead of waiting for a full reload.
          applySessionRevert(selectedWorkspaceId, reverted);
          return true;
        } catch (error) {
          console.warn("[revert] failed", error);
          toast.error(t("session.revert_failed"));
          return false;
        }
      },
      onForkAtMessage: (messageId: string | null, sessionId: string) => {
        void (async () => {
          const targetSessionId = sessionId.trim() || selectedSessionId;
          if (!targetSessionId) return;
          try {
            const forked = await forkSession(opencodeClient, targetSessionId, messageId ?? undefined);
            writeLastSessionFor(selectedWorkspaceId, forked.id);
            rememberPendingCreatedSession(selectedWorkspaceId, forked.id);
            setSessionsByWorkspaceId((current) => ({
              ...current,
              [selectedWorkspaceId]: [forked, ...(current[selectedWorkspaceId] ?? [])],
            }));
            navigateToWorkspaceSession(selectedWorkspaceId, forked.id);
            void refreshRouteState();
          } catch (error) {
            console.warn("[fork] failed", error);
            toast.error(t("session.branch_failed"));
          }
        })();
      },
      onChangeModel: (model: { providerID: string; modelID: string }) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
            ? previous.modelVariant
            : null,
        }));
      },
      environmentRuntimeKey,
      onApplyEnvironmentChanges: isDesktopRuntime() && selectedWorkspace?.workspaceType !== "remote"
        ? handleApplyEnvironmentChanges
        : undefined,
    };
  }, [
    client,
    modelPicker.compactOpen,
    handleOpenSettings,
    hasUsableModel,
    freeModelSelected,
    handleApplyEnvironmentChanges,
    environmentRuntimeKey,
    local,
    listAgents,
    listSlashCommands,
    modelBehaviorOptions,
    modelLabel,
    modelVariantLabel,
    modelVariantValue,
    navigate,
    opencodeBaseUrl,
    opencodeClient,
    providerConnectedIds,
    selectedAgent,
    selectedSessionId,
    selectedModelUnavailable,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    token,
  ]);

  const handleOpenCreateWorkspace = useCallback(() => {
    setCreateWorkspaceOpen(true);
  }, []);

  const handleOpenRenameWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceTitle(
      workspace.displayName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        "",
    );
  }, [workspaces]);

  const handleSaveRenameWorkspace = useCallback(async () => {
    if (!renameWorkspaceId) return;
    const trimmed = renameWorkspaceTitle.trim();
    if (!trimmed) return;
    setRenameWorkspaceBusy(true);
    try {
      if (!client) {
        toast.error("LegalWork server is unavailable. Reconnect the server before renaming workspaces.");
        return;
      }
      await client.updateWorkspaceDisplayName(renameWorkspaceId, trimmed);
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
    } catch (error) {
      toast.error("Workspace rename failed", {
        description: describeRouteError(error),
      });
    } finally {
      setRenameWorkspaceBusy(false);
    }
  }, [client, refreshRouteState, renameWorkspaceId, renameWorkspaceTitle]);

  const handleRevealWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const path = workspace?.path?.trim();
    if (!path || !isDesktopRuntime()) return;
    try {
      await revealDesktopItemInDir(path);
    } catch {
      // ignore
    }
  }, [workspaces]);

  const handleForgetWorkspace = useCallback(
    async (workspaceId: string) => {
      if (typeof window !== "undefined") {
        const message =
          t("workspace_list.remove_confirm") ||
          "Remove this workspace from the sidebar?";
        if (!window.confirm(message)) return;
      }
      // Remove from both stores so the next refresh can't resurrect the row
      // from whichever list wins the merge.
      if (client) {
        await client.deleteWorkspace(workspaceId).catch(() => undefined);
      }
      if (isDesktopRuntime()) {
        await workspaceForget(workspaceId).catch(() => undefined);
      }
      if (selectedWorkspaceId === workspaceId) {
        setLegacySelectedWorkspaceId("");
        writeActiveWorkspaceId(null);
        navigate(legacySessionRoute());
      }
      forgetWorkspaceMemory(workspaceId);
      sessionManagementStore.getState().forgetWorkspace(workspaceId);
      await refreshRouteState();
    },
    [client, navigate, refreshRouteState, selectedWorkspaceId],
  );


  const handleCreateTaskInWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (
      !workspace ||
      loading ||
      retryingWorkspaceIds.includes(workspaceId)
    ) {
      return;
    }
    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl, token });
    if (!endpoint || !endpoint.token) {
      return;
    }
    const workspaceClient = createClient(
      endpoint.opencodeBaseUrl,
      workspace.path?.trim() || undefined,
      { token: endpoint.token, mode: "legalwork" },
    );
    try {
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRouteError(null);
      const session = unwrap(
        await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
      );
      captureAnalyticsEvent("task_created", {
        source: "new_task",
        surface: analyticsSurface(),
      });
      setLegacySelectedWorkspaceId(workspaceId);
      writeActiveWorkspaceId(workspaceId || null);
      writeLastSessionFor(workspaceId, session.id);
      rememberPendingCreatedSession(workspaceId, session.id);
      setSessionsByWorkspaceId((current) => {
        const next = {
          ...current,
          [workspaceId]: [session, ...(current[workspaceId] ?? [])],
        };
        sessionsByWorkspaceIdRef.current = next;
        return next;
      });
      navigateToWorkspaceSession(workspaceId, session.id);
      focusPromptSoon();
      void refreshRouteState();
    } catch (error) {
      const message = describeTaskCreateError(error);
      setRouteError(message);
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: message }));
      toast.error("OpenCode unavailable", {
        description: message,
        action: {
          label: "Retry",
          onClick: () => void handleCreateTaskInWorkspace(workspaceId),
        },
        duration: Infinity,
      });
      if (isTransientStartupError(message)) {
        setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspaceId])));
        if (startupRetryTimerRef.current === null) {
          startupRetryTimerRef.current = window.setTimeout(() => {
            startupRetryTimerRef.current = null;
            refreshInFlightRef.current = false;
            void refreshRouteState();
          }, 1_000);
        }
      }
    }
  }, [baseUrl, loading, navigateToWorkspaceSession, refreshRouteState, rememberPendingCreatedSession, retryingWorkspaceIds, token, workspaces]);

  // Latest session-list state for prev/next session tab navigation. The
  // `options` field is updated by `onSessionTabsChange` from SessionPage so we
  // only cycle through tabs the user actually opened (not artifact sessions).
  // The remaining fields are refreshed during render.
  const sessionTabNavRef = useRef<{
    options: OpenSessionTab[];
    workspaceId: string;
    sessionId: string | null;
    navigate: (workspaceId: string, sessionId?: string | null) => void;
  }>({ options: [], workspaceId: "", sessionId: null, navigate: () => {} });

  const goToSessionTabByOffset = useCallback((offset: number) => {
    const { options, workspaceId, sessionId, navigate } = sessionTabNavRef.current;
    const scoped = options.filter((option) => option.workspaceId === workspaceId);
    if (scoped.length === 0) return;
    const currentIndex = sessionId
      ? scoped.findIndex((option) => option.sessionId === sessionId)
      : -1;
    const nextIndex = currentIndex === -1
      ? offset > 0 ? 0 : scoped.length - 1
      : (currentIndex + offset + scoped.length) % scoped.length;
    const target = scoped[nextIndex];
    if (!target || target.sessionId === sessionId) return;
    navigate(target.workspaceId, target.sessionId);
  }, []);

  const goToNextSessionTab = useCallback(() => goToSessionTabByOffset(1), [goToSessionTabByOffset]);
  const goToPrevSessionTab = useCallback(() => goToSessionTabByOffset(-1), [goToSessionTabByOffset]);

  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    sessionSearchOpen,
    setSessionSearchOpen,
    terminalOpen,
    setTerminalOpen,
  } = useShellShortcuts({
    canCreateTask,
    workspaceId: selectedWorkspaceId,
    onCreateTask: handleCreateTaskInWorkspace,
    onNextSessionTab: goToNextSessionTab,
    onPrevSessionTab: goToPrevSessionTab,
  });
  useReactRenderWatchdog("SessionRoute", {
    selectedSessionId,
    selectedWorkspaceId,
    loading,
    workspaceCount: workspaces.length,
    sessionGroupCount: Object.keys(sessionsByWorkspaceId).length,
    commandPaletteOpen,
    modelPickerOpen: modelPicker.open,
  });

  const navigateToSessionForControl = useCallback((sessionId: string) => {
    const owner = Object.entries(sessionsByWorkspaceId).find(([, sessions]) =>
      (sessions ?? []).some((session) => session?.id === sessionId),
    )?.[0];
    navigateToWorkspaceSession(owner || selectedWorkspaceId, sessionId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId, sessionsByWorkspaceId]);

  const navigateToSessionRootForControl = useCallback(() => {
    navigateToWorkspaceSession(selectedWorkspaceId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId]);

  const openModelPickerForControl = useCallback(() => {
    modelPicker.setOpen(true);
  }, []);

  useSessionControlActions({
    workspaces,
    sessionsByWorkspaceId,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedSessionId,
    canCreateTask,
    legalworkClient: client,
    opencodeClient,
    navigateToSession: navigateToSessionForControl,
    navigateToSessionRoot: navigateToSessionRootForControl,
    createTaskInWorkspace: handleCreateTaskInWorkspace,
    openModelPicker: openModelPickerForControl,
    refreshRouteState,
  });

  const commandPaletteControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "command_palette.open",
    label: "Open the command palette",
    description: "Open the in-app command palette so the next choice is visible.",
    sideEffect: "none",
    execute: () => setCommandPaletteOpen(true),
  }), []);
  useControlAction(commandPaletteControlAction);

  const addProviderControlAction = useMemo<LegalworkControlAction>(() => ({
    id: "settings.provider.add",
    label: "Add a model provider",
    description: "Open the provider connection modal, optionally pre-filtered to a specific provider.",
    sideEffect: "mutation",
    requiresArgs: false,
    args: [
      { name: "providerId", type: "string" as const, required: false, description: "Provider id to pre-select, e.g. 'anthropic', 'openai', 'google'." },
    ],
    execute: async (rawArgs: unknown) => {
      const providerId = typeof rawArgs === "object" && rawArgs !== null
        ? (rawArgs as Record<string, unknown>).providerId
        : undefined;
      const preferred = typeof providerId === "string" ? providerId.trim() : undefined;
      await sessionProviderAuthStore.openProviderAuthModal(
        preferred ? { preferredProviderId: preferred } : undefined,
      );
      return { ok: true, opened: "provider_auth_modal", preferredProviderId: preferred ?? null };
    },
  }), [sessionProviderAuthStore]);
  useControlAction(addProviderControlAction);

  const paletteSessionOptions = useMemo<PaletteSessionOption[]>(() => {
    const out: PaletteSessionOption[] = [];
    for (const workspace of workspaces) {
      const workspaceTitle =
        workspace.displayName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        t("session.workspace_fallback");
      const list = sessionsByWorkspaceId[workspace.id] ?? [];
      for (const session of list) {
        const sessionId = (session as { id?: string }).id?.trim() ?? "";
        if (!sessionId) continue;
        const title = getDisplaySessionTitle(
          (session as { title?: string }).title ?? "",
        );
        const updatedAt =
          (session as { time?: { updated?: number; created?: number } }).time
            ?.updated ??
          (session as { time?: { updated?: number; created?: number } }).time
            ?.created ??
          0;
        out.push({
          workspaceId: workspace.id,
          sessionId,
          title,
          workspaceTitle,
          updatedAt,
          searchText: `${title} ${workspaceTitle}`.toLowerCase(),
          isActive: workspace.id === selectedWorkspaceId,
        });
      }
    }
    out.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }, [sessionsByWorkspaceId, selectedWorkspaceId, workspaces]);

  // Refresh the non-tab fields of the nav ref during render. The `options`
  // field is maintained by the `onSessionTabsChange` callback from SessionPage.
  sessionTabNavRef.current = {
    options: sessionTabNavRef.current.options,
    workspaceId: selectedWorkspaceId,
    sessionId: selectedSessionId,
    navigate: navigateToWorkspaceSession,
  };

  const paletteSessionGroups = useMemo<SessionGroupOption[]>(
    () => selectedWorkspaceGroupState?.groups ?? [],
    [selectedWorkspaceGroupState?.groups],
  );

  const currentSessionForGroupMove = useMemo(() => {
    if (!selectedWorkspaceId || !selectedSessionId) return null;
    return paletteSessionOptions.find(
      (session) => session.workspaceId === selectedWorkspaceId && session.sessionId === selectedSessionId,
    ) ?? null;
  }, [paletteSessionOptions, selectedSessionId, selectedWorkspaceId]);

  const currentSessionGroupId = selectedSessionId
    ? selectedWorkspaceGroupState?.assignments[selectedSessionId] ?? null
    : null;

  const handleMoveCurrentSessionToGroup = useCallback((groupId: string) => {
    if (!selectedWorkspaceId || !selectedSessionId) return;
    assignSessionToGroup(selectedWorkspaceId, selectedSessionId, groupId);
  }, [assignSessionToGroup, selectedSessionId, selectedWorkspaceId]);

  const sessionSearchFetcher = useMemo<SessionMessageFetcher | null>(() => {
    if (!client) return null;
    // Cap the transcript fetch to keep multi-workspace scans fast; matches in
    // anything older than the most recent 400 messages are traded away for
    // responsiveness.
    return async (workspaceId: string, sessionId: string) =>
      (await client.getSessionMessages(workspaceId, sessionId, { limit: 400 })).items;
  }, [client]);

  const sessionSearchPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-search.open",
    title: "Search session messages",
    detail: "Deep search every session, including message content",
    meta: "Cmd/Ctrl+Shift+F",
    searchText: "search find sessions messages history transcript content",
    action: () => {
      setCommandPaletteOpen(false);
      setSessionSearchOpen(true);
    },
  }), []);

  const terminalPaletteItems = useMemo<PaletteItem[]>(() => [
    {
      id: "terminal.toggle",
      title: terminalOpen ? "Hide terminal" : "Show terminal",
      detail: "Toggle the integrated terminal panel for this workspace",
      meta: "Cmd/Ctrl+J",
      searchText: "terminal shell command line console show hide toggle",
      action: () => {
        setCommandPaletteOpen(false);
        setTerminalOpen((value) => !value);
      },
    },
  ], [terminalOpen]);

  const developerModePaletteItem = useMemo<PaletteItem>(() => ({
    id: "developer-mode.toggle",
    title: developerMode ? t("settings.disable_developer_mode") : t("settings.enable_developer_mode"),
    detail: t("settings.developer_mode_desc"),
    meta: developerMode ? "On" : "Off",
    searchText: "developer dev mode debug diagnostics toggle enable disable",
    action: () => {
      setCommandPaletteOpen(false);
      setDeveloperMode((current) => {
        const next = !current;
        try { window.localStorage.setItem("legalwork.developerMode", next ? "1" : "0"); } catch {}
        return next;
      });
    },
  }), [developerMode]);

  const nextSessionTabPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-tab.next",
    title: "Next session tab",
    detail: "Switch to the next session in this workspace",
    meta: "Cmd/Ctrl+T",
    searchText: "next session tab switch forward",
    action: () => {
      setCommandPaletteOpen(false);
      goToNextSessionTab();
    },
  }), [goToNextSessionTab]);

  const prevSessionTabPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-tab.previous",
    title: "Previous session tab",
    detail: "Switch to the previous session in this workspace",
    meta: "Cmd/Ctrl+Shift+T",
    searchText: "previous session tab switch back",
    action: () => {
      setCommandPaletteOpen(false);
      goToPrevSessionTab();
    },
  }), [goToPrevSessionTab]);

  const handleReorderWorkspaces = useCallback((workspaceIds: string[]) => {
    const activeWorkspaceIds = new Set(workspacesRef.current.map((workspace) => workspace.id));
    const nextOrderIds: string[] = [];
    const nextOrderIdSet = new Set<string>();

    for (const id of workspaceIds) {
      if (!activeWorkspaceIds.has(id) || nextOrderIdSet.has(id)) continue;
      nextOrderIds.push(id);
      nextOrderIdSet.add(id);
    }

    for (const workspace of workspacesRef.current) {
      if (nextOrderIdSet.has(workspace.id)) continue;
      nextOrderIds.push(workspace.id);
      nextOrderIdSet.add(workspace.id);
    }

    workspaceOrderIdsRef.current = nextOrderIds;
    setWorkspaceOrderIds(nextOrderIds);
    writeWorkspaceOrderIds(nextOrderIds);
    setWorkspaces((current) => orderRouteWorkspaces(current, nextOrderIds));
  }, []);

  const handleArchiveSession = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (!opencodeClient) return;
      try {
        await setSessionArchived(
          opencodeClient,
          sessionId,
          archived,
          selectedWorkspaceRoot || undefined,
        );
        await refreshRouteState();
      } catch (error) {
        console.error("[session-route] archive session failed", error);
        toast.error(
          archived
            ? t("session_management.archive_failed")
            : t("session_management.unarchive_failed"),
          { description: describeRouteError(error) },
        );
      }
    },
    [opencodeClient, refreshRouteState, selectedWorkspaceRoot],
  );

  const handleCreateWorkspace = useCallback(async (preset: WorkspacePreset, folder: string | null) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceName = folderNameFromPath(folder);
      let list: WorkspaceList | null = null;
      let createdOnServer = false;
      if (client) {
        list = await client
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .then((serverList) => {
            createdOnServer = true;
            return serverList;
          })
          .catch(() => null);
      }
      if (!list) {
        throw new Error("LegalWork server is unavailable. Start or reconnect the server before creating a workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      let targetWorkspaceId = createdId;
      let targetWorkspace = list.workspaces.find((workspace: WorkspaceInfo) => workspace.id === createdId) ?? null;
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      if (targetWorkspaceId) {
        const workspacePath = targetWorkspace?.path?.trim() || folder;
        const session = createdOnServer && baseUrl && token
          ? unwrap(await createClient(
              `${(buildLegalworkWorkspaceBaseUrl(baseUrl, targetWorkspaceId) ?? baseUrl).replace(/\/+$/, "")}/opencode`,
              workspacePath || undefined,
              { token, mode: "legalwork" },
            ).session.create({ directory: workspacePath || undefined }))
          : null;
        setLegacySelectedWorkspaceId(targetWorkspaceId);
        writeActiveWorkspaceId(targetWorkspaceId);
        captureAnalyticsEvent("workspace_created", { surface: analyticsSurface() });
        if (session?.id) {
          captureAnalyticsEvent("task_created", { source: "workspace_created", surface: analyticsSurface() });
          writeLastSessionFor(targetWorkspaceId, session.id);
          rememberPendingCreatedSession(targetWorkspaceId, session.id);
          setSessionsByWorkspaceId((current) => {
            const next = {
              ...current,
              [targetWorkspaceId]: [session, ...(current[targetWorkspaceId] ?? [])],
            };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
        }
        navigateToWorkspaceSession(targetWorkspaceId, session?.id ?? null, { replace: true });
        if (session?.id) focusPromptSoon();
      }
    } catch (error) {
      setCreateWorkspaceError(describeWorkspaceCreateError(error));
      // Surface the error even when creation was started outside the modal
      // (e.g. from the New Task workspace picker's folder select).
      setCreateWorkspaceOpen(true);
    } finally {
      setCreateWorkspaceBusy(false);
    }
  }, [baseUrl, client, local, navigateToWorkspaceSession, refreshRouteState, rememberPendingCreatedSession, token]);

  const handleCreateTaskInNewWorkspace = useCallback(async () => {
    if (createWorkspaceBusy) return;
    const folder = (await pickDirectory({ title: t("onboarding.authorize_folder") })) as string | null;
    if (!folder?.trim()) return;
    await handleCreateWorkspace("starter", folder);
  }, [createWorkspaceBusy, handleCreateWorkspace]);

  // Leaving a top-level pane (Learnings/Skills/Integrations): any session/workspace
  // navigation drops back to the session view.
  useEffect(() => {
    setShowLearnings(false);
    setShowWorkflows(false);
    setShowExtensions(false);
  }, [selectedSessionId, selectedWorkspaceId]);

  return (
    <WorkspaceProvider
      client={opencodeClient}
      opencodeBaseUrl={opencodeBaseUrl}
      selectedWorkspaceRoot={selectedWorkspaceRoot}
    >
    {opencodeClient && selectedWorkspaceEndpoint && opencodeBaseUrl && selectedWorkspaceServerToken ? (
      <ReactSessionRuntime
        // Use the server-side workspace id (the one without the `rem_`
        // prefix) so the React Query cache keys session-sync writes match
        // the keys SessionSurface reads from. Otherwise events arrive but
        // the UI never sees them and gets stuck on "thinking".
        workspaceId={selectedWorkspaceEndpoint.workspaceId}
        sessionId={selectedSessionId}
        activeSessionIds={activeSelectedWorkspaceSessionIds}
        opencodeBaseUrl={opencodeBaseUrl}
        legalworkToken={selectedWorkspaceServerToken}
        onSessionUpdated={handleRuntimeSessionUpdated}
      />
    ) : null}
    {onboardingStep === "connect" ? (
      // Provider-selection cover: the real provider-selection design (z-40) with the
      // searchable connect modal (z-50) on top. Usage-analytics consent lives on the
      // welcome step; connecting or skipping here advances to the optional templates step.
      <ProviderSelectionStep
        onConnect={(providerId) =>
          sessionProviderAuthStore.openProviderAuthModal({
            preferredProviderId: providerId || undefined,
            returnFocusTarget: "composer",
          })
        }
        onSkip={goToTemplates}
      />
    ) : null}
    {onboardingStep === "templates" && templatesStepEligible ? (
      // Optional cover: point a local agent at the firm's templates folder;
      // the generation run continues in the background while onboarding finishes.
      <TemplateWorkflowsStep
        onStart={startTemplateWorkflowsFromOnboarding}
        onSkip={goToSetup}
      />
    ) : null}
    {onboardingStep === "setup" ? (
      // Final cover: one-tap installs — Office add-ins + a transcription model.
      <TranscriptionSetupStep onDone={finishOnboarding} />
    ) : null}
    <SessionPage
      selectedSessionId={selectedSessionId}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedWorkspaceDisplay={selectedWorkspace ? {
        id: selectedWorkspace.id,
        name: selectedWorkspace.name ?? undefined,
        displayName: selectedWorkspace.displayNameResolved,
        workspaceType: selectedWorkspace.workspaceType,
      } : { workspaceType: "local" }}
      selectedWorkspaceRoot={selectedWorkspaceRoot}
      selectedWorkspaceError={selectedWorkspaceError}
      runtimeWorkspaceId={selectedWorkspaceEndpoint?.workspaceId || null}
      opencodeBaseUrl={opencodeBaseUrl}
      workspaces={sidebarWorkspaces}
      clientConnected={canCreateTask}
      legalworkServerStatus={client ? "connected" : "disconnected"}
      legalworkServerClient={selectedWorkspaceEndpoint?.client ?? client}
      environmentClient={client}
      legalworkServerToken={selectedWorkspaceServerToken}
      developerMode={developerMode}
      headerStatus={canCreateTask ? t("status.connected") : t("session.loading_detail")}
      busyHint={effectiveLoading ? t("session.loading_detail") : null}
      startupPhase={effectiveLoading ? "nativeInit" : "ready"}
      providerConnectedIds={providerConnectedIds}
      hasUsableModel={hasUsableModel}
      providers={providers}
      mcpConnectedCount={mcpConnectedCount}
      onOpenSettings={() => handleOpenSettings("/settings/general")}
      onOpenProviderAuth={() => sessionProviderAuthStore.openProviderAuthModal({ returnFocusTarget: "composer" })}
      providerAuthModal={sessionProviderAuthSnapshot.providerAuthModalOpen ? {
        open: true,
        loading: false,
        submitting: sessionProviderAuthSnapshot.providerAuthBusy,
        error: sessionProviderAuthSnapshot.providerAuthError,
        preferredProviderId: sessionProviderAuthSnapshot.providerAuthPreferredProviderId,
        workerType: sessionProviderAuthSnapshot.providerAuthWorkerType,
        providers: sessionProviderAuthSnapshot.providerAuthProviders,
        connectedProviderIds: providerConnectedIds,
        authMethods: sessionProviderAuthSnapshot.providerAuthMethods,
        onSelect: sessionProviderAuthStore.startProviderAuth,
        onSubmitApiKey: async (providerId, apiKey) => {
          const result = await sessionProviderAuthStore.submitProviderApiKey(providerId, apiKey);
          modelPicker.setRecentProviderIds(new Set([providerId]));
          modelPicker.setQuery("");
          modelPicker.setOpen(true);
          return result;
        },
        onSubmitCustomProvider: sessionProviderAuthStore.submitCustomProvider,
        onSubmitOAuth: sessionProviderAuthStore.completeProviderAuthOAuth,
        onRefreshProviders: sessionProviderAuthStore.refreshProviders,
        onClose: () => sessionProviderAuthStore.closeProviderAuthModal(),
      } : null}
      mainView={
        // One reused SettingsSurface instance across the pages — it follows `initialPath`
        // via an effect, so switching Workflows <-> Integrations is instant and doesn't
        // re-fetch the workspace/stores.
        showWorkflows ? (
          // onClose drops the pane so actions that navigate to a session (e.g.
          // opening the workflow-generation session) always reveal the chat —
          // even when the target session is already the selected one and the
          // route (and thus the pane-closing route effect) doesn't change.
          <SettingsSurface
            embedded
            singleView
            initialPath="workflows"
            workspaceId={selectedWorkspaceId}
            onClose={() => setShowWorkflows(false)}
          />
        ) : showExtensions ? (
          <SettingsSurface embedded singleView initialPath="extensions" workspaceId={selectedWorkspaceId} />
        ) : showLearnings ? (
          <LearningsPane workspaceId={selectedWorkspaceId} />
        ) : showRecorder ? (
          <RecorderPane
            workspacePath={selectedWorkspaceRoot ?? null}
            workspaceTargets={workspaces
              .filter((workspace) => workspace.workspaceType !== "remote" && workspace.path?.trim())
              .map((workspace) => ({
                id: workspace.id,
                name: workspace.displayNameResolved,
                path: workspace.path,
              }))
              // Selected workspace first, so the common case is one click away.
              .sort((a, b) => Number(b.id === selectedWorkspaceId) - Number(a.id === selectedWorkspaceId))}
            onInsertTranscript={(text) => {
              // The composer's listener lives in SessionSurface, which is
              // unmounted while this pane is the main view — swap back to the
              // session first, then dispatch once it has remounted.
              setShowRecorder(false);
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent(RECORDER_TRANSCRIPT_EVENT, { detail: { text } }));
              }, 350);
            }}
          />
        ) : undefined
      }
      settingsSlot={
        <SettingsSurface
          embedded
          initialPath="extensions"
          workspaceId={selectedWorkspaceId}
          onClose={() => {
            try {
              window.dispatchEvent(new CustomEvent("legalwork-close-right-pane"));
            } catch {
              // ignore
            }
          }}
        />
      }
      terminalOpen={terminalOpen}
      onTerminalOpenChange={setTerminalOpen}
      onSessionTabsChange={(tabs) => {
        sessionTabNavRef.current = { ...sessionTabNavRef.current, options: tabs };
      }}
      sidebar={{
        onShowLearnings: showLearningsPane,
        onShowWorkflows: showWorkflowsPane,
        onShowExtensions: showExtensionsPane,
        onShowRecorder: showRecorderPane,
        activeNav: showWorkflows ? "workflows" : showExtensions ? "extensions" : showLearnings ? "learnings" : showRecorder ? "recorder" : null,
        workspaceSessionGroups,
        selectedWorkspaceId,
        selectedSessionId,
        developerMode: false,
        sessionStatusById: sidebarSessionStatusById,
        connectingWorkspaceId: null,
        workspaceConnectionStateById,
        newTaskDisabled: !canCreateTask,
        sidebarHydratedFromCache: Object.values(sessionsByWorkspaceId).some((list) => list.length > 0),
        startupPhase: effectiveLoading ? "nativeInit" : "ready",
        onSelectWorkspace: async (workspaceId) => {
          if (workspaceId === selectedWorkspaceId) return true;
          setLegacySelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          const workspace = workspaces.find((item) => item.id === workspaceId);
          if (client && workspace && !sessionsByWorkspaceId[workspaceId]?.length) {
            setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspaceId])));
            void loadWorkspaceSessionsInBackground([workspace]);
          }
          // Fire Tauri updates but don't await them — they're bookkeeping and
          // awaiting 2 IPC roundtrips on every click used to stall rapid
          // workspace switches behind a queue.
          if (isDesktopRuntime()) {
            void workspaceSetSelected(workspaceId).catch(() => undefined);
            void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
          }
          // Tell the LegalWork server this workspace is now active so it can
          // emit a config reload event that the OpenCode engine picks up.
          // Without this, the permissions from opencode.jsonc are never
          // applied on the workspace the user is already on at launch. See
          // issue #870.
          if (workspaceId) {
            const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
            const endpoint = endpointForWorkspace(workspace);
            if (endpoint) {
              void endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true }).catch(() => undefined);
            }
          }
          // If we remember what the user last opened here and that session
          // still exists in our local list, navigate. Otherwise stay put.
          const remembered = readLastSessionFor(workspaceId);
          if (remembered && remembered !== selectedSessionId) {
            const known = sessionsByWorkspaceId[workspaceId];
            if (known?.some((session) => session?.id === remembered)) {
              navigateToWorkspaceSession(workspaceId, remembered);
            } else {
              navigateToWorkspaceSession(workspaceId);
            }
          } else {
            navigateToWorkspaceSession(workspaceId);
          }
          return true;
        },
        onOpenSession: (workspaceId, sessionId) => {
          // Opening a session returns to the chat view — drop any open top-level
          // pane (Learnings/Workflows/Integrations) so it doesn't stay rendered
          // over the session.
          setShowLearnings(false);
          setShowWorkflows(false);
          setShowExtensions(false);
          setShowRecorder(false);
          setLegacySelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          writeLastSessionFor(workspaceId, sessionId);
          navigateToWorkspaceSession(workspaceId, sessionId);
        },
        onPrefetchSession: () => {},
        onCreateTaskInWorkspace: (workspaceId) => {
          void handleCreateTaskInWorkspace(workspaceId);
        },
        onCreateTaskWithPrompt: (workspaceId, prompt) => {
          void (async () => {
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (!workspace) return;
            const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl, token });
            if (!endpoint?.token) return;
            const workspaceClient = createClient(
              endpoint.opencodeBaseUrl,
              workspace.path?.trim() || undefined,
              { token: endpoint.token, mode: "legalwork" },
            );
            try {
              const session = unwrap(
                await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
              );
              saveSessionDraft(workspaceId, session.id, { text: prompt, mode: "prompt" });
              writeActiveWorkspaceId(workspaceId || null);
              writeLastSessionFor(workspaceId, session.id);
              rememberPendingCreatedSession(workspaceId, session.id);
              setSessionsByWorkspaceId((current) => ({
                ...current,
                [workspaceId]: [session, ...(current[workspaceId] ?? [])],
              }));
              navigateToWorkspaceSession(workspaceId, session.id);
              focusPromptSoon();
            } catch {
              // Fall back to normal task creation without prompt
              void handleCreateTaskInWorkspace(workspaceId);
            }
          })();
        },
        onOpenRenameWorkspace: handleOpenRenameWorkspace,
        onRevealWorkspace: (id) => void handleRevealWorkspace(id),
        onForgetWorkspace: (id) => void handleForgetWorkspace(id),
        onOpenCreateWorkspace: () => {
          // New Task returns to the session view — drop any open top-level pane
          // (Learnings/Skills/Integrations) so it doesn't linger behind the modal.
          setShowLearnings(false);
          setShowWorkflows(false);
          setShowExtensions(false);
          handleOpenCreateWorkspace();
        },
        onCreateTaskInNewWorkspace: () => {
          void handleCreateTaskInNewWorkspace();
        },
        onReorderWorkspaces: handleReorderWorkspaces,
      }}
      surface={surfaceProps}
      history={{
        canUndo: false,
        canRedo: false,
        busyAction: null,
        onUndo: () => {},
        onRedo: () => {},
      }}
      todos={todos}
      sessionLoadingById={(sessionId) => effectiveLoading && Boolean(sessionId && sessionId === selectedSessionId)}
      activePermission={activePermission}
      permissionReplyBusy={permissionReplyBusy}
      respondPermission={respondPermission}
      activeQuestion={activeQuestion}
      questionReplyBusy={questionReplyBusy}
      respondQuestion={respondQuestion}
      safeStringify={safeStringify}
      onRenameSession={
        opencodeClient
          ? async (sessionId, nextTitle) => {
              const trimmed = nextTitle.trim();
              if (!trimmed) return;
              await opencodeClient.session.update({
                sessionID: sessionId,
                title: trimmed,
                directory: selectedWorkspaceRoot || undefined,
              });
              await refreshRouteState();
            }
          : undefined
      }
      onDeleteSession={
        client && selectedWorkspaceId
          ? async (sessionId) => {
              const endpoint = endpointForWorkspace(selectedWorkspace);
              if (!endpoint) return;
              await endpoint.client.deleteSession(endpoint.workspaceId, sessionId);
              if (selectedSessionId === sessionId) {
                navigateToWorkspaceSession(selectedWorkspaceId);
              }
              await refreshRouteState();
            }
          : undefined
      }
      onArchiveSession={opencodeClient ? handleArchiveSession : undefined}
      statusBar={{ loading: showPreparingStatus }}
      notFoundMessage={routeNotFoundMessage}
      onAccessibleTargetsChange={setPaletteAccessibleTargets}
    />
    <CreateWorkspaceModal
      open={createWorkspaceOpen}
      onClose={() => {
        setCreateWorkspaceOpen(false);
        setCreateWorkspaceError(null);
      }}
      onConfirm={handleCreateWorkspace}
      onPickFolder={() => pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<string | null>}
      submitting={createWorkspaceBusy}
      localError={createWorkspaceError}
    />
    <RenameWorkspaceModal
      open={renameWorkspaceId !== null}
      title={renameWorkspaceTitle}
      busy={renameWorkspaceBusy}
      canSave={!renameWorkspaceBusy && renameWorkspaceTitle.trim().length > 0}
      onClose={() => {
        if (renameWorkspaceBusy) return;
        setRenameWorkspaceId(null);
        setRenameWorkspaceTitle("");
      }}
      onSave={() => void handleSaveRenameWorkspace()}
      onTitleChange={setRenameWorkspaceTitle}
    />
    <CommandPalette
      open={commandPaletteOpen}
      onClose={() => setCommandPaletteOpen(false)}
      onCreateNewSession={() => {
        if (selectedWorkspaceId) {
          void handleCreateTaskInWorkspace(selectedWorkspaceId);
        }
      }}
      onOpenSession={(workspaceId, sessionId) => navigateToWorkspaceSession(workspaceId, sessionId)}
      onOpenSettings={(route) => handleOpenSettings(route ?? "/settings/general")}
      onOpenModelPicker={() => {
        modelPicker.setQuery("");
        modelPicker.setRecentProviderIds(new Set());
        window.requestAnimationFrame(() => modelPicker.setOpen(true));
      }}
      selectedModelLabel={modelLabel}
      accessibleTargets={paletteAccessibleTargets}
      onOpenAccessibleTarget={(target) => {
        try {
          window.dispatchEvent(new CustomEvent("legalwork-open-accessible-target", { detail: target }));
        } catch {
          // ignore event dispatch failures
        }
      }}
      onHideAccessibleTarget={(target) => {
        try {
          window.dispatchEvent(new CustomEvent("legalwork-hide-accessible-target", { detail: target }));
        } catch {
          // ignore event dispatch failures
        }
      }}
      sessions={paletteSessionOptions}
      sessionGroups={paletteSessionGroups}
      currentSessionForGroupMove={currentSessionForGroupMove}
      currentSessionGroupId={currentSessionGroupId}
      onMoveCurrentSessionToGroup={handleMoveCurrentSessionToGroup}
      extraItems={[sessionSearchPaletteItem, ...terminalPaletteItems, developerModePaletteItem, nextSessionTabPaletteItem, prevSessionTabPaletteItem]}
      listAgents={listAgents}
      selectedAgent={selectedAgent}
      onSelectAgent={setSelectedAgent}
    />
    <WhatsNewDialog hasWorkspaces={workspaces.length > 0} workspacesReady={!effectiveLoading} />
    <TranscriptionIntroDialog workspacesReady={!effectiveLoading} onOpenRecorder={showRecorderPane} />
    <SessionSearchDialog
      open={sessionSearchOpen}
      onClose={() => setSessionSearchOpen(false)}
      sessions={paletteSessionOptions}
      fetchMessages={sessionSearchFetcher}
      onOpenSession={(workspaceId, sessionId) => navigateToWorkspaceSession(workspaceId, sessionId)}
    />
    <ModelPickerModal
      open={modelPicker.open}
      options={modelPicker.options}

      query={modelPicker.query}
      setQuery={modelPicker.setQuery}
      target="default"
      current={local.prefs.defaultModel ?? ({ providerID: "", modelID: "" } satisfies ModelRef)}
      onSelect={(next: ModelRef) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: next,
          modelVariant: previous.defaultModel?.providerID === next.providerID && previous.defaultModel.modelID === next.modelID
            ? previous.modelVariant
            : null,
        }));
        modelPicker.setOpen(false);
        focusPromptSoon();
      }}
      disabledProviders={disabledProviderIds}
      onBehaviorChange={() => {}}
      onToggleProvider={async (providerId, enable) => {
        if (!opencodeClient) return;
        try {
          const config = unwrap(await opencodeClient.config.get()) as { disabled_providers?: string[] };
          const current = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
          const next = enable
            ? current.filter((id: string) => id !== providerId)
            : [...current, providerId];
          await opencodeClient.config.update({ config: { ...config, disabled_providers: next } });
          setDisabledProviderIds(next);
        } catch {}
      }}
      onOpenSettings={() => {
        modelPicker.setOpen(false);
        handleOpenSettings("/settings/general");
      }}
      onClose={() => { modelPicker.setOpen(false); modelPicker.setRecentProviderIds(new Set()); }}
    />
    </WorkspaceProvider>
  );
}
