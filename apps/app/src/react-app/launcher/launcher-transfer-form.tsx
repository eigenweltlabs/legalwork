import { useRef, useState } from "react";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { LauncherFolderPicker } from "./launcher-folder-picker";
import { t } from "@/i18n";
import { useLauncherShell } from "./launcher-shell";
import { LauncherForm, LauncherSubmitHint, type LauncherFormState } from "./launcher-form";

export type LauncherTransfer = { items: LauncherSearchResult[]; workspaceId: string; folder: string; mode: "copy" | "move" };
export function LauncherTransferForm({ transfer, onClose, onFormStateChange }: { transfer: LauncherTransfer; onClose: () => void; onFormStateChange?: (state: LauncherFormState) => void }) {
  const { client, workspaces } = useLauncherShell();
  const [folder, setFolder] = useState(transfer.folder);
  const [remaining, setRemaining] = useState(transfer.items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const project = workspaces.find(item => item.id === transfer.workspaceId);
  const submit = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try {
      await client.listWorkspaceDirectory(transfer.workspaceId, folder);
      for (const item of remaining) {
        await client.transferLauncherFile({ sourceWorkspaceId: item.workspaceId ?? "", targetWorkspaceId: transfer.workspaceId, path: item.path ?? "", folder, mode: transfer.mode });
        setRemaining(items => items.filter(other => other !== item));
      }
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { running.current = false; setBusy(false); }
  };
  return <LauncherForm title={t(transfer.mode === "copy" ? "launcher.result_action.copy-to-project" : "launcher.result_action.move-to-project")} busy={busy} onStateChange={onFormStateChange} onClose={onClose} onSubmit={() => void submit()}>
    <p>{project?.displayName || project?.name} · {remaining.length} {t("launcher.kind.files")}</p>
    <LauncherFolderPicker workspaceId={transfer.workspaceId} value={folder} onChange={setFolder} autoFocus disabled={busy} />
    {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    <div className="launcher-form-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}<kbd>Esc</kbd></Button><Button disabled={busy} type="submit">{busy ? t("launcher.flow.saving") : t(transfer.mode === "copy" ? "launcher.transfer.copy" : "launcher.transfer.move")}<LauncherSubmitHint /></Button></div>
  </LauncherForm>;
}
