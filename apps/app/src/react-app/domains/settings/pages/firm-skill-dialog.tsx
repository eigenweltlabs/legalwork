/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { FirmHubSkillFile } from "@legalwork/types/firm-hub";

import { MarkdownBlock } from "@/components/markdown/markdown";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { FirmItemNote } from "../../connections/org-policy-ui";
import { Spinner } from "../settings-section";

/** Markdown without its front matter: the name and description are shown above it. */
const withoutFrontMatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/**
 * One of the firm's skills or workflows, to read: its instructions and every
 * file it brings. It follows the firm's hub, so nothing here changes it.
 */
export function FirmSkillDialog({ name, added, read, onClose }: {
  name: string;
  /** The member added it from what the firm offers (rather than the admin installing it for everyone). */
  added: boolean;
  read: (name: string, path?: string) => Promise<FirmHubSkillFile>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("SKILL.md");
  const [file, setFile] = useState<FirmHubSkillFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    setError(null);
    read(name, path).then(
      (next) => {
        if (!stopped) setFile(next);
      },
      (cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : t("skills.skill_load_failed"));
      },
    );
    return () => {
      stopped = true;
    };
  }, [name, path, read]);

  // The file asked for, once it is here; the list stays while another one loads.
  const shown = file?.path === path ? file : null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] min-h-0 w-full max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="space-y-1 border-b border-subtle py-4 pl-6 pr-14">
          <span className="lw-section-eyebrow">{t(file?.kind === "workflow" ? "skills.eyebrow_automation" : "skills.eyebrow_skill")}</span>
          <DialogTitle className="truncate text-lg font-semibold text-ink">{name}</DialogTitle>
          <DialogDescription className="line-clamp-2 text-sm text-subtext">{file?.description}</DialogDescription>
          <FirmItemNote added={added} />
        </DialogHeader>
        {file && file.files.length > 1 ? (
          <div className="flex flex-wrap gap-1.5 border-b border-subtle px-6 py-3" aria-label={t("firm_hub.files")}>
            {file.files.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={each === path}
                onClick={() => setPath(each)}
                className={cn(
                  "rounded-full px-3 py-1 font-mono text-[12px] transition-colors",
                  each === path ? "bg-dls-hover text-dls-text" : "text-dls-secondary hover:text-dls-text",
                )}
              >
                {each}
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {error ? (
            <div className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
          ) : !shown ? (
            <div className="flex items-center gap-2 text-sm text-subtext"><Spinner className="size-4" /> {t("skills.loading")}</div>
          ) : shown.content === null ? (
            <p className="text-sm text-subtext">{t("firm_hub.file_not_shown")}</p>
          ) : /\.(md|markdown)$/i.test(shown.path) ? (
            <MarkdownBlock text={withoutFrontMatter(shown.content)} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-ink">{shown.content}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
