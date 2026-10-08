// Shared pure helpers for the workspace-scoped routes (session-route,
// settings-route). These were duplicated in both route files and had drifted:
// settings-route was missing the remote-workspace clobber fix in
// mergeRouteWorkspaces and used older session-status logic. One copy now.

import type { Session } from "@opencode-ai/sdk/v2/client";

import type { LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import type { WorkspaceInfo } from "@/app/lib/desktop-types";
import type { WorkspaceSessionGroup } from "@/app/types";
import {
  normalizeDirectoryPath,
  normalizeSessionStatus,
  safeStringify,
} from "@/app/utils";
import { t } from "@/i18n";

export type RouteWorkspace = LegalworkWorkspaceInfo & {
  displayNameResolved: string;
};

/**
 * Sessions as the routes handle them: SDK sessions from
 * legalwork-server's listSessions, optionally enriched with run-status
 * fields that the sidebar probes defensively via getSessionStatus.
 */
export type RouteSession = Session & {
  status?: unknown;
  state?: unknown;
  runStatus?: unknown;
  slug?: string | null;
};

/** Runtime data can improve a listed session, but cannot resurrect a deleted one. */
export function preferLoadedSession(fetched: RouteSession[], loaded: RouteSession | null): RouteSession[] {
  if (!loaded) return fetched;
  return fetched.map(session => session.id === loaded.id && loaded.time.updated >= session.time.updated ? loaded : session);
}

export function mapDesktopWorkspace(workspace: WorkspaceInfo): RouteWorkspace {
  return {
    ...workspace,
    displayNameResolved:
      workspace.displayName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      t("session.workspace_fallback"),
  };
}

export function workspaceLabel(workspace: LegalworkWorkspaceInfo) {
  return (
    workspace.displayName?.trim() ||
    workspace.legalworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    t("session.workspace_fallback")
  );
}

export function workspaceExportFilename(workspace: LegalworkWorkspaceInfo) {
  const slug = workspaceLabel(workspace).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "workspace"}-legalwork-export.json`;
}

export function downloadWorkspaceJson(filename: string, payload: unknown) {
  if (typeof document === "undefined") return;
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

export function isTransientStartupError(message: string | null | undefined) {
  const value = (message ?? "").toLowerCase();
  return (
    value.includes("timed out") ||
    value.includes("failed to fetch") ||
    value.includes("connection") ||
    value.includes("not ready")
  );
}

export function describeRouteError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : t("app.unknown_error");
}

export function describeWorkspaceCreateError(error: unknown) {
  const message = describeRouteError(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("operation timed out") ||
    lower.includes("os error 60") ||
    lower.includes("etimedout")
  ) {
    return `${message}\n\nLegalWork could not read the workspace config before the filesystem timed out. This often happens when the folder is still syncing from iCloud Drive or another remote folder. Wait for the folder to finish downloading, move the workspace to a local folder, or try again.`;
  }
  return message;
}

export function mergeRouteWorkspaces(
  serverWorkspaces: LegalworkWorkspaceInfo[],
  desktopWorkspaces: RouteWorkspace[],
): RouteWorkspace[] {
  const desktopById = new Map(desktopWorkspaces.map((workspace) => [workspace.id, workspace]));
  const desktopByPath = new Map(
    desktopWorkspaces.flatMap((workspace) => {
      const path = normalizeDirectoryPath(workspace.path ?? "");
      return path ? [[path, workspace] as const] : [];
    }),
  );

  // If a server workspace's id matches a desktop workspace marked as remote,
  // skip the server's view entirely. The local LegalWork server may have stale
  // registrations from earlier (buggy) activate calls that show up here as
  // `workspaceType: "local"`, which would otherwise clobber the desktop's
  // remote routing fields and send workspace-scoped requests back to the
  // local server.
  const remoteDesktopIds = new Set(
    desktopWorkspaces.flatMap((workspace) => workspace.workspaceType === "remote" ? [workspace.id] : []),
  );
  const filteredServer = serverWorkspaces.filter((workspace) => !remoteDesktopIds.has(workspace.id));

  const mergedServer = filteredServer.map((workspace) => {
    const match =
      desktopById.get(workspace.id) ??
      desktopByPath.get(normalizeDirectoryPath(workspace.path ?? ""));
    // For local workspaces, prefer the server's view (which knows things like
    // `path` and per-workspace runtime fields) and only fall back to the
    // desktop's display name when the server doesn't provide one.
    const merged = match
      ? {
          ...workspace,
          displayName: workspace.displayName?.trim()
            ? workspace.displayName
            : match.displayName,
          name: match.name?.trim() ? match.name : workspace.name,
        }
      : workspace;
    return {
      ...merged,
      displayNameResolved: workspaceLabel(merged),
    };
  });

  const mergedIds = new Set(mergedServer.map((workspace) => workspace.id));
  const mergedPaths = new Set(
    mergedServer.flatMap((workspace) => {
      const path = normalizeDirectoryPath(workspace.path ?? "");
      return path ? [path] : [];
    }),
  );

  const missingDesktop = desktopWorkspaces.filter((workspace) => {
    // A successful server list is authoritative for local projects. The
    // desktop remembers selection/history, including firm projects removed
    // on sign-out. Reintroducing those entries makes every scoped API 404.
    if (workspace.workspaceType !== "remote") return false;
    if (mergedIds.has(workspace.id)) return false;
    const normalizedPath = normalizeDirectoryPath(workspace.path ?? "");
    if (normalizedPath && mergedPaths.has(normalizedPath)) return false;
    return true;
  });

  return [...mergedServer, ...missingDesktop];
}

/** Resolve saved IDs only against projects the current connection can serve. */
export function resolveRouteWorkspaceId(
  workspaces: RouteWorkspace[],
  preferredIds: Array<string | null | undefined>,
  desktopWorkspaces: RouteWorkspace[] = [],
): string {
  for (const value of preferredIds) {
    const id = value?.trim();
    if (!id) continue;
    if (workspaces.some((workspace) => workspace.id === id)) return id;
    const path = normalizeDirectoryPath(desktopWorkspaces.find((workspace) => workspace.id === id)?.path ?? "");
    if (!path) continue;
    const match = workspaces.find((workspace) => normalizeDirectoryPath(workspace.path ?? "") === path);
    if (match) return match.id;
  }
  return workspaces[0]?.id ?? "";
}

export function orderRouteWorkspaces(workspaces: RouteWorkspace[], orderIds: string[]): RouteWorkspace[] {
  if (orderIds.length === 0) return workspaces;

  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const ordered: RouteWorkspace[] = [];
  const usedIds = new Set<string>();
  const savedIds = new Set(orderIds);

  for (const workspace of workspaces) {
    if (savedIds.has(workspace.id) || usedIds.has(workspace.id)) continue;
    ordered.push(workspace);
    usedIds.add(workspace.id);
  }

  for (const id of orderIds) {
    const workspace = workspaceById.get(id);
    if (!workspace || usedIds.has(id)) continue;
    ordered.push(workspace);
    usedIds.add(id);
  }

  return ordered;
}

export function toSessionGroups(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, RouteSession[]>,
  errorsByWorkspaceId: Record<string, string | null>,
  loadingWorkspaceIds: Set<string>,
): WorkspaceSessionGroup[] {
  return workspaces.map((workspace) => ({
    workspace,
    sessions: sessionsByWorkspaceId[workspace.id] ?? [],
    status: loadingWorkspaceIds.has(workspace.id)
      ? "loading"
      : errorsByWorkspaceId[workspace.id]
        ? "error"
        : "ready",
    error: errorsByWorkspaceId[workspace.id],
  }));
}

export function isActiveSessionStatus(status: unknown) {
  return status === "running" || status === "retry" || status === "busy" || status === "streaming";
}

export function getSessionStatus(session: RouteSession | null | undefined) {
  const status = session?.status ?? session?.state ?? session?.runStatus ?? null;
  return typeof status === "string" ? status : normalizeSessionStatus(status);
}
