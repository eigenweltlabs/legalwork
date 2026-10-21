import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function ViewSaveActions({ saved = false, busy = false, saveDisabled = false, onSave, onSaveCopy }: { saved?: boolean; busy?: boolean; saveDisabled?: boolean; onSave?: () => void; onSaveCopy: () => void }) {
  return <div className="inline-flex shrink-0 items-center gap-2" role="group" aria-label={t("views.save_options")}>
    {saved ? <span className="text-xs text-muted-foreground">{t("common.saved")}</span> : <Button size="sm" disabled={busy || saveDisabled} onClick={onSave}>
      {busy && <Loader2 className="size-4 animate-spin" />}{t("common.save")}
    </Button>}
    <Button size="sm" variant="outline" disabled={busy} onClick={onSaveCopy}>{t("views.save_copy")}</Button>
  </div>;
}
