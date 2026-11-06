import type { LauncherSearchResult } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { resultKey } from "./launcher-search-session";
import { t } from "@/i18n";

export function canCopyLauncherResult(result: LauncherSearchResult, localFiles: boolean) {
  return result.kind === "files" ? localFiles && Boolean(result.workspaceId || result.folderId) : result.kind === "recordings";
}

/** Copy complete source text, rather than the truncated search excerpt. */
export async function launcherClipboardText(result: LauncherSearchResult, client: Pick<LegalworkServerClient, "recordingTranscript">) {
  if (result.kind === "recordings") {
    const parts: string[] = [];
    let offset = 0;
    while (true) {
      const page = await client.recordingTranscript(result.id, { offset, limit: 20000 });
      parts.push(page.content);
      if (page.nextOffset === null) break;
      if (page.nextOffset <= offset) throw new Error(t("launcher.notice.copy_failed"));
      offset = page.nextOffset;
    }
    const transcript = parts.join("");
    if (!transcript.trim()) throw new Error(t("launcher.notice.transcript_unavailable"));
    return transcript;
  }
  throw new Error(t("launcher.notice.copy_failed"));
}

/** Validate live sources before handing local paths to the OS; includes Wiki files. */
export async function launcherLocalPaths(items: LauncherSearchResult[], client: Pick<LegalworkServerClient, "visibleLauncherFiles" | "listWorkspaces" | "launcherFolders" | "launcherFolderFile">) {
  if (!items.length || items.some(item => item.kind !== "files")) throw new Error(t("launcher.notice.copy_failed"));
  for (let offset = 0; offset < items.length; offset += 100) {
    const batch = items.slice(offset, offset + 100).map(({ excerpt: _excerpt, sources: _sources, ...item }) => item);
    const { items: visible } = await client.visibleLauncherFiles(batch);
    if (batch.some(item => !visible.some(found => resultKey(found) === resultKey(item)))) throw new Error(t("launcher.chat.context_unavailable"));
  }
  const workspaces = items.some(item => item.workspaceId && !item.folderId) ? await client.listWorkspaces() : null;
  const folders = items.some(item => item.folderId && item.fileType === "folder") ? await client.launcherFolders() : null;
  return Promise.all(items.map(async item => {
    if (item.folderId && item.fileType !== "folder") return (await client.launcherFolderFile(item.folderId, item.path ?? item.id)).path;
    const root = item.folderId ? folders?.folders.find(folder => folder.id === item.folderId)?.path
      : (workspaces?.items ?? workspaces?.workspaces ?? []).find(workspace => workspace.id === item.workspaceId)?.path;
    if (!root) throw new Error(t("launcher.chat.context_unavailable"));
    return `${root.replace(/[\\/]+$/, "")}/${item.path ?? item.id}`;
  }));
}
