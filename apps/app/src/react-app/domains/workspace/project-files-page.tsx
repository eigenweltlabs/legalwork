import type { ComponentProps } from "react";
import { t } from "@/i18n";
import { WorkspaceFilesPanel } from "../session/panel/workspace-files-panel";
import { LegalMemoryFilesPanel } from "../session/panel/legalmemory-files-panel";

export function ProjectFilesPage({ local, connected }: {
  local: ComponentProps<typeof WorkspaceFilesPanel>;
  connected: ComponentProps<typeof LegalMemoryFilesPanel>;
}) {
  return <section className="@container/files flex h-full min-h-0 flex-col overflow-auto">
    <div className="lw-project-page-content lw-project-page-top flex min-h-full flex-col pb-6">
      <header className="shrink-0 pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">{t("projects.files")}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("project_browser.files_description")}</p>
      </header>
      <div className="grid min-h-[32rem] flex-1 grid-rows-2 gap-4 @min-[720px]/files:grid-cols-2 @min-[720px]/files:grid-rows-1">
        <section className="min-h-64 min-w-0 overflow-hidden rounded-xl border border-border/70" aria-label={t("session.workspace_files")}><WorkspaceFilesPanel {...local} searchable /></section>
        <section className="min-h-64 min-w-0 overflow-hidden rounded-xl border border-border/70" aria-label={t("project_browser.connected_files")}><LegalMemoryFilesPanel {...connected} title={t("project_browser.connected_files")} /></section>
      </div>
    </div>
  </section>;
}
