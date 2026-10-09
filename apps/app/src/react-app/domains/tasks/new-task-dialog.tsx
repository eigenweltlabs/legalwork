/** @jsxImportSource react */
import { useId, useState, type FormEvent } from "react";
import { Loader2, SquareCheck, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ItemDetailLabel, ItemDescriptionInput, ItemDialogContent, ItemTitleInput } from "@/react-app/design-system/item-detail";
import type { LegalworkTaskCreate, LegalworkTaskMember, LegalworkTaskPriority } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { TASK_PRIORITIES, taskMemberOptions, taskPriorityLabel } from "./task-format";
import { AssigneeMark, PriorityMark } from "./task-glyphs";
import { DueDateChip, PropertyChip } from "./task-property-chip";
import { TaskTagInput } from "./task-tag-input";

const UNASSIGNED = "__unassigned__";

export type NewTaskDialogProps = {
  open: boolean;
  busy: boolean;
  /** The firm is signed in — the only time a task can be handed to someone. */
  connected: boolean;
  /** The firm's members, as the server last knew them. */
  members: LegalworkTaskMember[];
  tagSuggestions: string[];
  onClose: () => void;
  onCreate: (input: LegalworkTaskCreate) => void;
};

export function NewTaskDialog(props: NewTaskDialogProps) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<LegalworkTaskPriority>(2);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [tags, setTags] = useState<string[]>([]);
  const showAssignee = props.connected && props.members.length > 0;
  const assigneeItems = [
    { value: UNASSIGNED, label: t("tasks.unassigned"), primary: t("tasks.unassigned") },
    ...taskMemberOptions(props.members),
  ];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || props.busy) return;
    props.onCreate({
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      priority,
      ...(dueDate ? { dueDate } : {}),
      ...(showAssignee && assignee !== UNASSIGNED ? { assigneeUserId: assignee } : {}),
      ...(tags.length ? { tags } : {}),
    });
  };

  return <Dialog open={props.open} onOpenChange={open => { if (!open && !props.busy) props.onClose(); }}>
    <ItemDialogContent>
      <form className="flex min-h-0 flex-col" onSubmit={submit}>
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 py-3.5 pe-14">
          <DialogTitle><ItemDetailLabel icon={<SquareCheck />}>{t("tasks.new_task")}</ItemDetailLabel></DialogTitle>
          <DialogDescription className="sr-only">{t("tasks.field_title_placeholder")}</DialogDescription>
        </DialogHeader>
        <fieldset disabled={props.busy} className="min-h-0 space-y-5 overflow-y-auto px-5 py-6 sm:px-8">
          <div className="space-y-4">
            <ItemTitleInput id={titleId} aria-label={t("tasks.field_title")} autoFocus required maxLength={500}
              value={title} placeholder={t("tasks.field_title_placeholder")} onChange={event => setTitle(event.target.value)} />
            <ItemDescriptionInput aria-label={t("tasks.field_description")} value={description}
              placeholder={t("calendar.description_placeholder")} onChange={event => setDescription(event.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2 [&>[data-slot=select-trigger]]:max-w-72">
            <DueDateChip value={dueDate} disabled={props.busy} onChange={setDueDate} />
            {showAssignee && <PropertyChip label={t("tasks.column_assignee")} value={assignee} disabled={props.busy}
              items={assigneeItems.map(item => ({ ...item, leading: <AssigneeMark name={item.value === UNASSIGNED ? null : item.primary} /> }))} onChange={setAssignee} />}
            <PropertyChip label={t("tasks.field_priority")} value={String(priority)} disabled={props.busy}
              items={TASK_PRIORITIES.map(value => ({ value: String(value), key: String(value), label: taskPriorityLabel(value), leading: <PriorityMark priority={value} /> }))}
              onChange={value => { const next = TASK_PRIORITIES.find(item => String(item) === value); if (next !== undefined) setPriority(next); }} />
          </div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-t border-border/60 pt-3">
            <Tags className="size-3.5 text-muted-foreground" />
            <TaskTagInput tags={tags} suggestions={props.tagSuggestions} disabled={props.busy} onChange={setTags} />
          </div>
        </fieldset>
        <DialogFooter className="m-0 shrink-0 border-border/60 bg-muted/20 px-6 py-3.5">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={props.busy}>{t("tasks.cancel")}</Button>
          <Button type="submit" disabled={props.busy || !title.trim()} aria-busy={props.busy}>
            {props.busy && <Loader2 className="animate-spin" />}{t("tasks.create")}
          </Button>
        </DialogFooter>
      </form>
    </ItemDialogContent>
  </Dialog>;
}
