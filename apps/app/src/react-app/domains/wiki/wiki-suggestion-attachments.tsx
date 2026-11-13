import { FileText, ArrowUpRight } from "lucide-react";
import type { WikiSuggestion } from "@legalwork/types/wiki-suggestions";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/lib/utils";
import { t } from "@/i18n";

export function WikiSuggestionAttachments({ draft, disabled, onOpen, onRemove }: {
  draft: WikiSuggestion; disabled: boolean;
  onOpen: (path: string) => void; onRemove: (name: string) => void;
}) {
  if (!draft.attachments.length) return null;
  return <section className="mt-4" aria-label={t("wiki.source_files")}>
    <h3 className="text-xs font-medium text-muted-foreground">{t("wiki.source_files")}</h3>
    <ul className="mt-2 divide-y overflow-hidden rounded-xl border">
      {draft.attachments.map(file => <li key={file.name} className="flex items-center gap-2 px-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left hover:text-primary" title={file.name} onClick={() => onOpen(file.path)}>
          <FileText className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{file.name}</span><span className="block text-xs text-muted-foreground">{formatFileSize(file.size)}</span></span>
          <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
        {draft.status === "pending" && <Button size="sm" variant="ghost" disabled={disabled} aria-label={t("wiki.remove_source_file", { name: file.name })} onClick={() => onRemove(file.name)}>{t("wiki.remove_source")}</Button>}
      </li>)}
    </ul>
  </section>;
}
