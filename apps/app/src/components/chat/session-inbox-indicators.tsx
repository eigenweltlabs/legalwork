import { Loader2 } from "lucide-react";
import { StatusDot } from "@legalwork/ui/react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { getSessionActivityStatusLabel, type SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store";

export function UnreadDot({ unread, className }: { unread: boolean; className?: string }) {
  return unread ? <span className={cn("inline-block size-1.5 shrink-0 rounded-full bg-blue-11", className)} role="img" aria-label={t("sidebar.unread_reply")} title={t("sidebar.unread_reply")} /> : null;
}

export function SessionInboxIndicators({ unread, status, isStreaming, isActive }: SessionStatusIndicatorProps & { unread: boolean }) {
  if (!unread && !isStreaming && !isActive) return null;
  return <span className="pointer-events-none flex shrink-0 items-center gap-2">
    <SessionStatusIndicator status={status} isStreaming={isStreaming} isActive={isActive} />
    {unread && !isStreaming && !isActive && <span className="flex size-3.5 shrink-0 items-center justify-center"><UnreadDot unread /></span>}
  </span>;
}

export interface SessionStatusIndicatorProps {
  className?: string;
  status?: string;
  isStreaming: boolean;
  isActive: boolean;
}

export function SessionStatusIndicator({ className, status, isStreaming, isActive }: SessionStatusIndicatorProps) {
  const activityTitle = isSessionActivityStatus(status) && status !== "idle"
    ? getSessionActivityStatusLabel(status)
    : undefined;
  const title = activityTitle ?? (isStreaming ? t("workspace_list.session_streaming") : t("workspace_list.session_active"));

  // A pending permission or question is not progress. The run has stopped and
  // the user is the only thing that can move it, so it reads as attention
  // rather than activity: a pulsing amber dot, the same idiom the chat status
  // bar already uses, instead of a fourth spinner that only differs in hue.
  if (status === "waiting") {
    return (
      <span
        className={cn("flex size-3.5 shrink-0 items-center justify-center", className)}
        title={title}
        aria-label={title}
      >
        <StatusDot tone="warning" size="sm" pulse />
      </span>
    );
  }

  if (isStreaming) {
    return (
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          status === "error" && "text-red-9",
          className,
        )}
        title={title}
        aria-label={title}
      >
        <Loader2 className="size-3.5 animate-spin" />
      </span>
    );
  }

  if (isActive) {
    return (
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-foreground/45",
          status === "error" && "bg-red-9",
          className,
        )}
        title={title}
        aria-label={title}
      />
    );
  }

  return null;
}

export function isSessionActivityStatus(status: string | undefined): status is SessionActivityStatus {
  return status === "idle" || status === "thinking" || status === "responding" || status === "error" || status === "compacting" || status === "waiting";
}
