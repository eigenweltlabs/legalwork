/** @jsxImportSource react */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isReasoningUIPart, isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type ReasoningUIPart } from "ai";
import { ChevronDown, CircleAlert, LoaderCircle, SquareTerminal, Wrench } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { isBashToolPart, isEnvVarRequestToolPart, isQuestionToolPart } from "@/lib/build-in-tools";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { t } from "@/i18n";
import { MessageContent } from "@/components/ui/message";

type ToolPart = ToolUIPart | DynamicToolUIPart;
export function compactToolName(part: ToolPart) {
  if (isBashToolPart(part)) return t(isToolPartInFlight(part) ? "tool_run.run_command" : "tool_run.ran_command");
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
  if (name === "legalwork_review_results") return t(isToolPartInFlight(part) ? "tool_activity.reading_review_results" : "tool_run.review_results");
  const short = name.replace(/^inapp_/, "").replace(/[_-]+/g, " ");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

export function ToolRun({ parts, showDetails, renderTool, active = false, defaultOpen = false }: {
  parts: Array<ToolPart | ReasoningUIPart>; showDetails: boolean; renderTool: (part: ToolPart) => ReactNode; active?: boolean; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const tools = parts.filter(isToolUIPart);
  // Keep the run active between individual tool calls while the agent is still working.
  const running = active || tools.some(isToolPartInFlight);
  // Questions and credential forms remain reachable while awaiting user input.
  const needsInput = tools.some((part) => isToolPartInFlight(part) && (isQuestionToolPart(part) || isEnvVarRequestToolPart(part)));
  const expanded = open || needsInput;
  useLayoutEffect(() => {
    const node = viewport.current, body = content.current;
    if (!expanded || !node || !body) return;
    following.current = true;
    const follow = () => { if (following.current) node.scrollTop = node.scrollHeight; };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    observer.observe(body);
    return () => observer.disconnect();
  }, [expanded]);
  useLayoutEffect(() => {
    if (expanded && following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [expanded, parts, showDetails]);
  const failed = tools.some((part) => part.state === "output-error");
  return <Collapsible open={expanded} onOpenChange={setOpen} className="w-full min-w-0">
    <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1 text-left text-sm text-muted-foreground hover:text-foreground">
      {running ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <SquareTerminal className="size-4 shrink-0" />}
      <span>{t(running ? "tool_run.running" : "tool_run.finished")}</span>
      <span className="text-xs tabular-nums opacity-60">{tools.length}</span>
      {failed && <CircleAlert className="size-3.5 text-destructive" aria-label={t("tool_run.failed")} />}
      <ChevronDown className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div ref={viewport} data-scrollable className="ml-2 max-h-80 overflow-auto border-l border-border/60 py-2 pl-4 [overflow-anchor:none]"
        onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollHeight - node.clientHeight - node.scrollTop < 32; }}>
      <div ref={content} className="space-y-2">
        {parts.map((part, index) => isReasoningUIPart(part) ? (showDetails && <MessageContent key={`reasoning-${index}`} markdown className="chat-reasoning text-sm text-muted-foreground bg-transparent p-0">{part.text}</MessageContent>) : <div key={part.toolCallId}>
          {showDetails || isQuestionToolPart(part) || isEnvVarRequestToolPart(part) ? renderTool(part) :
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              {isToolPartInFlight(part) ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : isBashToolPart(part) ? <SquareTerminal className="size-3.5 shrink-0" /> : <Wrench className="size-3.5 shrink-0" />}
              <span className="truncate">{compactToolName(part)}</span>
              {part.state === "output-error" && <span className="shrink-0 text-xs text-destructive">{t("tool_run.failed")}</span>}
            </div>}
        </div>)}
      </div>
      </div>
    </CollapsibleContent>
  </Collapsible>;
}
