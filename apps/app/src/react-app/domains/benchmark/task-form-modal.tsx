/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { BenchmarkTaskItem, BenchmarkWorkType } from "../../../app/lib/benchmark-types";
import { BENCHMARK_WORK_TYPES } from "../../../app/lib/benchmark-types";
import { SettingsNotice } from "../settings/settings-section";
import { collectTaskTags } from "./filter-tasks";
import { workTypeLabel } from "./format";
import {
  EMPTY_CUSTOM_TASK_DRAFT,
  validateCustomTask,
  type CustomTaskDraft,
} from "./validate-custom-task";
import { useBenchmarkStore } from "./store";

export type TaskFormModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the modal edits this task instead of creating a new one. */
  task?: BenchmarkTaskItem | null;
};

function draftFromTask(task: BenchmarkTaskItem): CustomTaskDraft {
  return {
    title: task.title,
    workType: task.workType,
    tags: [...task.tags],
    instructions: task.instructions,
    deliverables: task.deliverables.length ? [...task.deliverables] : [""],
    criteria: task.criteria.length ? task.criteria.map((criterion) => criterion.matchCriteria) : [""],
    documents: [],
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ListEditor(props: {
  label: string;
  addLabel: string;
  values: string[];
  multiline?: boolean;
  placeholder?: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px]">{props.label}</Label>
      {props.values.map((value, index) => (
        <div key={index} className="flex items-start gap-1.5">
          {props.multiline ? (
            <Textarea
              value={value}
              rows={3}
              placeholder={props.placeholder}
              onChange={(event) => {
                const next = [...props.values];
                next[index] = event.target.value;
                props.onChange(next);
              }}
            />
          ) : (
            <Input
              value={value}
              placeholder={props.placeholder}
              onChange={(event) => {
                const next = [...props.values];
                next[index] = event.target.value;
                props.onChange(next);
              }}
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            disabled={props.values.length <= 1}
            onClick={() => props.onChange(props.values.filter((_, entry) => entry !== index))}
          >
            <X size={13} />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => props.onChange([...props.values, ""])}>
        <Plus size={13} />
        {props.addLabel}
      </Button>
    </div>
  );
}

function TagInput(props: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const query = draft.trim();
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return props.suggestions
      .filter((tag) => !props.tags.includes(tag))
      .filter((tag) => (q ? tag.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [query, props.suggestions, props.tags]);

  // Offer "Create" when the draft isn't an exact existing tag/suggestion.
  const showCreate =
    query.length > 0 &&
    !props.tags.some((tag) => tag.toLowerCase() === query.toLowerCase()) &&
    !filtered.some((tag) => tag.toLowerCase() === query.toLowerCase());
  const items: Array<{ kind: "create" | "existing"; value: string }> = [
    ...(showCreate ? [{ kind: "create" as const, value: query }] : []),
    ...filtered.map((tag) => ({ kind: "existing" as const, value: tag })),
  ];
  const dropdownOpen = open && items.length > 0;

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || props.tags.includes(trimmed)) return;
    props.onChange([...props.tags, trimmed]);
    setDraft("");
    setHighlight(0);
  };

  const commitHighlighted = () => {
    const chosen = items[highlight] ?? items[0];
    if (chosen) addTag(chosen.value);
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-[12px]">{t("benchmark.form_tags")}</Label>
      <div className="relative">
        {/* Chips live inside the input box; the bare input grows after them. */}
        <div
          className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 transition-[box-shadow,border-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30"
          onMouseDown={(event) => {
            // Clicking empty space focuses the input without stealing focus mid-drag.
            if (event.target === event.currentTarget) inputRef.current?.focus();
          }}
        >
          {props.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="gap-1 border-dls-border bg-dls-hover px-1.5 py-0.5 text-[11px]">
              {tag}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onChange(props.tags.filter((entry) => entry !== tag))}
              >
                <X size={11} />
              </button>
            </Badge>
          ))}
          <input
            ref={inputRef}
            value={draft}
            placeholder={props.tags.length ? "" : t("benchmark.form_tags_placeholder")}
            className="min-w-[8ch] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setDraft(event.target.value);
              setHighlight(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Delay so a click on a dropdown row registers before it closes.
              blurTimer.current = setTimeout(() => setOpen(false), 120);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setHighlight((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (dropdownOpen) commitHighlighted();
                else addTag(draft);
              } else if (event.key === "Escape") {
                setOpen(false);
              } else if (event.key === "Backspace" && !draft && props.tags.length) {
                props.onChange(props.tags.slice(0, -1));
              }
            }}
          />
        </div>
        {dropdownOpen ? (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-52 overflow-y-auto rounded-lg border border-dls-border bg-background p-1 shadow-md">
            {items.map((item, index) => (
              <button
                key={`${item.kind}:${item.value}`}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-dls-hover",
                  index === highlight && "bg-dls-hover",
                )}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addTag(item.value)}
              >
                {item.kind === "create" ? (
                  <>
                    <Plus size={13} className="shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">{t("benchmark.create_tag", { tag: item.value })}</span>
                  </>
                ) : (
                  <span className="truncate">{item.value}</span>
                )}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TaskFormModal(props: TaskFormModalProps) {
  const tasks = useBenchmarkStore((state) => state.tasks);
  const createTask = useBenchmarkStore((state) => state.createTask);
  const updateTask = useBenchmarkStore((state) => state.updateTask);
  const [draft, setDraft] = useState<CustomTaskDraft>(EMPTY_CUSTOM_TASK_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const editingTask = props.task ?? null;
  const isEdit = Boolean(editingTask);

  useEffect(() => {
    if (props.open) {
      setDraft(editingTask ? draftFromTask(editingTask) : EMPTY_CUSTOM_TASK_DRAFT);
      setErrors({});
    }
  }, [props.open, editingTask]);

  const tagSuggestions = useMemo(() => collectTaskTags(tasks), [tasks]);
  const patch = (update: Partial<CustomTaskDraft>) => setDraft((previous) => ({ ...previous, ...update }));

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const additions = await Promise.all(
      Array.from(files).map(async (file) => ({ name: file.name, contentBase64: await fileToBase64(file) })),
    );
    setDraft((previous) => ({
      ...previous,
      documents: [
        ...previous.documents.filter((doc) => !additions.some((added) => added.name === doc.name)),
        ...additions,
      ],
    }));
  };

  const save = async () => {
    const result = validateCustomTask(draft);
    if (!result.ok) {
      setErrors(result.errors as Record<string, string>);
      return;
    }
    setErrors({});
    setSaving(true);
    const item = editingTask
      ? await updateTask(editingTask.id, result.input)
      : await createTask(result.input);
    setSaving(false);
    if (item) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[min(820px,90vh)] w-[min(1120px,95vw)] max-w-[95vw] flex-col sm:max-w-[1120px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("benchmark.edit_custom_task") : t("benchmark.new_task")}</DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-4 overflow-y-auto pr-1 md:grid-cols-2 md:gap-6">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="space-y-3 rounded-xl border border-dls-border p-4">
              <div className="space-y-1.5">
                <Label className="text-[12px]">{t("benchmark.form_title")}</Label>
                <Input value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
                {errors.title ? <SettingsNotice tone="error">{t(errors.title)}</SettingsNotice> : null}
              </div>
              <div className="flex gap-3">
                <div className="w-44 shrink-0 space-y-1.5">
                  <Label className="text-[12px]">{t("benchmark.form_work_type")}</Label>
                  <Select
                    value={draft.workType}
                    onValueChange={(value) => patch({ workType: value as BenchmarkWorkType })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BENCHMARK_WORK_TYPES.map((workType) => (
                        <SelectItem key={workType} value={workType}>
                          {workTypeLabel(workType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 flex-1">
                  <TagInput tags={draft.tags} suggestions={tagSuggestions} onChange={(tags) => patch({ tags })} />
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-dls-border p-4">
              <Label className="mb-1.5 block text-[12px]">{t("benchmark.form_instructions")}</Label>
              <Textarea
                rows={10}
                className="min-h-44 resize-none"
                value={draft.instructions}
                onChange={(event) => patch({ instructions: event.target.value })}
              />
              {errors.instructions ? (
                <div className="mt-2">
                  <SettingsNotice tone="error">{t(errors.instructions)}</SettingsNotice>
                </div>
              ) : null}
            </section>

            <section className="rounded-xl border border-dls-border p-4">
              <Label className="mb-1.5 block text-[12px]">{t("benchmark.form_documents")}</Label>
              {isEdit && editingTask && editingTask.docCount > 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  {t("benchmark.edit_documents_kept", { count: editingTask.docCount })}
                </p>
              ) : (
                <>
                  {draft.documents.length ? (
                    <ul className="mb-2 space-y-1">
                      {draft.documents.map((doc) => (
                        <li key={doc.name} className="flex items-center gap-2 text-[12px]">
                          <Paperclip size={12} className="text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-mono">{doc.name}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            onClick={() =>
                              patch({ documents: draft.documents.filter((entry) => entry.name !== doc.name) })
                            }
                          >
                            <X size={12} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                    <Paperclip size={13} />
                    {t("benchmark.form_add_documents")}
                  </Button>
                </>
              )}
            </section>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <section className="rounded-xl border border-dls-border p-4">
              <ListEditor
                label={t("benchmark.form_deliverables")}
                addLabel={t("benchmark.form_add_deliverable")}
                values={draft.deliverables}
                placeholder="memo.docx"
                onChange={(deliverables) => patch({ deliverables })}
              />
              {errors.deliverables ? (
                <div className="mt-2">
                  <SettingsNotice tone="error">{t(errors.deliverables)}</SettingsNotice>
                </div>
              ) : null}
            </section>

            <section className="rounded-xl border border-dls-border p-4">
              <ListEditor
                label={t("benchmark.form_criteria")}
                addLabel={t("benchmark.form_add_criterion")}
                values={draft.criteria}
                multiline
                placeholder={t("benchmark.form_criterion_placeholder")}
                onChange={(criteria) => patch({ criteria })}
              />
              {errors.criteria ? (
                <div className="mt-2">
                  <SettingsNotice tone="error">{t(errors.criteria)}</SettingsNotice>
                </div>
              ) : null}
            </section>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
