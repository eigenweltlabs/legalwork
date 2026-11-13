import { useEffect, useRef, useState } from "react";
import type { AssistantContextItem, LauncherCatalogEntry } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { stageFiles } from "./context-capture";
import { LauncherForm, LauncherSubmitHint, type LauncherFormState } from "./launcher-form";
import { launcherQuickActionInputs, missingLauncherQuickActionInputs } from "./launcher-quick-action";
import { LauncherSelect } from "./launcher-select";
import { useLauncherShell } from "./launcher-shell";

export type LauncherQuickActionRequest = { item: LauncherCatalogEntry; args: string; context: AssistantContextItem[]; projectId: string | null };
export type LauncherQuickActionValues = { args: string; context: AssistantContextItem[]; projectId: string | null };

/** Missing inputs stay local until Run; opening or cancelling never creates a chat. */
export function LauncherQuickActionForm({ initial, onClose, onRun, onFormStateChange, onFileDialog }: {
  initial: LauncherQuickActionRequest; onClose: () => void; onRun: (values: LauncherQuickActionValues) => Promise<void>;
  onFormStateChange: (state: LauncherFormState) => void; onFileDialog: (open: boolean) => void;
}) {
  const { client, assistant, workspaces } = useLauncherShell();
  const action = initial.item.quickAction;
  const missing = missingLauncherQuickActionInputs(action?.requires ?? [], launcherQuickActionInputs(initial.context, initial.args));
  const needsProject = action?.target === "project" && !initial.projectId;
  const [projectId, setProjectId] = useState(initial.projectId ?? "");
  const [args, setArgs] = useState(initial.args);
  const [selection, setSelection] = useState("");
  const [clipboard, setClipboard] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileDialogHeld = useRef(false);
  const fileDialogCallback = useRef(onFileDialog);
  fileDialogCallback.current = onFileDialog;
  const setFileDialog = (open: boolean) => {
    if (fileDialogHeld.current === open) return;
    fileDialogHeld.current = open;
    fileDialogCallback.current(open);
  };
  useEffect(() => {
    const input = fileInput.current;
    const release = () => {
      if (!fileDialogHeld.current) return;
      fileDialogHeld.current = false;
      fileDialogCallback.current(false);
    };
    input?.addEventListener("cancel", release);
    return () => { input?.removeEventListener("cancel", release); release(); };
  }, []);
  const staged = useRef(new Map<File, { workspaceId: string; item: AssistantContextItem }>());
  const baseContext = initial.context.filter(item => !(item.type === "selection" && missing.includes("selection") || item.type === "clipboard" && missing.includes("clipboard")));
  const textSlots = Number(missing.includes("selection")) + Number(missing.includes("clipboard"));
  const fileLimit = Math.max(0, 50 - baseContext.length - textSlots);
  const capacity = baseContext.length + textSlots <= 50 && (!missing.includes("files") || fileLimit > 0);
  const ready = capacity && (!needsProject || Boolean(projectId)) && missing.every(input => input === "files" ? files.length > 0 : input === "arguments" ? args.trim() : input === "selection" ? selection.trim() : clipboard.trim());
  const submit = async () => {
    if (saving.current || !ready) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const workspaceId = action?.target === "project" ? projectId : assistant?.workspaceId;
      if (!workspaceId) throw new Error(t("launcher.notice.needs_project"));
      const context = [...baseContext];
      if (missing.includes("selection")) context.push({ id: `selection_${crypto.randomUUID()}`, type: "selection", text: selection, sourceApp: null, sourceWindow: null, capturedAt: Date.now() });
      if (missing.includes("clipboard")) context.push({ id: `clipboard_${crypto.randomUUID()}`, type: "clipboard", text: clipboard, capturedAt: Date.now() });
      for (const file of files) {
        let saved = staged.current.get(file);
        if (saved?.workspaceId !== workspaceId) {
          const [item] = await stageFiles(client, workspaceId, [file]);
          if (!item) throw new Error(t("workspace.upload_incomplete"));
          saved = { workspaceId, item }; staged.current.set(file, saved);
        }
        context.push(saved.item);
      }
      await onRun({ args, context, projectId: action?.target === "project" ? projectId : null });
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <LauncherForm title={initial.item.label} busy={busy} onStateChange={onFormStateChange} onClose={onClose} onSubmit={() => void submit()}>
    <fieldset disabled={busy} className="contents">
      {needsProject && <LauncherSelect label={t("launcher.flow.project")} value={projectId} autoFocus required disabled={busy} placeholder={t("launcher.flow.choose_project")} options={workspaces.map(item => ({ value: item.id, label: item.displayName || item.name }))} onChange={setProjectId} />}
      {missing.includes("arguments") && <label>{t("launcher.input.arguments")}<Input autoFocus={!needsProject} value={args} maxLength={8000} required onChange={event => setArgs(event.target.value)} /></label>}
      {missing.includes("selection") && <label>{t("launcher.input.selection")}<textarea autoFocus={!needsProject && !missing.includes("arguments")} rows={3} value={selection} maxLength={200000} required onChange={event => setSelection(event.target.value)} /></label>}
      {missing.includes("clipboard") && <label>{t("launcher.input.clipboard")}<textarea autoFocus={!needsProject && !missing.includes("arguments") && !missing.includes("selection")} rows={3} value={clipboard} maxLength={200000} required onChange={event => setClipboard(event.target.value)} /></label>}
      {missing.includes("files") && <label>{t("launcher.input.files")}<Input ref={fileInput} type="file" multiple autoFocus={!needsProject && missing.length === 1} onClick={() => setFileDialog(true)} onChange={event => {
        setFileDialog(false);
        const picked = Array.from(event.target.files ?? []);
        staged.current.clear();
        if (picked.length > fileLimit || picked.some(file => file.size > 64 * 1024 * 1024)) {
          event.target.value = ""; setFiles([]); setError(t("launcher.quick_action.file_limit", { count: fileLimit })); return;
        }
        setFiles(picked); setError(null);
      }} /></label>}
      {!capacity && <p role="alert" className="text-destructive text-sm">{t("launcher.quick_action.context_limit")}</p>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="launcher-form-actions"><Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}<kbd>Esc</kbd></Button><Button type="submit" disabled={!ready}>{busy ? t("launcher.flow.saving") : t("launcher.result_action.run")}<LauncherSubmitHint /></Button></div>
    </fieldset>
  </LauncherForm>;
}
