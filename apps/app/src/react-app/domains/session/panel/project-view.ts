import { t } from "@/i18n";

export type ProjectView = "home" | "calendar" | "tasks" | "reviews" | "files" | "sessions" | "dashboards" | "back-office";

export function isProjectView(value: unknown): value is ProjectView {
  return value === "back-office" || value === "dashboards" || value === "home" || value === "calendar" || value === "tasks" || value === "reviews" || value === "files" || value === "sessions";
}

export function projectViewLabel(view: ProjectView) {
  if (view === "back-office") return t("sidebar.backOffice");
  return t(view === "dashboards" ? "views.dashboards" : view === "home" ? "workspace.overview" : view === "calendar" ? "calendar.title" : view === "tasks" ? "projects.tasks" : view === "files" ? "projects.files" : view === "sessions" ? "projects.sessions" : "projects.tab_review");
}
