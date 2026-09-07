import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FolderOpen, X } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
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

type Props = {
  sessionId: string;
  client: LegalworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  target: OpenTarget;
  onClose: () => void;
};

export function ArtifactMarkdownPanel({ sessionId, client, workspaceId, workspaceRoot, isRemoteWorkspace, target, onClose }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<MarkdownDraft | null>(null);
  const draftRef = useRef<MarkdownDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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
  const onChange = useCallback((content: string) => update((current) => current ? { ...current, content } : current), [update]);

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
    if (savingRef.current || !draftRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      // Let the rich-text editor finish its current transaction before saving.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const snapshot = draftRef.current;
      if (snapshot.content === snapshot.baseline) return true;
      const result = await client.writeWorkspaceFile(workspaceId, { path: target.value, content: snapshot.content, baseUpdatedAt: snapshot.updatedAt });
      update((current) => current ? savedMarkdownDraft(current, snapshot.content, result.updatedAt ?? null) : current);
      queryClient.setQueryData(["markdown-editor", workspaceId, target.value], { ...result, content: snapshot.content });
      void queryClient.invalidateQueries({ queryKey: ["artifact-panel", workspaceId, target.id] });
      setSaveError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the document.";
      setSaveError(message);
      toast.error("Could not save Markdown", { description: "Your edits are still here. " + message });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [client, workspaceId, target.value, target.id, queryClient, update]);

  const imageUpload = useCallback(async (file: File) => {
    const directory = target.value.split("/").slice(0, -1).join("/");
    const relative = `_assets/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const result = await client.writeWorkspaceBinaryFile(workspaceId, { path: directory ? `${directory}/${relative}` : relative, data: await file.arrayBuffer() });
    if (!result.ok) throw new Error("Image upload failed.");
    return relative;
  }, [client, workspaceId, target.value]);
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
    sessionId, workspaceId, name: target.name, path: target.value, editable: Boolean(draft), agentEditsTracked: false,
  }), [target.id, target.name, target.value, sessionId, workspaceId, Boolean(draft)]);
  useControlSurface(surface);
  const action = useMemo<LegalworkControlAction>(() => ({
    id: "markdown.agent_tool", label: `Edit ${target.name}`, sideEffect: "mutation", requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true }, { name: "path", type: "string", required: true }, { name: "toolName", type: "string", required: true }, { name: "args", type: "object" }],
    execute: async (args) => {
      if (!args || typeof args !== "object" || Reflect.get(args, "sessionId") !== sessionId || Reflect.get(args, "path") !== target.value) return { ok: false, error: "Select the intended Markdown file first." };
      const current = draftRef.current;
      if (!current) return { ok: false, error: "The document is still loading." };
      const tool = Reflect.get(args, "toolName");
      if (tool === "read") return { ok: true, data: { markdown: current.content, unsavedChanges: current.content !== current.baseline } };
      if (savingRef.current) return { ok: false, error: "A save is already in progress." };
      if (tool === "save") return { ok: await save() };
      const values: unknown = Reflect.get(args, "args");
      if (tool !== "replace_text" || !values || typeof values !== "object") return { ok: false, error: "Use read, replace_text, or save." };
      const search: unknown = Reflect.get(values, "search");
      const replacement: unknown = Reflect.get(values, "replacement");
      if (typeof search !== "string" || typeof replacement !== "string") return { ok: false, error: "Provide search and replacement strings." };
      try {
        onChange(replaceMarkdownText(current.content, search, replacement));
        const saved = await save();
        return { ok: saved, saved, ...(saved ? {} : { error: "Edit remains in the editor. Retry save; do not repeat the edit." }) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Edit failed." }; }
    },
  }), [target.name, target.value, sessionId, save, onChange]);
  useControlAction(action);

  const download = () => {
    if (!draftRef.current) return;
    const url = URL.createObjectURL(new Blob([draftRef.current.content], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = target.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const absolutePath = `${workspaceRoot.replace(/\/$/, "")}/${target.value}`;
  const runFileAction = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not open the file."); }
  };
  return <div className="h-full min-h-0" onKeyDownCapture={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void save(); }
  }}>
    <ArtifactFrame expandable title={target.name} icon={<ArtifactIcon type="markdown" className="size-5" />}
      meta={<span role="status">{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>}
      actions={<>
        <Button size="sm" disabled={!draft || !dirty || saving} onClick={() => void save()}>Save</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Download artifact" title="Download Markdown" onClick={download} disabled={!draft}><Download /></Button>
        {!isRemoteWorkspace && <>
          <Button variant="ghost" size="icon-sm" aria-label="Show in folder" title="Show in folder" onClick={() => void runFileAction(() => revealDesktopItemInDir(absolutePath))}><FolderOpen /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Open externally" title="Open externally" onClick={() => void runFileAction(async () => {
            if (await save()) {
              if (draftRef.current?.content !== draftRef.current?.baseline) return;
              await openDesktopPath(absolutePath);
            }
          })}><ExternalLink /></Button>
        </>}
        <Button variant="ghost" size="icon-sm" aria-label="Close artifact" title="Close artifact" onClick={onClose} disabled={saving}><X /></Button>
      </>}
    >
      {saveError && <div role="alert" className="border-b border-border bg-muted px-4 py-2 text-xs">Your edits are still here. {saveError} Download a copy to keep them before reopening the file.</div>}
      <div className="min-h-0 flex-1 overflow-hidden">
        {draft ? <ArtifactMarkdownEditor value={draft.content} baseline={draft.baseline} onChange={onChange} imageUpload={imageUpload} imagePreview={imagePreview} />
          : query.isError ? <PreviewError message={query.error instanceof Error ? query.error.message : "Could not open Markdown."} /> : <PreviewLoading />}
      </div>
    </ArtifactFrame>
  </div>;
}
