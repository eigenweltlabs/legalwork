/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { Edit2, FileText, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
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
import { pillPrimaryClass } from "@/react-app/domains/workspace/modal-styles";
import { t } from "@/i18n";
import type { TemplateCard } from "@/app/types";

// The slice of the extensions store the template library needs. Implemented by
// createExtensionsStore alongside the skill methods (same server wiring).
export type TemplatesStore = {
  templates: () => TemplateCard[];
  templatesStatus: () => string | null;
  refreshTemplates: (options?: { force?: boolean }) => void | Promise<void>;
  readTemplate: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveTemplate: (input: { name: string; content?: string; contentBase64?: string }) => Promise<{ ok: boolean; message: string }>;
  deleteTemplate: (name: string) => Promise<{ ok: boolean; message: string }>;
};

// Same editorial "ledger" styling as the Skills/Workflows index.
const ledgerRowClass =
  "group relative flex items-start gap-4 py-4 pl-5 pr-3 transition-colors hover:bg-dls-hover/60";
const rowIconBtnClass =
  "inline-flex size-8 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-40";
const inputClass =
  "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

const TEMPLATE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const TEXT_TEMPLATE_EXTENSIONS = new Set(["md", "markdown", "txt", "csv"]);

export function isTextTemplateName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_TEMPLATE_EXTENSIONS.has(ext);
}

export function normalizeTemplateFileName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.includes(".") ? trimmed : `${trimmed}.md`;
}

export function isValidTemplateFileName(name: string): boolean {
  return (
    TEMPLATE_NAME_REGEX.test(name) &&
    name.length <= 128 &&
    !name.includes("..") &&
    !name.endsWith(" ") &&
    !name.endsWith(".")
  );
}

