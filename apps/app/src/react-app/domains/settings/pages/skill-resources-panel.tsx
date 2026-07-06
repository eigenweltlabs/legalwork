/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { Edit2, FilePlus, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { t } from "@/i18n";
import type { SkillResourceCard } from "@/app/types";

// The slice of the extensions store the attached-files panel needs. Implemented
// by createExtensionsStore alongside the skill methods (same server wiring).
export type SkillResourcesStore = {
  skillResources: () => SkillResourceCard[];
  skillResourcesStatus: () => string | null;
  refreshSkillResources: (skillName: string) => void | Promise<void>;
  readSkillResource: (skillName: string, fileName: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkillResource: (
    skillName: string,
    input: { name: string; content?: string; contentBase64?: string },
  ) => Promise<{ ok: boolean; message: string }>;
  deleteSkillResource: (skillName: string, fileName: string) => Promise<{ ok: boolean; message: string }>;
};

const rowIconBtnClass =
  "inline-flex size-7 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-40";
const inputClass =
  "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

const RESOURCE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const TEXT_RESOURCE_EXTENSIONS = new Set(["md", "markdown", "txt", "csv"]);

export function isTextResourceName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_RESOURCE_EXTENSIONS.has(ext);
}

export function normalizeResourceFileName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.includes(".") ? trimmed : `${trimmed}.md`;
}

export function isValidResourceFileName(name: string): boolean {
  return (
    RESOURCE_NAME_REGEX.test(name) &&
    name.length <= 128 &&
    !name.includes("..") &&
    !name.endsWith(" ") &&
    !name.endsWith(".")
  );
}

function formatResourceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

// A file picked in a create dialog before the skill folder exists: held in
// memory as base64 and flushed through saveSkillResource right after creation.
export type StagedResourceFile = { name: string; size: number; contentBase64: string };

/**
 * Uploads staged files into a just-created skill. Returns the names that
 * failed so the caller can tell the user which templates to re-attach from
 * the editor — the skill itself is already created at this point.
 */
export async function flushStagedResources(
  save: SkillResourcesStore["saveSkillResource"],
  skillName: string,
  staged: StagedResourceFile[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const file of staged) {
    try {
      const result = await save(skillName, { name: file.name, contentBase64: file.contentBase64 });
      if (!result.ok) failed.push(file.name);
    } catch {
      failed.push(file.name);
    }
  }
  return failed;
}

/**
 * "Attached files" field for the create dialogs: lets the user pick templates
 * while the skill/workflow doesn't exist on disk yet. Files are only staged
 * here; the dialog flushes them via flushStagedResources after creation.
 */
