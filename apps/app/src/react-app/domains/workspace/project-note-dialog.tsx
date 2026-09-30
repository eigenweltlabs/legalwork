import { projectErrorMessage } from "./project-errors";
import { useState } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestPanelTab } from "../session/panel/panel-tab-request";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";

export function ProjectNoteDialog(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const name =
        title
          .trim()
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
          .slice(0, 80)
          .replace(/[. ]+$/g, "") || "Note";
      const path = `Notes/${name}-${crypto.randomUUID().slice(0, 8)}.md`;
      await props.client.writeWorkspaceFile(props.workspaceId, {
        path,
        content: `# ${title.trim()}\n\n`,
      });
      requestPanelTab({
        id: `file:${path.toLowerCase()}`,
        type: "artifact",
        label: `${name}.md`,
        preview: "markdown",
        value: path,
      });
      props.onSaved();
      props.onClose();
    } catch (error) {
      setError(projectErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("projects.add_note")}</DialogTitle>
          <DialogDescription>
            {t("projects.note_editor_hint")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            required
            maxLength={200}
            aria-label={t("projects.note_title")}
            placeholder={t("projects.note_title")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={busy}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={props.onClose}
            >
              {t("projects.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? t("projects.saving") : t("projects.add_note")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
