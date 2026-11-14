import type { TranslationKey } from "./launcher-labels";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AssistantContextItem } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { useLauncherShell } from "./launcher-shell";
import { launcherFileRoute } from "./launcher-handoff";
import type { LegalworkTask } from "@/app/lib/legalwork-server";
import { LauncherForm, LauncherSubmitHint, type LauncherFormState } from "./launcher-form";
import { LauncherSelect } from "./launcher-select";
import { LauncherFolderPicker, launcherFolderLabel } from "./launcher-folder-picker";

const createKeys = {
  document: "launcher.flow.create_document",
  excerpt: "launcher.flow.create_excerpt",
  task: "launcher.flow.create_task",
  attach: "launcher.flow.create_attach",
} satisfies Record<LauncherCreate["kind"], TranslationKey>;

export type LauncherCreate = { kind: "document" | "excerpt" | "task" | "attach"; workspaceId: string; folder: string; name: string; text: string; context: AssistantContextItem[] };
export function LauncherCreateForm({ initial, onClose, onAttach, onDraft, onTaskCreated, onFormStateChange }: { initial: LauncherCreate; onClose: () => void; onFormStateChange?: (state: LauncherFormState) => void;
  onAttach: (workspaceId: string, sessionId: string | undefined, items: AssistantContextItem[]) => Promise<void>;
  onDraft: (workspaceId: string, folder: string, name: string, format: string, instructions: string) => Promise<void>;
  onTaskCreated: (task: LegalworkTask, workspaceId: string) => void;
}) {
  const { client, workspaces, openInApp } = useLauncherShell();
  const [workspaceId, setWorkspace] = useState(initial.workspaceId);
  const [folder, setFolder] = useState(initial.folder);
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.text);
  const [format, setFormat] = useState<"md" | "txt" | "docx">(initial.name.endsWith(".docx") ? "docx" : initial.name.endsWith(".txt") ? "txt" : "md");
  const [sessionId, setSession] = useState("");
  const [templatePath, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const operation = useRef({ signature: "", id: crypto.randomUUID() });
  const sessions = useQuery({ queryKey: ["launcher-attach-sessions", client.baseUrl, workspaceId], enabled: initial.kind === "attach" && Boolean(workspaceId), queryFn: () => client.listSessions(workspaceId, { roots: true, limit: 100 }) });
  const templates = useQuery({ staleTime: 0, refetchInterval: 2000, refetchOnWindowFocus: "always", queryKey: ["launcher-document-templates", client.baseUrl, workspaceId, format], enabled: initial.kind === "document" && Boolean(workspaceId), queryFn: () => client.launcherSearch({ query: "", kinds: ["files"], projectId: workspaceId, fileTypes: [format], content: false }) });
  const project = workspaces.find(item => item.id === workspaceId);
  const submit = async (draft = false) => {
    if (saving.current || !workspaceId || (initial.kind !== "attach" && !name.trim())) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      if (initial.kind === "document" || initial.kind === "excerpt") await client.listWorkspaceDirectory(workspaceId, folder);
      if (initial.kind === "attach") await onAttach(workspaceId, sessionId || undefined, initial.context);
      else if (initial.kind === "task") {
        const result = await client.createTask(workspaceId, { id: operation.current.id, title: name, description: text, projectId: workspaceId });
        onTaskCreated(result.task, workspaceId);
      } else if (draft) await onDraft(workspaceId, folder, name, format, text);
      else {
        const input = { workspaceId, folder, name, format, text, templatePath: templatePath || undefined };
        const signature = JSON.stringify(input);
        if (operation.current.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
        const result = await client.createLauncherDocument({ ...input, operationId: operation.current.id });
        openInApp(launcherFileRoute({ projectId: workspaceId, workspaceId, path: result.path, name: result.path.split("/").at(-1) ?? name }));
      }
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <LauncherForm title={t(createKeys[initial.kind])} busy={busy} onStateChange={onFormStateChange} onClose={onClose} onSubmit={() => void submit()}>
    <fieldset disabled={busy} className="contents">
      {initial.kind !== "attach" && <label>{t(initial.kind === "task" ? "tasks.field_title" : "launcher.flow.name")}<Input value={name} autoFocus maxLength={200} required onChange={event => setName(event.target.value)} /></label>}
      <LauncherSelect label={t("launcher.flow.project")} value={workspaceId} autoFocus={initial.kind === "attach" && !initial.workspaceId} required disabled={busy} placeholder={t("launcher.flow.choose_project")}
        options={workspaces.map(item => ({ value: item.id, label: item.displayName || item.name }))} onChange={value => { setWorkspace(value); setFolder(""); setSession(""); setTemplate(""); }} />
      {initial.kind === "attach" ? <label>{t("launcher.kind.chats")}<select value={sessionId} autoFocus={Boolean(initial.workspaceId)} onChange={event => setSession(event.target.value)}><option value="">{t("launcher.flow.new_project_chat")}</option>{sessions.data?.items.filter(item => !item.time.archived).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>{sessions.isError && <span role="alert">{t("launcher.conversation.unavailable")}</span>}</label> : <>
        {initial.kind !== "task" && <div className="launcher-form-row">
          <LauncherFolderPicker key={workspaceId} workspaceId={workspaceId} value={folder} onChange={setFolder} disabled={busy} />
          <LauncherSelect label={t("launcher.flow.format")} value={format} disabled={busy} options={[{ value: "md", label: "Markdown" }, { value: "txt", label: "Text" }, { value: "docx", label: "Word" }]} onChange={value => { if (value === "md" || value === "txt" || value === "docx") { setFormat(value); setTemplate(""); } }} />
        </div>}
        {initial.kind === "document" && <LauncherSelect label={t("launcher.flow.template")} value={templatePath} disabled={busy || !workspaceId} onChange={setTemplate}
          options={[{ value: "", label: t("launcher.flow.blank") }, ...(templates.isError ? [] : templates.data?.items ?? []).filter(item => item.path && item.workspaceId === workspaceId).map(item => ({ value: item.path ?? "", label: launcherFolderLabel(item.path ?? "") }))]} />}
        {!templatePath && <label>{t(initial.kind === "document" ? "launcher.flow.initial_text" : initial.kind === "task" ? "tasks.field_description" : "launcher.flow.content")}<textarea rows={initial.kind === "task" ? 3 : 5} value={text} onChange={event => setText(event.target.value)} /></label>}
      </>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="launcher-form-actions"><Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}<kbd>Esc</kbd></Button>
        {initial.kind === "document" && !templatePath && <Button type="button" variant="outline" disabled={!workspaceId || !name.trim() || !text.trim()} onClick={() => void submit(true)}>{t("launcher.flow.draft_assistant")}</Button>}
        <Button type="submit" disabled={!workspaceId || (initial.kind !== "attach" && !name.trim())}>{busy ? t("launcher.flow.saving") : initial.kind === "attach" ? t("launcher.flow.stage") : initial.kind === "task" ? t("launcher.flow.create_task") : t("launcher.flow.save_in", { project: project?.displayName || project?.name || "", folder: launcherFolderLabel(folder) })}<LauncherSubmitHint /></Button>
      </div>
    </fieldset>
  </LauncherForm>;
}

/** Only metadata actually captured by a provider belongs in an excerpt. */
export function excerptText(items: AssistantContextItem[]) {
  return items.flatMap(item => item.type === "selection" ? [`${t("launcher.flow.excerpt")} · ${new Date(item.capturedAt).toISOString()}\n${[item.sourceApp, item.sourceWindow].filter(Boolean).join(" · ")}\n\n${item.text}`] : item.type === "clipboard" ? [item.text] : item.type === "file" ? [`${item.sourceLabel ?? item.workspaceId ?? "LegalWork"} · ${item.path}`] : []).join("\n\n---\n\n");
}
