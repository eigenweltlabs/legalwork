import {
  engineInfo,
  engineStart,
  legalworkServerInfo,
  type EngineInfo,
  type LegalworkServerInfo,
} from "../../app/lib/desktop";
import { readLegalworkServerSettings, writeLegalworkServerSettings } from "../../app/lib/legalwork-server";
import { safeStringify } from "../../app/utils";
import { recordInspectorEvent } from "../../app/lib/app-inspector";
import { t } from "@/i18n";

type LocalWorkspaceLike = {
  id: string;
  name?: string | null;
  displayNameResolved?: string | null;
  path?: string | null;
  workspaceType?: "local" | "remote" | string | null;
};

type EnsureDesktopLocalLegalworkOptions = {
  route: "session" | "settings";
  workspace: LocalWorkspaceLike | null | undefined;
  allWorkspaces: LocalWorkspaceLike[];
};

function emitLegalworkSettingsChanged() {
  try {
    window.dispatchEvent(new CustomEvent("legalwork-server-settings-changed"));
  } catch {
    // ignore browser event dispatch failures
  }
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : t("control.unknown_error");
}

export async function ensureDesktopLocalLegalworkConnection(
  options: EnsureDesktopLocalLegalworkOptions,
) {
  const workspace = options.workspace;
  const workspaceRoot = workspace?.path?.trim() ?? "";
  if (!workspace || workspace.workspaceType !== "local" || !workspaceRoot) {
    return null;
  }

  const workspacePaths = Array.from(
    new Set(
      options.allWorkspaces.flatMap((item) => {
        const path = item.workspaceType === "local" ? item.path?.trim() ?? "" : "";
        return path ? [path] : [];
      }),
    ),
  );
  if (!workspacePaths.includes(workspaceRoot)) {
    workspacePaths.unshift(workspaceRoot);
  }

  recordInspectorEvent("route.local_legalwork.ensure.start", {
    route: options.route,
    workspaceId: workspace.id,
    workspaceRoot,
  });

  try {
    const engine = await engineInfo().catch(() => null) as EngineInfo | null;
    if (!engine?.running || !engine.baseUrl) {
      await engineStart(workspaceRoot, {
        runtime: "direct",
        workspacePaths,
        legalworkRemoteAccess: readLegalworkServerSettings().remoteAccessEnabled === true,
      });
    }

    const info = await legalworkServerInfo() as LegalworkServerInfo | null;
    if (!info?.baseUrl) {
      throw new Error(t("desktop.no_base_url"));
    }

    writeLegalworkServerSettings({
      urlOverride: info.baseUrl,
      token: info.ownerToken?.trim() || info.clientToken?.trim() || undefined,
      hostToken: info.hostToken?.trim() || undefined,
      portOverride: info.port ?? undefined,
      remoteAccessEnabled: info.remoteAccessEnabled === true,
    });
    emitLegalworkSettingsChanged();

    recordInspectorEvent("route.local_legalwork.ensure.success", {
      route: options.route,
      workspaceId: workspace.id,
      workspaceRoot,
      baseUrl: info.baseUrl,
    });

    return info;
  } catch (error) {
    const message = describeError(error);
    console.error(`[${options.route}-route] local workspace reconnect failed`, error);
    recordInspectorEvent("route.local_legalwork.ensure.error", {
      route: options.route,
      workspaceId: workspace.id,
      workspaceRoot,
      message,
    });
    throw new Error(message);
  }
}
