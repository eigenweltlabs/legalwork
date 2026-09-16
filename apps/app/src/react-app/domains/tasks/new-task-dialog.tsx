/** @jsxImportSource react */
/**
 * "New task": a title, and optionally a description, priority, due date and —
 * once the firm is connected and its members are known — an assignee. Without
 * a connection there is nobody to hand a task to, so the field stays away
 * rather than offering an empty list.
 */
import { useId, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { LegalworkTaskCreate, LegalworkTaskMember, LegalworkTaskPriority } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { TASK_PRIORITIES, priorityForKey, taskMemberOptions, taskPriorityLabel } from "./task-format";
import { AssigneeMark, OptionText, PriorityMark, PriorityOption } from "./task-glyphs";
import { TaskTagInput } from "./task-tag-input";

/** The "unassigned" choice needs a non-empty Select value of its own. */
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
  const ids = { title: useId(), description: useId(), priority: useId(), due: useId(), assignee: useId() };
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<LegalworkTaskPriority>(2);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [tags, setTags] = useState<string[]>([]);

  const priorityItems = TASK_PRIORITIES.map((value) => ({ value: String(value), label: taskPriorityLabel(value) }));
  const showAssignee = props.connected && props.members.length > 0;
  const assigneeItems = [
    { value: UNASSIGNED, label: t("tasks.unassigned"), primary: t("tasks.unassigned") },
    ...taskMemberOptions(props.members),
  ];
  const chosenAssignee = assigneeItems.find((item) => item.value === assignee);

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

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogContent className="sm:max-w-lg">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("tasks.new_task")}</DialogTitle>
            <DialogDescription>{t("tasks.new_task_desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.title}>{t("tasks.field_title")}</Label>
              <Input
                id={ids.title}
                autoFocus
                required
                maxLength={500}
                value={title}
                placeholder={t("tasks.field_title_placeholder")}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.description}>{t("tasks.field_description")}</Label>
              <Textarea
                id={ids.description}
                rows={4}
                value={description}
                placeholder={t("tasks.field_description_placeholder")}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t("tasks.tags")}</Label>
              <TaskTagInput tags={tags} suggestions={props.tagSuggestions} onChange={setTags} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.priority}>{t("tasks.field_priority")}</Label>
                <Select
                  value={String(priority)}
                  items={priorityItems}
                  open={priorityOpen}
                  onOpenChange={setPriorityOpen}
                  onValueChange={(value) => {
                    const next = Number(value);
                    if (next === 0 || next === 1 || next === 2 || next === 3 || next === 4) setPriority(next);
                  }}
                >
                  <SelectTrigger id={ids.priority} className="w-full">
                    <PriorityMark priority={priority} />
                    <SelectValue />
                  </SelectTrigger>
                  {/* Digits pick a priority while the menu is open, as in Linear. */}
                  <SelectContent
                    onKeyDown={(event) => {
                      const next = priorityForKey(event);
                      if (next === null) return;
                      event.preventDefault();
                      setPriority(next);
                      setPriorityOpen(false);
                    }}
                  >
                    <SelectGroup>
                      {TASK_PRIORITIES.map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          <PriorityOption priority={value} />
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.due}>{t("tasks.field_due")}</Label>
                <Input id={ids.due} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
              </div>
            </div>
            {showAssignee ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.assignee}>{t("tasks.column_assignee")}</Label>
                <Select value={assignee} items={assigneeItems} onValueChange={(value) => setAssignee(value ?? UNASSIGNED)}>
                  <SelectTrigger id={ids.assignee} className="w-full">
                    <AssigneeMark name={assignee === UNASSIGNED ? null : (chosenAssignee?.primary ?? null)} />
                    <SelectValue />
                  </SelectTrigger>
                  {/* As wide as the names need, not as the trigger. */}
                  <SelectContent className="w-auto min-w-(--anchor-width) max-w-80">
                    <SelectGroup>
                      {assigneeItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          <AssigneeMark name={item.value === UNASSIGNED ? null : item.primary} />
                          <OptionText primary={item.primary} detail={item.detail} />
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose} disabled={props.busy}>
              {t("tasks.cancel")}
            </Button>
            <Button type="submit" disabled={props.busy || !title.trim()} aria-busy={props.busy}>
              {props.busy ? <Loader2 className="animate-spin" /> : null}
              {t("tasks.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
