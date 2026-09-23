import { useId, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { createWorkflow, type WorkflowDraft } from "../state/workflow-editor-store";
import type { WorkflowType } from "../state/workflow-document";

export function NewWorkflowDialog({ workspaceId, type, busy, onClose, onCreated }: {
  workspaceId: string;
  type: WorkflowType;
  busy: boolean;
  onClose: () => void;
  onCreated: (draft: WorkflowDraft) => void;
}) {
  const nameId = useId();
  const descriptionId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || busy || !title.trim() || !description.trim()) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const draft = await createWorkflow(workspaceId, type, { title, description });
      onCreated(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common.something_went_wrong"));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !submitting.current) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <form className="contents" onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{type === "tabular" ? t("skills.new_tabular_workflow") : t("skills.new_workflow")}</DialogTitle>
          <DialogDescription>{t("workflows.new_description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>{t("workflows.name")}</Label>
            <Input id={nameId} autoFocus required value={title} disabled={saving} placeholder={t("skills.name_placeholder")} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={descriptionId}>{t("tasks.field_description")}</Label>
            <Textarea id={descriptionId} rows={4} required value={description} disabled={saving} placeholder={t("skills.description_placeholder_workflow")} onChange={(event) => setDescription(event.target.value)} />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={saving || busy || !title.trim() || !description.trim()} aria-busy={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}{t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
