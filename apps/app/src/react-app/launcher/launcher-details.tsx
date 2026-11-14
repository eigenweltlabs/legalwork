import { taskStatusLabel } from "../domains/tasks/task-format";
import { compareLauncherResults } from "@legalwork/types/launcher";
import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LauncherFileFilter, LauncherSearchKind, LauncherSearchResult } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isMacPlatform } from "@/app/utils";
import type { LegalworkTaskPatch, LegalworkTaskStatus } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useLauncherShell } from "./launcher-shell";
import { LauncherForm, LauncherSubmitHint, type LauncherFormState } from "./launcher-form";
import { handleLauncherFocusKey } from "./launcher-focus";
import { isComposingKeyEvent, isLauncherConfirmKey } from "./launcher-keyboard";
import { matchesLauncherFileFilter, namedFileTypeFilter } from "./launcher-typed-filters";

export type LauncherDetail = { result: LauncherSearchResult; category?: LauncherSearchKind };
export function useLauncherDetailItems(detail: LauncherDetail | null, query: string, filter: LauncherFileFilter) {
  const { client } = useLauncherShell();
  const result = detail?.result;
  const directory = result?.fileType === "folder" || result?.kind === "projects" && detail?.category === "files";
  const category = result?.kind === "projects" ? detail?.category : undefined;
  const fileType = directory && !filter.types?.length ? namedFileTypeFilter(query) : null;
  const fileQuery = fileType ? "" : query.trim().toLocaleLowerCase();
  const fileFilter = fileType ? { ...filter, types: fileType.extensions } : filter;
  return useQuery<{ items: LauncherSearchResult[]; truncated: boolean }>({
    queryKey: ["launcher-detail-items", client.baseUrl, result?.workspaceId, result?.folderId, result?.path, category, directory ? null : query, directory ? null : filter],
    enabled: Boolean(result && (directory || category)),
    staleTime: 0, refetchInterval: directory ? 2000 : false, refetchOnWindowFocus: "always",
    select: response => {
      const items = directory ? response.items.filter(item => item.title.toLocaleLowerCase().includes(fileQuery) && matchesLauncherFileFilter(item, fileFilter)) : [...response.items];
      if (filter.sort && filter.sort !== "relevance") items.sort((a, b) => compareLauncherResults(a, b, filter.sort));
      return { ...response, items };
    },
    queryFn: async ({ signal }) => {
      if (!result) return { items: [], truncated: false };
      if (directory) {
        return client.launcherBrowse({ workspaceId: result.workspaceId ?? undefined, folderId: result.folderId, path: result.path ?? "" }, signal);
      }
      const response = await client.launcherSearch({ query, kinds: category ? [category] : [], projectId: result.workspaceId, fileTypes: filter.types, modifiedAfter: filter.modifiedAfter, sourceKind: filter.sourceKind, sort: filter.sort }, signal);
      return { items: response.items, truncated: response.sources.some(source => source.limited) };
    },
  });
}

