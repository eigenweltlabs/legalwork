import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { saveCaptureToProject, type CaptureSaveSource } from "./context-capture";
import { LauncherFolderPicker, launcherFolderLabel } from "./launcher-folder-picker";
import { LauncherForm, LauncherSubmitHint, type LauncherFormState } from "./launcher-form";
import { LauncherSelect } from "./launcher-select";
import { useLauncherShell } from "./launcher-shell";

export function LauncherSaveCapture({ source, initial, onClose, onSaved, onFormStateChange }: {
  source: CaptureSaveSource;
  initial: { workspaceId: string; folder: string };
  onClose: () => void;
  onSaved: (project: string, path: string) => void;
  onFormStateChange: (state: LauncherFormState) => void;
}) {
  const { client, workspaces } = useLauncherShell();
  const [workspaceId, setWorkspace] = useState(initial.workspaceId);
  const [folder, setFolder] = useState(initial.folder);
  const [name, setName] = useState(source.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const project = workspaces.find(item => item.id === workspaceId);
  const submit = async () => {
    if (saving.current || !project) return;
    saving.current = true;
    setBusy(true); setError(null);
    try {
      const path = await saveCaptureToProject(client, source, project.id, folder, name);
      onSaved(project.displayName || project.name, path);
    } catch (error) {
      if (error instanceof LegalworkServerError && error.code === "file_exists") setError(t("launcher.capture.filename_exists"));
      else if (error instanceof LegalworkServerError && ["dir_not_found", "invalid_path"].includes(error.code)) setError(t("launcher.folder.unavailable"));
      else setError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return <LauncherForm title={t("launcher.capture.save_image")} busy={busy} onClose={onClose} onSubmit={() => void submit()} onStateChange={onFormStateChange}>
    {workspaces.length ? <>
      <LauncherSelect label={t("launcher.flow.project")} value={workspaceId} required disabled={busy}
        autoFocus={!project} placeholder={t("launcher.flow.choose_project")}
        options={workspaces.map(item => ({ value: item.id, label: item.displayName || item.name }))}
        onChange={value => { setWorkspace(value); setFolder(""); setError(null); }} />
      <LauncherFolderPicker key={workspaceId} workspaceId={project?.id ?? ""} value={folder} onChange={setFolder} disabled={busy} autoFocus={Boolean(project)} />
      <label>{t("launcher.flow.name")}<Input value={name} required disabled={busy} maxLength={200} onChange={event => setName(event.target.value)} /></label>
    </> : <p role="status">{t("launcher.capture.no_save_projects")}</p>}
    {error && <p className="launcher-notice" data-tone="error" role="alert">{error}</p>}
    <div className="launcher-form-actions">
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("common.back")}</Button>
      <Button type="submit" disabled={busy || !project || !name.trim()}>{busy ? t("launcher.flow.saving") : project ? t("launcher.flow.save_in", { project: project.displayName || project.name, folder: launcherFolderLabel(folder) }) : t("common.save")}<LauncherSubmitHint /></Button>
    </div>
  </LauncherForm>;
}