function formatTemplateSize(bytes: number): string {
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

/**
 * Firm template library: playbooks and response templates stored in
 * .opencode/templates/. Rendered as a section of the Workflows settings page;
 * templates can be attached to a workflow from the workflow editor.
 */
export function TemplatesSection(props: { busy: boolean; extensions: TemplatesStore }) {
  const { extensions } = props;
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TemplateCard | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateCard | null>(null);

  useEffect(() => {
    void extensions.refreshTemplates();
  }, [extensions]);

  const templates = extensions.templates();
  const templatesStatus = extensions.templatesStatus();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-t border-dls-border pt-6 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <span className="lw-section-eyebrow uppercase text-dls-secondary">Firm templates</span>
          <p className="mt-2 max-w-md text-[13px] leading-relaxed text-dls-secondary">
            Playbooks and response templates your firm owns. Attach them to a workflow so the agent drafts from your
            standards. Stored in <span className="font-mono text-[12px]">.opencode/templates/</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" onClick={() => setAddOpen(true)} disabled={props.busy} className={pillPrimaryClass}>
            <Plus size={14} />
            Add template
          </button>
          <button
            type="button"
            onClick={() => void extensions.refreshTemplates({ force: true })}
            disabled={props.busy}
            className={rowIconBtnClass}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {templatesStatus ? (
        <div className="whitespace-pre-wrap break-words rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {templatesStatus}
        </div>
      ) : null}

      {templates.length === 0 ? (
        <div className="border-y border-dls-border py-12 text-center text-[14px] text-dls-secondary">
          No templates yet — add a playbook or response template your workflows should follow.
        </div>
      ) : (
        <div className="divide-y divide-dls-border border-y border-dls-border">
          {templates.map((template) => (
            <div key={template.path} className={ledgerRowClass}>
              <FileText size={16} className="mt-0.5 shrink-0 text-dls-secondary" />
              <div className="min-w-0 flex-1">
                <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{template.name}</h4>
                <p className="mt-1 truncate text-[12px] leading-relaxed text-dls-secondary">
                  {formatTemplateSize(template.size)} · updated {new Date(template.updatedAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                {isTextTemplateName(template.name) ? (
                  <button
                    type="button"
                    className={rowIconBtnClass}
                    onClick={() => setEditTarget(template)}
                    disabled={props.busy}
                    title={t("common.edit")}
                    aria-label={t("common.edit")}
                  >
                    <Edit2 size={15} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={rowIconBtnClass}
                  onClick={() => setDeleteTarget(template)}
                  disabled={props.busy}
                  title={t("common.remove")}
                  aria-label={t("common.remove")}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddTemplateDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingNames={new Set(templates.map((template) => template.name))}
        saveTemplate={extensions.saveTemplate}
      />

      <EditTemplateDialog target={editTarget} onClose={() => setEditTarget(null)} extensions={extensions} />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Remove template"
        message={`Remove ${deleteTarget?.name ?? ""} from the firm template library? Workflows that reference it will stop finding it.`}
        confirmLabel={t("common.remove")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          void extensions.deleteTemplate(target.name).then((result) => {
            if (result.ok) toast.success(result.message);
            else toast.error(result.message);
          });
        }}
      />
    </div>
  );
}

function AddTemplateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: Set<string>;
  saveTemplate: TemplatesStore["saveTemplate"];
}) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fileName = normalizeTemplateFileName(name);
  const nameValid = fileName.length > 0 && isValidTemplateFileName(fileName);
  const nameTaken = nameValid && props.existingNames.has(fileName);
  const canSubmit = nameValid && content.trim().length > 0 && !saving;

  const reset = () => {
    setName("");
    setContent("");
    setError(null);
    setSaving(false);
  };

  const close = () => {
    props.onOpenChange(false);
    reset();
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const result = await props.saveTemplate({ name: fileName, content });
      if (result.ok) {
        toast.success(result.message);
        close();
      } else {
        setError(result.message);
        setSaving(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the template.");
      setSaving(false);
    }
  };

  const uploadFile = async (file: File) => {
    if (!isValidTemplateFileName(file.name)) {
      setError("That file name contains characters the library cannot store. Rename the file and try again.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const result = await props.saveTemplate({ name: file.name, contentBase64 });
      if (result.ok) {
        toast.success(result.message);
        close();
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the file.");
    } finally {
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
          <DialogTitle>Add template</DialogTitle>
          <DialogDescription>
            Paste a playbook or response template, or upload a file (.md, .txt, .docx, .pdf). Saved to your workspace's
            template library.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
          {error ? (
            <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{error}</div>
          ) : null}

          <div>
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
            <Button type="button" variant="outline" disabled={saving} onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} />
              Upload a file…
            </Button>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-dls-text">File name</span>
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="nda-response-template.md"
              spellCheck={false}
              className={inputClass}
            />
            <span className="text-[11px] text-dls-secondary">
              {fileName.length === 0
                ? "A plain file name; .md is added if you leave out the extension."
                : !nameValid
                  ? "Use letters, numbers, spaces, dots, and dashes only — no slashes."
                  : nameTaken
                    ? "A template with this name already exists — saving will replace it."
                    : `.opencode/templates/${fileName}`}
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-dls-text">Content</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.currentTarget.value)}
              rows={12}
              spellCheck={false}
              placeholder={"Paste the template or playbook text here.\n\nThe agent will read this file and follow its structure and language."}
              className={`${inputClass} min-h-[240px] font-mono text-xs`}
            />
          </label>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Saving...
              </>
            ) : (
              "Save template"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditTemplateDialog(props: {
  target: TemplateCard | null;
  onClose: () => void;
  extensions: TemplatesStore;
}) {
  const { target, extensions } = props;
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
      .readTemplate(target.name)
      .then((result) => {
        if (result) setContent(result.content);
        else setError("Could not load the template.");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the template."))
      .finally(() => setLoading(false));
  }, [extensions, target]);

  const save = useCallback(async () => {
    if (!target || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const result = await extensions.saveTemplate({ name: target.name, content });
      if (result.ok) {
        setDirty(false);
        toast.success(result.message);
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the template.");
    } finally {
      setSaving(false);
    }
  }, [content, dirty, extensions, target]);

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

export default TemplatesSection;