export function StagedResourcesField(props: {
  staged: StagedResourceFile[];
  disabled?: boolean;
  onChange: (staged: StagedResourceFile[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFile = async (file: File) => {
    if (!isValidResourceFileName(file.name)) {
      setError(t("skill_resources.upload_invalid_name"));
      return;
    }
    setError(null);
    setReading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      props.onChange([
        ...props.staged.filter((existing) => existing.name !== file.name),
        { name: file.name, size: file.size, contentBase64 },
      ]);
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="block space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-dls-text">{t("skill_resources.title")}</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,.csv,.docx,.pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void addFile(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled || reading}
          onClick={() => fileInputRef.current?.click()}
        >
          {reading ? <Loader2 size={13} className="animate-spin" /> : <FilePlus size={13} />}
          {t("skill_resources.upload")}
        </Button>
      </div>
      {error ? <div className="text-[11px] text-red-12">{error}</div> : null}
      {props.staged.length === 0 ? (
        <span className="text-[11px] text-dls-secondary">{t("skill_resources.staged_hint")}</span>
      ) : (
        <div className="divide-y divide-dls-border/60 rounded-xl border border-dls-border bg-dls-hover/40 px-3">
          {props.staged.map((file) => (
            <div key={file.name} className="flex items-center gap-2.5 py-2">
              <FileText size={14} className="shrink-0 text-dls-secondary" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-dls-text">{file.name}</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-dls-secondary/70">
                {formatResourceSize(file.size)}
              </span>
              <button
                type="button"
                className={rowIconBtnClass}
                disabled={props.disabled}
                onClick={() => props.onChange(props.staged.filter((existing) => existing.name !== file.name))}
                title={t("common.remove")}
                aria-label={t("common.remove")}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Attached files of a skill/workflow: templates and playbooks stored INSIDE the
 * skill's own folder (resources/ next to SKILL.md), so the whole workflow can
 * be shared as one self-contained folder. Rendered inside the skill editor
 * dialog; the server keeps the SKILL.md "Attached resources" section in sync,
 * and `onChanged` lets the editor pick up that regenerated section.
 */
export function SkillResourcesPanel(props: {
  skillName: string;
  busy: boolean;
  extensions: SkillResourcesStore;
  onChanged: () => void;
}) {
  const { extensions, skillName } = props;
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SkillResourceCard | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillResourceCard | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void extensions.refreshSkillResources(skillName);
  }, [extensions, skillName]);

  const resources = extensions.skillResources();
  const status = extensions.skillResourcesStatus();

  const uploadFile = async (file: File) => {
    if (!isValidResourceFileName(file.name)) {
      setUploadError(t("skill_resources.upload_invalid_name"));
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const result = await extensions.saveSkillResource(skillName, { name: file.name, contentBase64 });
      if (result.ok) {
        toast.success(result.message);
        props.onChanged();
      } else {
        setUploadError(result.message);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t("skill_resources.save_failed"));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-dls-text">{t("skill_resources.title")}</div>
          <p className="mt-1 text-[11px] text-dls-secondary">{t("skill_resources.description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.txt,.csv,.docx,.pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void uploadFile(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.busy || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <FilePlus size={13} />}
            {t("skill_resources.upload")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={props.busy} onClick={() => setAddOpen(true)}>
            <Plus size={13} />
            {t("skill_resources.add_as_text")}
          </Button>
        </div>
      </div>

      {uploadError || status ? (
        <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-dls-secondary">
          {uploadError ?? status}
        </div>
      ) : null}

      {resources.length === 0 ? (
        !status ? <div className="mt-3 text-[12px] text-dls-secondary">{t("skill_resources.empty")}</div> : null
      ) : (
        <div className="mt-2 divide-y divide-dls-border/60">
          {resources.map((resource) => (
            <div key={resource.path} className="group flex items-center gap-2.5 py-2">
              <FileText size={14} className="shrink-0 text-dls-secondary" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-dls-text">{resource.name}</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-dls-secondary/70">
                {formatResourceSize(resource.size)}
              </span>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                {isTextResourceName(resource.name) ? (
                  <button
                    type="button"
                    className={rowIconBtnClass}
                    onClick={() => setEditTarget(resource)}
                    disabled={props.busy}
                    title={t("common.edit")}
                    aria-label={t("common.edit")}
                  >
                    <Edit2 size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={rowIconBtnClass}
                  onClick={() => setDeleteTarget(resource)}
                  disabled={props.busy}
                  title={t("common.remove")}
                  aria-label={t("common.remove")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddResourceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        skillName={skillName}
        existingNames={new Set(resources.map((resource) => resource.name))}
        saveSkillResource={extensions.saveSkillResource}
        onChanged={props.onChanged}
      />

      <EditResourceDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        skillName={skillName}
        extensions={extensions}
      />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t("skill_resources.remove_title")}
        message={t("skill_resources.remove_message", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("common.remove")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          void extensions.deleteSkillResource(skillName, target.name).then((result) => {
            if (result.ok) {
              toast.success(result.message);
              props.onChanged();
            } else {
              toast.error(result.message);
            }
          });
        }}
      />
    </div>
  );
}

function AddResourceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillName: string;
  existingNames: Set<string>;
  saveSkillResource: SkillResourcesStore["saveSkillResource"];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fileName = normalizeResourceFileName(name);
  const nameValid = fileName.length > 0 && isValidResourceFileName(fileName);
  const nameTaken = nameValid && props.existingNames.has(fileName);
  const canSubmit = nameValid && content.trim().length > 0 && !saving;

  const reset = () => {
    setName("");
    setContent("");
    setError(null);
    setSaving(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const result = await props.saveSkillResource(props.skillName, { name: fileName, content });
      if (result.ok) {
        toast.success(result.message);
        props.onOpenChange(false);
        reset();
        props.onChanged();
      } else {
        setError(result.message);
        setSaving(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("skill_resources.save_failed"));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        props.onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("skill_resources.add_title")}</DialogTitle>
          <DialogDescription>{t("skill_resources.add_description")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
          {error ? (
            <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{error}</div>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-dls-text">{t("skill_resources.file_name_label")}</span>
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="nda-response-template.md"
              spellCheck={false}
              className={inputClass}
            />
            <span className="text-[11px] text-dls-secondary">
              {fileName.length === 0
                ? t("skill_resources.name_hint")
                : !nameValid
                  ? t("skill_resources.name_hint_invalid")
                  : nameTaken
                    ? t("skill_resources.name_hint_exists")
                    : `resources/${fileName}`}
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-dls-text">{t("skill_resources.content_label")}</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.currentTarget.value)}
              rows={12}
              spellCheck={false}
              placeholder={t("skill_resources.content_placeholder")}
              className={`${inputClass} min-h-[240px] font-mono text-xs`}
            />
          </label>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {t("skill_resources.save_file")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditResourceDialog(props: {
  target: SkillResourceCard | null;
  onClose: () => void;
  skillName: string;
  extensions: SkillResourcesStore;
}) {
  const { target, extensions, skillName } = props;
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setContent("");
    setDirty(false);
    setError(null);
    setLoading(true);
    void extensions
      .readSkillResource(skillName, target.name)
      .then((result) => {
        if (result) setContent(result.content);
        else setError(t("skill_resources.load_failed"));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("skill_resources.load_failed")))
      .finally(() => setLoading(false));
  }, [extensions, skillName, target]);

  const save = useCallback(async () => {
    if (!target || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const result = await extensions.saveSkillResource(skillName, { name: target.name, content });
      if (result.ok) {
        setDirty(false);
        toast.success(result.message);
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("skill_resources.save_failed"));
    } finally {
      setSaving(false);
    }
  }, [content, dirty, extensions, skillName, target]);

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-4xl flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-3">
            <DialogTitle className="min-w-0 flex-1 truncate">{target?.name}</DialogTitle>
            <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {t("common.save")}
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="mb-3 rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{error}</div>
          ) : null}
          {loading ? (
            <div className="text-xs text-dls-secondary">{t("skills.loading")}</div>
          ) : (
            <textarea
              value={content}
              onChange={(event) => {
                setContent(event.currentTarget.value);
                setDirty(true);
              }}
              className="min-h-[420px] w-full rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs font-mono text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]"
              spellCheck={false}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SkillResourcesPanel;
