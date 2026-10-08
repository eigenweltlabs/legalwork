import { isProjectView, type ProjectView } from "../domains/session/panel/project-view";
import type { SettingsTab } from "../../app/types";

export function homeRoute(projectId?: string | null) {
  const project = projectId?.trim();
  return project ? `/home?project=${encodeURIComponent(project)}` : "/home";
}

export function homeProjectIdFromSearch(search: string) {
  return new URLSearchParams(search).get("project")?.trim() || null;
}

export function workspaceSessionRoute(workspaceId: string, sessionId?: string | null) {
  const workspace = encodeURIComponent(workspaceId.trim());
  const session = sessionId?.trim();
  return session
    ? `/workspace/${workspace}/session/${encodeURIComponent(session)}`
    : `/workspace/${workspace}/session`;
}

/** Last-session restoration belongs only to an empty chat route, never a project page. */
export function isSessionIndexRoute(pathname: string) {
  return /^(?:\/workspace\/[^/]+)?\/session\/?$/.test(pathname);
}

export function workspaceSettingsRoute(
  workspaceId: string,
  tab: SettingsTab | "extensions/mcp" | "extensions/plugins" | string = "general",
) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/settings/${tab}`;
}

export function globalSettingsRoute(tab: SettingsTab) {
  return `/settings/${tab}`;
}

export function legacySessionRoute(sessionId?: string | null) {
  const session = sessionId?.trim();
  return session ? `/session/${encodeURIComponent(session)}` : "/session";
}

export function workspaceProjectRoute(workspaceId: string) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/project`;
}

export function workspaceTasksRoute(workspaceId: string) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/tasks`;
}

export function workspaceReviewsRoute(workspaceId: string, reviewId?: string) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/reviews${reviewId ? `?review=${encodeURIComponent(reviewId)}` : ""}`;
}

export function workspaceCalendarRoute(workspaceId: string) { return `/workspace/${encodeURIComponent(workspaceId.trim())}/calendar`; }

export function workspaceViewRoute(workspaceId: string, view: ProjectView) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/${view === "home" ? "project" : view}`;
}

export function projectViewFromPath(pathname: string): ProjectView | undefined {
  const match = /^\/workspace\/[^/]+\/([^/]+)\/?$/.exec(pathname);
  const view = match?.[1] === "project" ? "home" : match?.[1];
  return isProjectView(view) ? view : undefined;
}

/** Routed main panes are derived synchronously so content and sidebar cannot disagree. */
export function sessionMainPage(pathname: string) {
  switch (pathname) {
    case "/projects": return "projects";
    case "/tasks": return "tasks";
    case "/scheduled": return "scheduled";
    case "/calendar": return "calendar";
    case "/workflows": return "workflows";
    case "/recorder": return "recorder";
    case "/evals": return "evals";
    default: return /^\/workspace\/[^/]+\/evals$/.test(pathname) ? "evals" : null;
  }
}
