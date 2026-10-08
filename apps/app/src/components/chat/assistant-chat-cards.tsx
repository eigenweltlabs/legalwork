import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOpenTargets } from "@/lib/target-provider";
import { classifyOpenTarget, resolvePathOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { t } from "@/i18n";
import type { AssistantFileSource } from "@legalwork/types/main-assistant";
import { requestPanelTab } from "@/react-app/domains/session/panel/panel-tab-request";
import { assistantProjectFileTab, linkedAssistantFiles, sharedAssistantFile } from "./assistant-chat-presentation";

export function AssistantTypingBubble() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 250 + Math.random() * 350);
    return () => window.clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return <div role="status" aria-label={t("assistant.typing")} data-assistant-typing="" className="my-2 flex w-fit items-center gap-1 rounded-3xl bg-foreground/[0.06] px-5 py-4">
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

export function AssistantSharedFileCard({ file }: { file: { path: string; title: string; filename?: string; description?: string; size?: number; source?: AssistantFileSource } }) {
  const { openTargets, onOpenTarget } = useOpenTargets();
  const filename = file.filename ?? file.path.split("/").at(-1);
  const projectTab = assistantProjectFileTab(file);
  const target = resolvePathOpenTarget(file.path, openTargets, "assistant-shared") ?? {
    id: `file:${file.path}`, kind: "file", value: file.path, name: file.title,
    preview: classifyOpenTarget(file.path, "file"), confidence: 1, reason: "assistant-shared",
  } satisfies OpenTarget;
  return <div data-assistant-file-card="" className="my-1 flex w-[360px] max-w-[85%] items-center gap-3 rounded-3xl bg-foreground/[0.06] px-4 py-3">
    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background/80"><FileText className="size-5 text-blue-10" /></div>
    <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{file.title}</p>{file.title !== filename && <p className="mt-0.5 truncate text-xs text-muted-foreground">{filename}</p>}{file.source && <p className="mt-0.5 truncate text-xs text-muted-foreground">{file.source.projectName}</p>}{file.description && <p className="mt-1 break-words text-xs text-muted-foreground">{file.description}</p>}</div>
    <Button variant="outline" size="sm" className="shrink-0 rounded-full bg-background/80" disabled={!projectTab && (!target || !onOpenTarget)} onClick={() => {
      if (projectTab) requestPanelTab(projectTab);
      else if (target) onOpenTarget?.({ ...target, name: file.filename ?? target.name }, { external: false });
    }}>{t("scheduled.open")}</Button>
  </div>;
}
