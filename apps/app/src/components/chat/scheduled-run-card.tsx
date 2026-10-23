import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Clock3 } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useMessageList } from "./message-list-provider";

/** The scheduler's persisted envelope, including runs created before cards existed. */
export function scheduledRunOf(message: UIMessage) {
  if (message.role !== "user") return null;
  const text = message.parts.filter(part => part.type === "text").map(part => part.text).join("");
  const match = /^\[Scheduled task: ([^\r\n]+)\]\r?\n\r?\n([\s\S]*)$/.exec(text);
  return match ? { title: match[1], prompt: match[2] } : null;
}

export function ScheduledRunCard({ run, created }: { run: { title: string; prompt: string }; created: number | null }) {
  const { legalworkClient, workspaceId } = useMessageList();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["scheduled-tasks", legalworkClient?.baseUrl], enabled: Boolean(legalworkClient),
    queryFn: () => legalworkClient!.scheduledTasks(), staleTime: 15000 });
  // A historical run may outlive its schedule. Never guess between identically named tasks.
  const matches = query.data?.tasks.filter(task => task.workspaceId === workspaceId && task.title === run.title) ?? [];
  const task = matches.length === 1 ? matches[0] : null;
  return <section aria-label={t("scheduled.run_label")} className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-background shadow-sm" data-scheduled-run="">
    <div className="flex items-center gap-3 p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11"><Clock3 className="size-5" /></span>
      <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{run.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{t("scheduled.run_label")}{created !== null && <> · <time dateTime={new Date(created).toISOString()}>{new Date(created).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></>}</p></div>
      <Button size="sm" variant="outline" onClick={() => navigate(task ? `/scheduled?task=${encodeURIComponent(task.id)}` : "/scheduled")}>{t(task ? "scheduled.open" : "scheduled.title")}</Button>
    </div>
    <details className="border-t px-4 py-2.5 text-xs text-muted-foreground"><summary className="cursor-pointer select-none">{t("scheduled.run_instructions")}</summary><p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words py-3 leading-relaxed">{run.prompt}</p></details>
  </section>;
}
