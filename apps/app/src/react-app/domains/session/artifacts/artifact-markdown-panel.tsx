import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FolderOpen, X } from "lucide-react";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { openDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ArtifactFrame } from "./artifact-frame";
import { ArtifactIcon } from "./artifact-icon";
import { PreviewError, PreviewLoading } from "./preview";
import { ArtifactMarkdownEditor } from "./artifact-markdown-editor";
import { artifactDocumentKey, registerUnsavedDocument } from "./docx-document-state";
import { loadMarkdownDraft, savedMarkdownDraft, replaceMarkdownText, type MarkdownDraft } from "./markdown-draft";
import { useControlAction, useControlSurface, type LegalworkControlAction, type LegalworkControlSurface } from "../../../shell/control/control-provider";
import type { OpenTarget } from "./open-target";
import { t } from "@/i18n";
import { projectFileDisplayName } from "../../workspace/project-note-title";

/** The file changed in the same place meanwhile: what is there now (the write route's 409). */
function overlapOf(details: unknown): { content: string; updatedAt: number } | null {
  if (typeof details !== "object" || details === null || !("reason" in details) || details.reason !== "overlap" || !("current" in details)) return null;
  const current = details.current;
  if (typeof current !== "object" || current === null || !("content" in current) || !("updatedAt" in current)) return null;
  return typeof current.content === "string" && typeof current.updatedAt === "number" ? { content: current.content, updatedAt: current.updatedAt } : null;
}

/** `Notes/Hallo-ee006b29.md` → `Notes/Hallo-ee006b29 (my version, 2026-09-27 14.03).md`, as sync names its copies. */
function copyPathOf(path: string, label: string, at: Date): string {
  const extension = /\.[^./]+$/.exec(path)?.[0] ?? "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  return `${path.slice(0, path.length - extension.length)} (${label}, ${stamp})${extension}`;
}

type Props = {
  sessionId: string;
  client: LegalworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  target: OpenTarget;
  localReadOnly?: boolean;
  saveActions?: (persist: () => Promise<boolean>, busy: boolean) => ReactNode;
  onClose: () => void;
};

