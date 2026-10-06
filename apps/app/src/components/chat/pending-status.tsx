import { Loader2 } from "lucide-react";
import { t } from "@/i18n";

export function PendingStatus({ label = t("session.thinking"), preparing = false }: { label?: string; preparing?: boolean }) {
  return <div role="status" aria-live="polite" className="flex items-center gap-2 py-1 text-sm leading-relaxed text-muted-foreground">
    {preparing ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : null}
    <span className={preparing ? undefined : "lw-tool-shimmer"}>{label}</span>
  </div>;
}
