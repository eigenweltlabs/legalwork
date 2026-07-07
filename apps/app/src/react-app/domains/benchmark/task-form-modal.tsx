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
import type { BenchmarkWorkType } from "../../../app/lib/benchmark-types";
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
};

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
  const suggestions = useMemo(() => {
    const query = draft.trim().toLowerCase();
    return props.suggestions
      .filter((tag) => !props.tags.includes(tag))
      .filter((tag) => (query ? tag.toLowerCase().includes(query) : true))
      .slice(0, 8);
  }, [draft, props.suggestions, props.tags]);

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || props.tags.includes(trimmed)) return;
    props.onChange([...props.tags, trimmed]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-[12px]">{t("benchmark.form_tags")}</Label>
      {props.tags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {props.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 px-1.5 py-0.5 text-[11px]">
              {tag}
              <button type="button" onClick={() => props.onChange(props.tags.filter((entry) => entry !== tag))}>
                <X size={11} />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <Input
        value={draft}
        placeholder={t("benchmark.form_tags_placeholder")}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            addTag(draft);
          }
        }}
      />
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="rounded-full border border-dls-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-dls-hover"
              onClick={() => addTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TaskFormModal(props: TaskFormModalProps) {
  const tasks = useBenchmarkStore((state) => state.tasks);
  const createTask = useBenchmarkStore((state) => state.createTask);
  const [draft, setDraft] = useState<CustomTaskDraft>(EMPTY_CUSTOM_TASK_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (props.open) {
      setDraft(EMPTY_CUSTOM_TASK_DRAFT);
      setErrors({});
    }
  }, [props.open]);

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
    const item = await createTask(result.input);
    setSaving(false);
    if (item) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[min(820px,90vh)] w-[min(1120px,95vw)] max-w-[95vw] flex-col sm:max-w-[1120px]">
        <DialogHeader>
          <DialogTitle>{t("benchmark.new_task")}</DialogTitle>
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
