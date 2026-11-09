import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function projectErrorMessage(error: unknown, creating = false): string {
  if (error instanceof LegalworkServerError) {
    if (error.code === "project_templates_conflict") return t("projects.templates.conflict");
    if (error.code === "invalid_project_template") return t("projects.templates.invalid");
    if (error.code === "project_changed") return t("projects.conflict");
    if (error.code === "project_folder_unavailable") return t(creating ? "projects.create_folder_failed" : "projects.folder_unavailable");
    if (error.code === "invalid_project_metadata") return t("projects.metadata_invalid");
    if (error.code === "project_already_initialized") return t("projects.matters.existing_folder");
    if (error.code === "project_reference_directory_changed" || error.code === "project_reference_filter_mismatch") return t("projects.matters.selection_changed");
    if (error.status === 401 || error.status === 403) return t("projects.access_error");
  }
  return t("projects.failed");
}
