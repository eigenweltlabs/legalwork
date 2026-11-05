import { BookOpen } from "lucide-react";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { t } from "@/i18n";

/** Keep the document's own icon; distinguish its location in the secondary line. */
export function LauncherFileOrigin({ item }: { item: LauncherSearchResult }) {
  if (item.kind !== "files" || !item.subtitle) return <>{item.subtitle}</>;
  const kind = item.sourceKind ?? (item.folderId ? "folder" : undefined);
  if (!kind) return <>{item.subtitle}</>;
  return <span className="inline-flex max-w-full items-center gap-1 align-bottom" data-source-kind={kind}>
    {kind === "wiki" ? <BookOpen className="size-3 shrink-0" aria-hidden="true" /> : <FolderIcon className="size-3" />}
    <span className="truncate">{t(kind === "wiki" ? "wiki.title" : kind === "project" ? "launcher.flow.project" : "launcher.flow.folder")} · {item.subtitle}</span>
  </span>;
}
