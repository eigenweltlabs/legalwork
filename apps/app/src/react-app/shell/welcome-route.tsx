/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useState } from "react";
import { useNavigate } from "react-router-dom";

import { t } from "../../i18n";
import {
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { createClient, unwrap } from "../../app/lib/opencode";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { WelcomePage } from "../domains/onboarding/welcome-page";
import { AttributionStep } from "../domains/onboarding/attribution-step";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import { resolveLegalworkConnection } from "./legalwork-connection";
import { analyticsSurface, captureAnalyticsEvent, getStoredAnalyticsConsent } from "../../app/lib/analytics";
import { captureAppError } from "../../app/lib/app-error";
import { buildLegalworkWorkspaceBaseUrl, createLegalworkServerClient } from "../../app/lib/legalwork-server";
import { writeActiveWorkspaceId, writeLastSessionFor } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";
import { ensureDesktopLocalLegalworkConnection } from "./desktop-local-legalwork";

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("legalwork:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

type WelcomeState = {
  modalOpen: boolean;
  createBusy: boolean;
  createError: string | null;
  remoteBusy: boolean;
  remoteError: string | null;
  providerStep: boolean;
  attributionStep: boolean;
  pendingRoute: string | null;
  pendingWorkspaceId: string | null;
  pendingSessionId: string | null;
};

type WelcomeAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "create:start" }
  | { type: "create:error"; error: string }
  | { type: "create:finish" }
  | { type: "remote:start" }
  | { type: "remote:error"; error: string }
  | { type: "remote:finish" }
  | { type: "provider-step"; workspaceId: string; sessionId: string | null }
  | { type: "attribution-step"; route: string };

const initialWelcomeState: WelcomeState = {
  modalOpen: false,
  createBusy: false,
  createError: null,
  remoteBusy: false,
  remoteError: null,
  providerStep: false,
  attributionStep: false,
  pendingRoute: null,
  pendingWorkspaceId: null,
  pendingSessionId: null,
};

function welcomeReducer(state: WelcomeState, action: WelcomeAction): WelcomeState {
  switch (action.type) {
    case "open":
      return { ...state, modalOpen: true };
    case "close":
      return { ...state, modalOpen: false, createError: null, remoteError: null };
    case "create:start":
      return { ...state, createBusy: true, createError: null };
    case "create:error":
      return { ...state, createError: action.error };
    case "create:finish":
      return { ...state, createBusy: false };
    case "remote:start":
      return { ...state, remoteBusy: true, remoteError: null };
    case "remote:error":
      return { ...state, remoteError: action.error };
    case "remote:finish":
      return { ...state, remoteBusy: false };
    case "provider-step":
      return { ...state, providerStep: true, pendingWorkspaceId: action.workspaceId, pendingSessionId: action.sessionId };
    case "attribution-step":
      return { ...state, providerStep: false, attributionStep: true, pendingRoute: action.route };
  }
}

/**
 * WelcomeRoute: full-screen welcome page shown on first launch when
 * the user has no workspaces and has not completed onboarding.
 *
 * Clicking "Get started" opens the CreateWorkspaceModal. Once a
 * workspace is created, hasCompletedOnboarding is set and the user
 * is redirected to /session.
 */
export function WelcomeRoute() {
  const navigate = useNavigate();
  const local = useLocal();
  const platform = usePlatform();
  const [state, dispatch] = useReducer(welcomeReducer, initialWelcomeState);
  const [manualFolder, setManualFolder] = useState("");
  // Pending usage-analytics choice; committed when the user leaves the welcome
  // screen (see handleCreateWorkspace). Seeded from any previously recorded
  // choice so re-entering the screen never overrides an opt-out.
  const [analyticsOptIn, setAnalyticsOptIn] = useState(() => getStoredAnalyticsConsent() ?? true);

  // If user already completed onboarding, redirect away immediately — but NOT while the
  // provider step is showing (the workspace exists, yet the user still has to connect a
  // model), otherwise we'd bounce straight into the app after the folder pick.
  useEffect(() => {
    if (local.prefs.hasCompletedOnboarding && !state.providerStep) {
      navigate("/session", { replace: true });
    }
  }, [local.prefs.hasCompletedOnboarding, navigate, state.providerStep]);

  const markOnboardingComplete = useCallback(() => {
    local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
  }, [local]);

  const handleCreateWorkspace = useCallback(
    async (_preset: string, folder: string | null) => {
      if (!folder) return;
      dispatch({ type: "create:start" });
      try {
        const workspaceName = folderNameFromPath(folder);
        let list: WorkspaceList | null = null;
        let serverBaseUrl = "";
        let serverToken = "";
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
            await resolveLegalworkConnection();
          if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
            const legalworkClient = createLegalworkServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken || undefined,
              hostToken: resolvedHostToken || undefined,
            });
            list = await legalworkClient.createLocalWorkspace({
              folderPath: folder,
              name: workspaceName,
              preset: "starter",
            });
            serverBaseUrl = normalizedBaseUrl;
            serverToken = resolvedToken;
          }
        } catch {
          list = null;
        }
        if (!list) {
          throw new Error("LegalWork server is unavailable. Start or reconnect the server before creating a workspace.");
        }
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        let targetWorkspaceId = createdId;
        let targetWorkspace = list.workspaces.find((workspace: WorkspaceInfo) => workspace.id === createdId) ?? null;
        let targetSessionId: string | null = null;
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        if (targetWorkspace) {
          await ensureDesktopLocalLegalworkConnection({
            route: "session",
            workspace: targetWorkspace,
            allWorkspaces: list.workspaces,
          }).catch(() => undefined);
        }
        if (targetWorkspaceId && serverBaseUrl && serverToken) {
          try {
            const workspacePath = targetWorkspace?.path?.trim() || folder;
            const session = unwrap(await createClient(
              `${(buildLegalworkWorkspaceBaseUrl(serverBaseUrl, targetWorkspaceId) ?? serverBaseUrl).replace(/\/+$/, "")}/opencode`,
              workspacePath || undefined,
              { token: serverToken, mode: "legalwork" },
            ).session.create({ directory: workspacePath || undefined }));
            targetSessionId = session.id;
            captureAnalyticsEvent("task_created", { source: "onboarding", surface: analyticsSurface() });
          } catch {
            // Best-effort first task creation.
          }
        }
        if (targetWorkspaceId) {
          writeActiveWorkspaceId(targetWorkspaceId);
          if (targetSessionId) writeLastSessionFor(targetWorkspaceId, targetSessionId);
        }
        dispatch({ type: "close" });
        // Leaving the welcome screen — commit the analytics choice and mark
        // onboarding complete (the connect cover only clears its own state).
        local.setPrefs((prev) => ({ ...prev, analyticsEnabled: analyticsOptIn, hasCompletedOnboarding: true }));
        // Hand off to the new session, which runs the remaining onboarding steps as
        // full-screen covers (connect a model).
        const target = targetWorkspaceId
          ? workspaceSessionRoute(targetWorkspaceId, targetSessionId)
          : "/session";
        const sep = target.includes("?") ? "&" : "?";
        navigate(`${target}${sep}onboarding=1`, { replace: true });
      } catch (error) {
        captureAppError("workspace_create", error);
        dispatch({
          type: "create:error",
          error: error instanceof Error ? error.message : "Failed to create workspace.",
        });
      } finally {
        dispatch({ type: "create:finish" });
      }
    },
    [navigate, local, analyticsOptIn],
  );

  const handleCreateRemote = useCallback(
    async (input: {
      legalworkHostUrl?: string | null;
      legalworkToken?: string | null;
      directory?: string | null;
      displayName?: string | null;
    }) => {
      const baseUrlValue = input.legalworkHostUrl?.trim() ?? "";
      if (!baseUrlValue) return false;
      dispatch({ type: "remote:start" });
      try {
        const remoteType: "legalwork" = "legalwork";
        const payload = {
          baseUrl: baseUrlValue,
          legalworkHostUrl: baseUrlValue,
          legalworkToken: input.legalworkToken?.trim() || null,
          displayName: input.displayName?.trim() || null,
          directory: input.directory?.trim() || null,
          remoteType,
        };
        let list: WorkspaceList | null = null;
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
            await resolveLegalworkConnection();
          if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
            list = await createLegalworkServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken || undefined,
              hostToken: resolvedHostToken || undefined,
            }).createRemoteWorkspace(payload);
          }
        } catch {
          list = null;
        }
        if (!list) {
          throw new Error("LegalWork server is unavailable. Start or reconnect the server before connecting a remote workspace.");
        }
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        markOnboardingComplete();
        dispatch({ type: "close" });
        navigate(createdId ? workspaceSessionRoute(createdId) : "/session", { replace: true });
        return true;
      } catch (error) {
        dispatch({
          type: "remote:error",
          error: error instanceof Error ? error.message : "Connection failed.",
        });
        return false;
      } finally {
        dispatch({ type: "remote:finish" });
      }
    },
    [markOnboardingComplete, navigate],
  );

  const handleGetStarted = useCallback(async () => {
    if (!isDesktopRuntime()) {
      // Non-desktop: fall back to the modal for remote workspace creation.
      dispatch({ type: "open" });
      return;
    }
    const picked = await pickDirectory({ title: t("onboarding.authorize_folder") });
    const folder = typeof picked === "string" ? picked : null;
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace]);

  const handleUseManualFolder = useCallback(async () => {
    const folder = manualFolder.trim();
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace, manualFolder]);

  const finishOnboarding = useCallback(() => {
    navigate(state.pendingRoute ?? "/session", { replace: true });
    if (state.pendingSessionId) focusPromptSoon();
  }, [navigate, state.pendingRoute, state.pendingSessionId]);

  // Attribution survey no longer reports analytics (events removed); it just
  // advances onboarding.
  const handleAttributionSubmit = useCallback(() => {
    finishOnboarding();
  }, [finishOnboarding]);

  const handleAttributionSkip = useCallback(() => {
    finishOnboarding();
  }, [finishOnboarding]);

  return (
    <>
      {!state.providerStep ? (
        <WelcomePage
          onGetStarted={handleGetStarted}
          getStartedLabel={t("welcome.pick_folder")}
          busy={state.createBusy}
          error={state.createError}
          manualFolder={manualFolder}
          onManualFolderChange={setManualFolder}
          onUseManualFolder={handleUseManualFolder}
          showManualFolder={import.meta.env.DEV && isDesktopRuntime()}
          analyticsEnabled={analyticsOptIn}
          onAnalyticsChange={setAnalyticsOptIn}
        />
      ) : null}
      <CreateWorkspaceModal
        open={state.modalOpen}
        onClose={() => dispatch({ type: "close" })}
        onConfirm={handleCreateWorkspace}
        onPickFolder={() =>
          pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<
            string | null
          >
        }
        submitting={state.createBusy}
        localError={state.createError}
        localDisabled={!isDesktopRuntime()}
        localDisabledReason={
          isDesktopRuntime()
            ? undefined
            : t("app.local_disabled_reason")
        }
      />
    </>
  );
}
