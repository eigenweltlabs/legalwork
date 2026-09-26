import { useRef, useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";

export function ProjectName({ name, onRename }: {
  name: string;
  onRename?: (name: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const cancelled = useRef(false);

  const cancel = () => {
    cancelled.current = true;
    setDraft(null);
  };
  const save = async () => {
    if (saving.current || cancelled.current || draft === null || !onRename) return;
    const next = draft.trim();
    if (!next || next === name) { setDraft(null); return; }
    saving.current = true;
    setBusy(true);
    try {
      if (await onRename(next)) setDraft(null);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return <div className="flex min-w-0 flex-1 items-start gap-2" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) void save();
  }}>
    {draft === null ? <>
      <h1 className="min-w-0 flex-1 break-words text-2xl font-semibold leading-tight tracking-tight">{name}</h1>
      {onRename ? <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t("workspace.rename_title")} title={t("workspace.rename_title")} onClick={() => { cancelled.current = false; setDraft(name); }}><Pencil className="size-4" /></Button> : null}
    </> : <>
      <Input autoFocus aria-label={t("workspace.rename_label")} className="h-8 min-w-0 flex-1 px-1 text-2xl font-semibold leading-tight tracking-tight md:text-2xl" value={draft} readOnly={busy} aria-busy={busy}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key === "Process") return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!saving.current) cancel(); }
          if (event.key === "Enter") { event.preventDefault(); void save(); }
        }} />
      <Button variant="ghost" size="icon-sm" className="shrink-0" disabled={busy || !draft.trim()} aria-label={t("common.save")} title={t("common.save")} onMouseDown={(event) => event.preventDefault()} onClick={() => { void save(); }}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}</Button>
      <Button variant="ghost" size="icon-sm" className="shrink-0" disabled={busy} aria-label={t("common.cancel")} title={t("common.cancel")} onMouseDown={(event) => event.preventDefault()} onClick={cancel}><X className="size-4" /></Button>
    </>}
  </div>;
}
