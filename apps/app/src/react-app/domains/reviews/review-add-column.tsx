import { BookOpen, ChevronDown, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export function ReviewAddColumnButton({ compact = false, disabled, onSelect }: {
  compact?: boolean;
  disabled: boolean;
  onSelect: (source: "new" | "library") => void;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger disabled={disabled} render={<Button variant={compact ? "ghost" : "outline"} size={compact ? "icon-sm" : "sm"} className={compact ? undefined : "h-8"} aria-label={t("review.add_column")} />}>
      <Plus className="size-3.5" />
      {!compact && <>{t("review.add_column")}<ChevronDown className="size-3.5 text-muted-foreground" /></>}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuItem className="items-start gap-3 py-2.5" onClick={() => onSelect("new")}>
        <Pencil className="mt-0.5" />
        <span><span className="block font-medium">{t("review.column_new")}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t("review.create_column")}</span></span>
      </DropdownMenuItem>
      <DropdownMenuItem className="items-start gap-3 py-2.5" onClick={() => onSelect("library")}>
        <BookOpen className="mt-0.5" />
        <span><span className="block font-medium">{t("review.column_from_library")}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t("review.column_from_library_hint")}</span></span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
