import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function InteractionSource(props: {
  session?: { id: string; title: string };
  onOpenSession?: (sessionId: string) => void;
}) {
  if (!props.session) return null;
  const session = props.session;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-dls-border px-4 py-2 text-[12px]">
      <span className="min-w-0 truncate text-dls-secondary" title={session.title}>
        {t("session.requesting_subagent", undefined, { name: session.title })}
      </span>
      {props.onOpenSession ? (
        <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-[12px]"
          onClick={() => props.onOpenSession?.(session.id)}>
          {t("session.open_subagent_chat")}
          <ArrowUpRight size={14} />
        </Button>
      ) : null}
    </div>
  );
}
