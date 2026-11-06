import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { formatRelativeTime } from "@/app/utils";
import { t } from "@/i18n";
import { useLauncherShell } from "./launcher-shell";

/** The selected result, read locally: file text or prepared text, the last chat turns, a task, a transcript. Never a model call. */
export function LauncherPreviewPane({ result, detail = false }: { result: LauncherSearchResult; detail?: boolean }) {
  const { client } = useLauncherShell();
  const preview = useQuery({
    queryKey: ["launcher-preview", client.baseUrl, result.kind, result.workspaceId ?? "", result.folderId ?? "", result.id, result.revision],
    queryFn: ({ signal }) => client.launcherPreview({ kind: result.kind, id: result.kind === "chats" ? result.sessionId ?? result.id : result.id, workspaceId: result.workspaceId, folderId: result.folderId }, signal),
    staleTime: 30_000, retry: false,
  });
  return <aside className="launcher-preview" tabIndex={0} data-launcher-controls aria-label={detail ? result.title : t("launcher.result_action.preview")} aria-busy={preview.isPending}>
    <div className="launcher-preview-head"><strong>{preview.data?.title ?? result.title}</strong><span>{[...(preview.data?.meta ?? [result.subtitle]), preview.data?.updatedAt ? formatRelativeTime(preview.data.updatedAt) : null].filter(Boolean).join(" · ")}</span></div>
    {preview.isPending ? <p className="launcher-preview-note"><Loader2 className="inline size-3 animate-spin motion-reduce:animate-none" /> {t("launcher.preview.loading")}</p>
      : preview.isError ? <p className="launcher-preview-note">{preview.error instanceof Error ? preview.error.message : t("launcher.preview.unavailable")}</p>
      : preview.data.text ? <pre className="launcher-preview-text">{preview.data.text}</pre> : <p className="launcher-preview-note">{t("launcher.preview.unavailable")}</p>}
    {!detail && <p className="launcher-preview-note">{[preview.data?.truncated ? t("launcher.preview.truncated") : null, t("launcher.preview.not_sent")].filter(Boolean).join(" ")}</p>}
  </aside>;
}
