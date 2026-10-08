import { t } from "@/i18n";

export type ProjectView = "home" | "calendar" | "tasks" | "reviews" | "files" | "sessions";

export function isProjectView(value: unknown): value is ProjectView {
  return value === "home" || value === "calendar" || value === "tasks" || value === "reviews" || value === "files" || value === "sessions";
}

export function projectViewLabel(view: ProjectView) {
  return t(view === "home" ? "workspace.overview" : view === "calendar" ? "calendar.title" : view === "tasks" ? "projects.tasks" : view === "files" ? "projects.files" : view === "sessions" ? "projects.sessions" : "projects.tab_review");
}
