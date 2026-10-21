import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export function ViewSaveActions({ saved = false, busy = false, saveDisabled = false, onSave, onSaveAs }: { saved?: boolean; busy?: boolean; saveDisabled?: boolean; onSave?: () => void; onSaveAs: () => void }) {
  return <div className="inline-flex shrink-0 items-center" role="group" aria-label={t("views.save_options")}>
    <Button size="sm" variant={saved ? "outline" : "default"} className="rounded-r-none" disabled={busy || saved || saveDisabled} onClick={onSave}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
      {t(saved ? "common.saved" : "common.save")}
    </Button>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant={saved ? "outline" : "default"} className="rounded-l-none border-l border-l-background/25 px-2" disabled={busy} aria-label={t("views.save_options")} />}><ChevronDown className="size-4" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onClick={onSaveAs}>{t("views.save_as")}</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
