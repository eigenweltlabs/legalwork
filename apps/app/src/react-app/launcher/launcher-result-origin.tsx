import { BookOpen } from "lucide-react";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { t } from "@/i18n";

/** The primary icon describes the result; the secondary icon identifies its origin. */
export function LauncherResultOrigin({ item }: { item: Pick<LauncherSearchResult, "subtitle" | "sourceKind" | "folderId"> }) {
  if (!item.subtitle) return null;
  const kind = item.sourceKind ?? (item.folderId ? "folder" : undefined);
  if (!kind) return <>{item.subtitle}</>;
  const label = t(kind === "wiki" ? "wiki.title" : kind === "project" ? "launcher.flow.project" : "launcher.flow.folder");
  return <span className="inline-flex max-w-full items-center gap-1 align-bottom" data-source-kind={kind}>
    <span className="inline-flex shrink-0" role="img" aria-label={label} title={label}>{kind === "wiki" ? <BookOpen className="size-3" aria-hidden="true" /> : <FolderIcon className="size-3" />}</span>
    <span className="truncate">{item.subtitle}</span>
  </span>;
}
