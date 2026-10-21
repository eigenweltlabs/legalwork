import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function ViewSaveActions({ saved = false, busy = false, saveDisabled = false, onSave, onSaveCopy }: { saved?: boolean; busy?: boolean; saveDisabled?: boolean; onSave?: () => void; onSaveCopy: () => void }) {
  return <div className="inline-flex shrink-0 items-center" role="group" aria-label={t("views.save_options")}>
    <Button size="sm" variant={saved ? "outline" : "default"} className="rounded-r-none" disabled={busy || saved || saveDisabled} onClick={onSave}>
      {busy && <Loader2 className="size-4 animate-spin" />}{t(saved ? "common.saved" : "common.save")}
    </Button>
    <Button size="sm" variant={saved ? "outline" : "default"} className="rounded-l-none border-l border-l-background/25 px-2" disabled={busy} aria-label={t("views.save_copy")} aria-haspopup="dialog" onClick={onSaveCopy}><ChevronDown className="size-4" /></Button>
  </div>;
}
