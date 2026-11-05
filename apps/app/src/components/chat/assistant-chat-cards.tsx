import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import { useState } from "react";
import { ArrowUpRight, ChartNoAxesCombined, FileText } from "lucide-react";
import { useOpenTargets } from "@/lib/target-provider";
import { classifyOpenTarget, resolvePathOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { t } from "@/i18n";
import type { AssistantFileSource } from "@legalwork/types/main-assistant";
import { useRequestPanelTab } from "@/react-app/domains/session/panel/panel-tab-destination";
import { DashboardIcon } from "@/react-app/design-system/dashboard-icon";
import { assistantProjectFileTab, linkedAssistantFiles, sharedAssistantFile } from "./assistant-chat-presentation";

export function AssistantTypingBubble() {
  const [delay] = useState(() => 250 + Math.floor(Math.random() * 200));
  return <div role="status" aria-label={t("assistant.typing")} data-assistant-typing="" className="assistant-typing-bubble flex w-fit items-center gap-1 rounded-3xl bg-foreground/[0.06] px-5 py-4" style={{ animationDelay: `${delay}ms` }}>
    {[0, 1, 2].map(index => <span key={index} aria-hidden="true" className="assistant-typing-dot size-1.5 rounded-full bg-muted-foreground/65" style={{ animationDelay: `${index * 140}ms` }} />)}
  </div>;
}

export function AssistantFileCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const file = sharedAssistantFile(part);
  return file ? <AssistantSharedFileCard file={file} /> : null;
}

export function AssistantLinkedFileCards({ messages }: { messages: UIMessage[] }) {
  const { openTargets } = useOpenTargets();
  return linkedAssistantFiles(messages, openTargets).map(file => <AssistantSharedFileCard key={file.path} file={file} />);
}

export function AssistantSharedFileCard({ file }: { file: { path: string; title: string; filename?: string; description?: string; documentType?: "report" | "dashboard"; size?: number; source?: AssistantFileSource } }) {
  const { openTargets, onOpenTarget } = useOpenTargets();
  const requestPanelTab = useRequestPanelTab();
  const filename = file.filename ?? file.path.split("/").at(-1);
  const projectTab = assistantProjectFileTab(file);
  const target = resolvePathOpenTarget(file.path, openTargets, "assistant-shared") ?? {
    id: `file:${file.path}`, kind: "file", value: file.path, name: file.title,
    preview: classifyOpenTarget(file.path, "file"), confidence: 1, reason: "assistant-shared",
  } satisfies OpenTarget;
  const kind = file.documentType ?? target.documentType ?? (target.preview === "view" ? "report" : null);
  const Icon = kind === "dashboard" ? DashboardIcon : kind === "report" ? ChartNoAxesCombined : FileText;
  return <button type="button" data-assistant-file-card="" aria-label={`${t("scheduled.open")}: ${file.title}`}
    className="group my-1 flex w-[420px] max-w-[90%] items-start gap-3 rounded-3xl border border-border/60 bg-foreground/[0.035] p-4 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    disabled={!projectTab && !onOpenTarget} onClick={() => {
      if (projectTab) requestPanelTab(projectTab, { besideChat: true });
      else onOpenTarget?.({ ...target, name: file.title }, { external: false });
    }}>
    <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-background shadow-sm"><Icon className="size-6 text-blue-10" /></span>
    <span className="min-w-0 flex-1">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{kind ? t(kind === "dashboard" ? "views.dashboard" : "views.report") : target.preview === "markdown" ? "Markdown" : filename?.split(".").at(-1)?.toUpperCase()}</span>
      <span className="mt-1 block break-words text-sm font-semibold leading-snug">{file.title}</span>
      {file.source && <span className="mt-1 block truncate text-xs text-muted-foreground">{file.source.projectName}</span>}
      {file.description && <span className="mt-1.5 block break-words text-xs leading-relaxed text-muted-foreground">{file.description}</span>}
    </span>
    <span aria-hidden="true" className="mt-1 flex shrink-0 items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground"><span>{t("scheduled.open")}</span><ArrowUpRight className="size-3.5" /></span>
  </button>;
}
