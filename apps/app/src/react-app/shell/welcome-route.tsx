/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { t } from "../../i18n";
import { pickDirectory, resolveWorkspaceListSelectedId, workspaceSetRuntimeActive, workspaceSetSelected } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { useLocal } from "../kernel/local-provider";
import { WelcomePage, type ProjectCreatePhase } from "../domains/onboarding/welcome-page";
import type { CreateProjectInput } from "../domains/workspace/create-project-modal";
import { newProjectFields } from "../domains/workspace/project-defaults-store";
import { projectErrorMessage } from "../domains/workspace/project-errors";
import { resolveLegalworkConnection } from "./legalwork-connection";
import { analyticsSurface, captureAnalyticsEvent, discardPendingAnalytics, getStoredAnalyticsConsent } from "../../app/lib/analytics";
import { captureAppError } from "../../app/lib/app-error";
import { createLegalworkServerClient } from "../../app/lib/legalwork-server";
import { writeActiveWorkspaceId } from "./session-memory";
import { homeRoute } from "./workspace-routes";
import { ensureDesktopLocalLegalworkConnection } from "./desktop-local-legalwork";

/** First launch creates a named project, then continues the in-app setup. */
export function WelcomeRoute() {
  const navigate = useNavigate();
  const local = useLocal();
  const creating = useRef(false);
  const createdProjectId = useRef<string | null>(null);
  const [createPhase, setCreatePhase] = useState<ProjectCreatePhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Commit consent only after creation succeeds; preserve a previous opt-out.
  const [analyticsEnabled, setAnalyticsEnabled] = useState(() => getStoredAnalyticsConsent() ?? true);

  useEffect(() => {
    // React Router may commit navigation after the preferences update. Do not
    // replace the new project's destination with the returning-user redirect.
    if (local.prefs.hasCompletedOnboarding && !createdProjectId.current) {
      navigate("/home", { replace: true });
    }
  }, [local.prefs.hasCompletedOnboarding, navigate]);

  useEffect(() => {
    if (local.prefs.hasCompletedOnboarding) return;
    captureAnalyticsEvent("onboarding_welcome_viewed", { surface: analyticsSurface() });
    // Mount-only: one view event per visit to the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateProject = useCallback(async (input: CreateProjectInput) => {
    if (creating.current || !input.name.trim()) return;
    creating.current = true;
    setError(null);
    setCreatePhase("project");
    captureAnalyticsEvent("onboarding_started", { surface: analyticsSurface() });
    try {
      const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = await resolveLegalworkConnection();
      if (!normalizedBaseUrl || !(resolvedToken || resolvedHostToken)) {
        setError(t("welcome.project_server_unavailable"));
        return;
      }
      const client = createLegalworkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken || undefined,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await client.createLocalWorkspace({ ...input, preset: "starter", projectFields: newProjectFields() });
      const createdId = resolveWorkspaceListSelectedId(list);
      const workspace = list.workspaces.find((item) => item.id === createdId);
      if (!createdId || !workspace) throw new Error("Created project missing from server response");
      writeActiveWorkspaceId(createdId);
      if (isDesktopRuntime()) {
        setCreatePhase("engine");
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
        // The project is already saved; startup can be retried by the session route.
        await ensureDesktopLocalLegalworkConnection({ route: "session", workspace, allWorkspaces: list.workspaces }).catch(() => undefined);
      }
      captureAnalyticsEvent("workspace_created", { source: "onboarding", surface: analyticsSurface() });
      if (!analyticsEnabled) discardPendingAnalytics();
      createdProjectId.current = createdId;
      local.setPrefs((prev) => ({
        ...prev,
        analyticsEnabled,
        hasCompletedOnboarding: true,
        onboardingStage: isDesktopRuntime() ? "office" : "permissions",
      }));
      navigate(homeRoute(createdId), { replace: true });
    } catch (error) {
      captureAppError("workspace_create", error);
      setError(projectErrorMessage(error, true));
    } finally {
      creating.current = false;
      setCreatePhase(null);
    }
  }, [analyticsEnabled, local, navigate]);

  return (
    <WelcomePage
      onCreateProject={handleCreateProject}
      onPickFolder={isDesktopRuntime() ? async () => {
        const picked = await pickDirectory({ title: t("projects.location") });
        return typeof picked === "string" ? picked : null;
      } : undefined}
      busy={createPhase !== null}
      busyPhase={createPhase}
      error={error}
      totalSteps={isDesktopRuntime() ? 5 : 3}
      analyticsEnabled={analyticsEnabled}
      onAnalyticsChange={setAnalyticsEnabled}
    />
  );
}