export function LauncherTaskDetail({ result, onOpenChat, onOpenApp, onUpdated, onFormStateChange }: { result: LauncherSearchResult; onUpdated: (result: LauncherSearchResult) => void; onOpenChat: (sessionId: string, workspaceId: string) => void; onOpenApp: () => void; onFormStateChange?: (state: LauncherFormState) => void }) {
  const { client, assistant, workspaces } = useLauncherShell();
  const workspaceId = result.workspaceId ?? assistant?.workspaceId ?? workspaces[0]?.id;
  const task = useQuery({ queryKey: ["launcher-task", client.baseUrl, workspaceId, result.id], enabled: Boolean(workspaceId), queryFn: () => client.getTask(workspaceId ?? "", result.id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ title: string; description: string; status: LegalworkTaskStatus; dueDate: string } | null>(null);
  const section = useRef<HTMLElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  useLayoutEffect(() => { section.current?.focus(); }, []);
  useLayoutEffect(() => { if (busy && !editing) section.current?.focus(); }, [busy, editing]);
  const closeEditor = () => { setEditing(null); requestAnimationFrame(() => editButton.current?.focus()); };
  const update = async (patch: LegalworkTaskPatch) => {
    if (!task.data || !workspaceId || running.current) return;
    running.current = true;
    setBusy(true); setError(null);
    try { await client.patchTask(workspaceId, result.id, patch); const refreshed = await task.refetch();
      if (refreshed.data) onUpdated({ ...result, title: refreshed.data.task.title, completed: refreshed.data.task.status === "done", status: refreshed.data.task.status, updatedAt: Date.parse(refreshed.data.task.updatedAt) });
      if (editing) closeEditor(); }
    catch (error) { setError(String(error)); }
    finally { running.current = false; setBusy(false); }
  };
  const item = task.data?.task;
  const changeStatus = () => { if (item) void update({ status: item.status === "done" ? "open" : "done" }); };
  const statuses: LegalworkTaskStatus[] = ["open", "in_progress", "done", "cancelled"];
  if (editing) return <LauncherForm title={t("tasks.edit")} busy={busy} onStateChange={onFormStateChange} onClose={closeEditor} onSubmit={() => { if (editing.title.trim()) void update({ ...editing, title: editing.title.trim(), dueDate: item && editing.dueDate === item.dueDate?.slice(0, 10) ? item.dueDate : editing.dueDate || null }); }}>
    <fieldset disabled={busy} className="contents">
      <label>{t("tasks.field_title")}<Input autoFocus required maxLength={200} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
      <div className="launcher-form-row">
        <label>{t("tasks.column_status")}<select value={editing.status} onChange={event => { const status = statuses.find(status => status === event.target.value); if (status) setEditing({ ...editing, status }); }}>{statuses.map(status => <option key={status} value={status}>{taskStatusLabel(status)}</option>)}</select></label>
        <label>{t("tasks.sort_due")}<Input type="date" value={editing.dueDate} onChange={event => setEditing({ ...editing, dueDate: event.target.value })} /></label>
      </div>
      <label>{t("tasks.field_description")}<textarea rows={4} value={editing.description} onChange={event => setEditing({ ...editing, description: event.target.value })} /></label>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="launcher-form-actions"><Button type="button" variant="ghost" onClick={closeEditor}>{t("common.cancel")}<kbd>Esc</kbd></Button><Button type="submit" disabled={!editing.title.trim()}>{t(busy ? "launcher.flow.saving" : "common.save")}<LauncherSubmitHint /></Button></div>
    </fieldset>
  </LauncherForm>;
  return <section ref={section} tabIndex={-1} data-launcher-controls className="launcher-detail-content" aria-label={item?.title ?? result.title}
    onFocusCapture={event => { if (event.target !== section.current) event.target.scrollIntoView({ block: "nearest" }); }}
    onKeyDown={event => {
      if (event.defaultPrevented || isComposingKeyEvent(event)) return;
      if (isLauncherConfirmKey(event, isMacPlatform())) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) changeStatus(); }
      else if (event.key === "Enter" && event.target === section.current) { event.preventDefault(); if (!event.repeat) editButton.current?.click(); }
      else handleLauncherFocusKey(event, section.current, true);
    }}>
    <strong>{item?.title ?? result.title}</strong>
    {task.isPending ? <p>{t("launcher.preview.loading")}</p> : task.isError ? <><p role="alert">{String(task.error)}</p><Button onClick={() => void task.refetch()}>{t("launcher.submission.retry")}</Button></> : <>
      <p className="text-muted-foreground">{[item && taskStatusLabel(item.status), item?.dueDate, item?.assigneeName].filter(Boolean).join(" · ")}</p>
      <div className="launcher-detail-controls">
        <Button ref={editButton} variant="outline" size="sm" disabled={busy || !item} onClick={() => { if (item) { setError(null); setEditing({ title: item.title, description: item.description, status: item.status, dueDate: item.dueDate?.slice(0, 10) ?? "" }); } }}>{t("common.edit")}<kbd>↵</kbd></Button>
        <Button variant="outline" size="sm" disabled={busy || !item} onClick={changeStatus}>{t(item?.status === "done" ? "launcher.detail.reopen_task" : "launcher.result_action.complete")}<LauncherSubmitHint /></Button>
        <Button variant="ghost" size="sm" onClick={onOpenApp}>{t("launcher.result_action.open-in-app")}</Button>
      </div>
      <p className="whitespace-pre-wrap">{item?.description || t("tasks.description_empty")}</p>
      {task.data?.notes.map(note => <p key={note.id} className="whitespace-pre-wrap">{note.body}</p>)}
      {item?.sessions.map(link => <Button key={link.sessionId} variant="ghost" size="sm" onClick={() => onOpenChat(link.sessionId, link.workspaceId)}>{t("launcher.detail.open_chat")}</Button>)}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
