import { useState } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!title.trim() || !body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const name =
        title
          .trim()
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
          .slice(0, 80)
          .replace(/[. ]+$/g, "") || "Note";
      await props.client.writeWorkspaceFile(props.workspaceId, {
        path: `Notes/${name}-${crypto.randomUUID().slice(0, 8)}.md`,
        content: `# ${title.trim()}\n\n${body.trim()}\n`,
      });
      props.onSaved();
      props.onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("projects.failed"));
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
          <DialogDescription>{t("projects.notes_hint")}</DialogDescription>
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
          <Textarea
            required
            rows={8}
            maxLength={100000}
            aria-label={t("projects.note_body")}
            placeholder={t("projects.note_body")}
            value={body}
            onChange={(event) => setBody(event.target.value)}
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
            <Button
              type="submit"
              disabled={busy || !title.trim() || !body.trim()}
            >
              {busy ? t("projects.saving") : t("projects.save_note")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
