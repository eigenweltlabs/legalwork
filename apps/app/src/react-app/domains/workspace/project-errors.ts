import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function projectErrorMessage(error: unknown, creating = false): string {
  if (error instanceof LegalworkServerError) {
    if (error.code === "project_changed") return t("projects.conflict");
    if (error.code === "project_folder_unavailable") return t(creating ? "projects.create_folder_failed" : "projects.folder_unavailable");
    if (error.code === "invalid_project_metadata") return t("projects.metadata_invalid");
    if (error.status === 401 || error.status === 403) return t("projects.access_error");
  }
  return t("projects.failed");
}