export function ArtifactMarkdownPanel({ sessionId, client, workspaceId, workspaceRoot, isRemoteWorkspace, target, localReadOnly = false, saveActions, onClose }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<MarkdownDraft | null>(null);
  const draftRef = useRef<MarkdownDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clash, setClash] = useState<{ content: string; updatedAt: number } | null>(null);
  const imageUrls = useRef(new Map<string, string>());
  const update = useCallback((fn: (current: MarkdownDraft | null) => MarkdownDraft | null) => {
    draftRef.current = fn(draftRef.current);
    setDraft(draftRef.current);
  }, []);
  const query = useQuery({
    queryKey: ["markdown-editor", workspaceId, target.value],
    queryFn: () => client.readWorkspaceFile(workspaceId, target.value),
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (query.data) update((current) => loadMarkdownDraft(current, query.data.content, query.data.updatedAt ?? null));
  }, [query.data, update]);
  const dirty = Boolean(draft && draft.content !== draft.baseline);
  const onChange = useCallback((content: string) => {
    if (!localReadOnly) {
      setSaveError(null);
      update((current) => current ? { ...current, content } : current);
    }
  }, [update, localReadOnly]);

  useEffect(() => registerUnsavedDocument(artifactDocumentKey(workspaceId, sessionId, target.id), target.name,
    () => Boolean(draftRef.current && draftRef.current.content !== draftRef.current.baseline)),
  [sessionId, workspaceId, target.id, target.name]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftRef.current || draftRef.current.content === draftRef.current.baseline) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const save = useCallback(async () => {
    if (localReadOnly || savingRef.current || !draftRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      // Let the rich-text editor finish its current transaction before saving.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const snapshot = draftRef.current;
      if (snapshot.content === snapshot.baseline) return true;
      // With the text as loaded: a file changed since (a colleague's edit synced in) is merged, not refused.
      const result = await client.writeWorkspaceFile(workspaceId, { path: target.value, content: snapshot.content, baseUpdatedAt: snapshot.updatedAt, baseContent: snapshot.baseline });
      const written = result.content ?? snapshot.content;
      update((current) => {
        if (!current) return current;
        if (current.content === snapshot.content) return { content: written, baseline: written, updatedAt: result.updatedAt ?? null };
        // Typed on while saving: that stays, and behind the file, so the next save merges again.
        return result.merged ? { ...current, baseline: snapshot.content } : savedMarkdownDraft(current, snapshot.content, result.updatedAt ?? null);
      });
      queryClient.setQueryData(["markdown-editor", workspaceId, target.value], { ...result, content: written });
      void queryClient.invalidateQueries({ queryKey: ["artifact-panel", workspaceId, target.id] });
      void queryClient.invalidateQueries({ queryKey: ["project-notes", workspaceId] });
      if (result.merged) toast.info(t("markdown.merged_changes"));
      setSaveError(null);
      setClash(null);
      return true;
    } catch (error) {
      const overlap = error instanceof LegalworkServerError && error.status === 409 ? overlapOf(error.details) : null;
      if (overlap) {
        setClash(overlap);
        return false;
      }
      const message = error instanceof Error ? error.message : t("markdown.save_failed");
      setSaveError(message);
      toast.error(t("markdown.save_failed_toast"), { description: `${t("markdown.edits_still_here")} ${message}` });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [client, workspaceId, target.value, target.id, queryClient, update, localReadOnly]);

  const autosave = !isRemoteWorkspace && !localReadOnly && !saveActions;
  useEffect(() => {
    if (!autosave || !dirty || saving || clash || saveError) return;
    const timer = window.setTimeout(() => { void save(); }, 600);
    return () => window.clearTimeout(timer);
  }, [autosave, dirty, draft?.content, saving, clash, saveError, save]);

  const close = async () => {
    if (autosave && draftRef.current?.content !== draftRef.current?.baseline) {
      if (clash || !await save()) return;
      // An edit made during the write must also be saved before closing.
      if (draftRef.current?.content !== draftRef.current?.baseline) return;
    }
    onClose();
  };

  /** Changed in the same place elsewhere: keep both (mine as a copy beside it), take theirs, or keep mine over it. */
  const resolveClash = async (choice: "both" | "theirs" | "mine") => {
    const theirs = clash;
    const mine = draftRef.current;
    if (!theirs || !mine) return;
    setClash(null);
    if (choice === "mine") {
      // Written over what is there now, which it no longer conflicts with.
      update((current) => current ? { ...current, baseline: theirs.content, updatedAt: theirs.updatedAt } : current);
      await save();
      return;
    }
    if (choice === "both") {
      const copy = copyPathOf(target.value, t("markdown.my_version"), new Date());
      try {
        await client.writeWorkspaceFile(workspaceId, { path: copy, content: mine.content });
      } catch (error) {
        setClash(theirs);
        toast.error(t("markdown.save_failed_toast"), { description: error instanceof Error ? error.message : undefined });
        return;
      }
      toast.success(t("markdown.saved_as_copy", { name: projectFileDisplayName(copy, copy.split("/").at(-1) ?? copy) }));
      void queryClient.invalidateQueries({ queryKey: ["project-notes", workspaceId] });
    }
    update(() => ({ content: theirs.content, baseline: theirs.content, updatedAt: theirs.updatedAt }));
    queryClient.setQueryData(["markdown-editor", workspaceId, target.value], { content: theirs.content, updatedAt: theirs.updatedAt });
  };

  const imageUpload = useCallback(async (file: File) => {
    if (localReadOnly) throw new Error(t("storage.read_only"));
    const directory = target.value.split("/").slice(0, -1).join("/");
    const relative = `_assets/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const result = await client.writeWorkspaceBinaryFile(workspaceId, { path: directory ? `${directory}/${relative}` : relative, data: await file.arrayBuffer() });
    if (!result.ok) throw new Error(t("markdown.image_upload_failed"));
    return relative;
  }, [client, workspaceId, target.value, localReadOnly]);
  const imagePreview = useCallback(async (source: string) => {
    if (/^(https?:|data:|blob:)/i.test(source)) return source;
    const cached = imageUrls.current.get(source);
    if (cached) return cached;
    const directory = target.value.split("/").slice(0, -1).join("/");
    const result = await client.downloadWorkspaceFile(workspaceId, directory ? `${directory}/${source}` : source);
    const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
    imageUrls.current.set(source, url);
    return url;
  }, [client, workspaceId, target.value]);
  useEffect(() => () => { for (const url of imageUrls.current.values()) URL.revokeObjectURL(url); }, []);

  const surface = useMemo<LegalworkControlSurface>(() => ({
    id: target.id, kind: "document", format: "md",
    sessionId, workspaceId, name: target.name, path: target.value, editable: Boolean(draft) && !localReadOnly, agentEditsTracked: false,
  }), [target.id, target.name, target.value, sessionId, workspaceId, Boolean(draft), localReadOnly]);
  useControlSurface(surface);
  const action = useMemo<LegalworkControlAction>(() => ({
    id: "markdown.agent_tool", label: `Edit ${target.name}`, sideEffect: "mutation", requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true }, { name: "path", type: "string", required: true }, { name: "toolName", type: "string", required: true }, { name: "args", type: "object" }],
    execute: async (args) => {
      if (!args || typeof args !== "object" || Reflect.get(args, "sessionId") !== sessionId || Reflect.get(args, "path") !== target.value) return { ok: false, error: t("markdown.select_file_first") };
      const current = draftRef.current;
      if (!current) return { ok: false, error: t("markdown.still_loading") };
      const tool = Reflect.get(args, "toolName");
      if (tool === "read") return { ok: true, data: { markdown: current.content, unsavedChanges: current.content !== current.baseline } };
      if (localReadOnly) return { ok: false, error: t("storage.read_only") };
      if (savingRef.current) return { ok: false, error: t("markdown.save_in_progress") };
      if (tool === "save") return { ok: await save() };
      const values: unknown = Reflect.get(args, "args");
      if (tool !== "replace_text" || !values || typeof values !== "object") return { ok: false, error: t("markdown.unknown_tool") };
      const search: unknown = Reflect.get(values, "search");
      const replacement: unknown = Reflect.get(values, "replacement");
      if (typeof search !== "string" || typeof replacement !== "string") return { ok: false, error: t("markdown.search_replace_required") };
      try {
        onChange(replaceMarkdownText(current.content, search, replacement));
        const saved = await save();
        return { ok: saved, saved, ...(saved ? {} : { error: t("markdown.edit_remains") }) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : t("markdown.edit_failed") }; }
    },
  }), [target.name, target.value, sessionId, save, onChange, localReadOnly]);
  useControlAction(action);

  const download = () => {
    if (!draftRef.current) return;
    const url = URL.createObjectURL(new Blob([draftRef.current.content], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = target.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const absolutePath = `${workspaceRoot.replace(/\/$/, "")}/${target.value}`;
  const runFileAction = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { toast.error(error instanceof Error ? error.message : t("markdown.open_file_failed")); }
  };
  return <div className="h-full min-h-0" onBlurCapture={(event) => {
    if (autosave && !clash && !saveError && !event.currentTarget.contains(event.relatedTarget)) void save();
  }} onKeyDownCapture={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void save(); }
  }}>
    <ArtifactFrame expandable title={projectFileDisplayName(target.value, target.name)} icon={<ArtifactIcon type="markdown" className="size-5" />}
      meta={<span role="status" title={autosave ? t("markdown.autosave_hint") : undefined}>{saving ? t("common.saving") : dirty ? t("common.unsaved_changes") : t("common.saved")}</span>}
      actions={<>
        {saveActions ? saveActions(save, saving || !draft) : <Button size="sm" disabled={localReadOnly || !draft || !dirty || saving} onClick={() => void save()}>{t("common.save")}</Button>}
        <Button variant="ghost" size="icon-sm" aria-label={t("artifact.download")} title={t("artifact.download_markdown")} onClick={download} disabled={!draft}><Download /></Button>
        {!isRemoteWorkspace && <>
          <Button variant="ghost" size="icon-sm" aria-label={t("artifact.show_in_folder")} title={t("artifact.show_in_folder")} onClick={() => void runFileAction(() => revealDesktopItemInDir(absolutePath))}><FolderOpen /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t("markdown.open_externally")} title={t("markdown.open_externally")} onClick={() => void runFileAction(async () => {
            if (localReadOnly || await save()) {
              if (draftRef.current?.content !== draftRef.current?.baseline) return;
              await openDesktopPath(absolutePath);
            }
          })}><ExternalLink /></Button>
        </>}
        <Button variant="ghost" size="icon-sm" aria-label={t("artifact.close")} title={t("artifact.close")} onClick={() => void close()} disabled={saving}><X /></Button>
      </>}
    >
      {clash ? <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs">
          <span className="min-w-0 flex-1">{t("markdown.conflict_body")}</span>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void resolveClash("both")}>{t("markdown.keep_both")}</Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void resolveClash("theirs")}>{t("markdown.use_theirs")}</Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void resolveClash("mine")}>{t("markdown.keep_mine")}</Button>
        </div> : saveError && <div role="alert" className="border-b border-border bg-muted px-4 py-2 text-xs">
          {t("markdown.edits_still_here_download", { error: saveError })}
        </div>}
      <div className="min-h-0 flex-1 overflow-hidden">
        {draft ? <ArtifactMarkdownEditor value={draft.content} baseline={draft.baseline} readOnly={localReadOnly} onChange={onChange} imageUpload={imageUpload} imagePreview={imagePreview} />
          : query.isError ? <PreviewError message={query.error instanceof Error ? query.error.message : t("markdown.open_failed")} /> : <PreviewLoading />}
      </div>
    </ArtifactFrame>
  </div>;
}
