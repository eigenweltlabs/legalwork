/** @jsxImportSource react */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isReasoningUIPart, isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type ReasoningUIPart } from "ai";
import { Ban, ChevronDown, CircleAlert, ListChecks } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { isEnvVarRequestToolPart, isQuestionToolPart } from "@/lib/build-in-tools";
import { getToolActivityLabel, isToolPartInFlight, isToolPermissionDenied } from "@/lib/tool-activity";
import { getToolHistoryLabel, getToolIcon, getToolRunSummary } from "@/components/tools/tool-presentation";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { MessageContent } from "@/components/ui/message";

type ToolPart = ToolUIPart | DynamicToolUIPart;
export function ToolRun({ parts, showDetails, renderTool, active = false, defaultOpen = false }: {
  parts: Array<ToolPart | ReasoningUIPart>; showDetails: boolean; renderTool: (part: ToolPart) => ReactNode; active?: boolean; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const tools = parts.filter(isToolUIPart);
  const activeTool = tools.findLast(isToolPartInFlight);
  const failedTool = tools.findLast(part => part.state === "output-error" && !isToolPermissionDenied(part));
  const deniedTool = tools.some(isToolPermissionDenied);
  const latestTool = activeTool ?? tools.at(-1);
  const working = active || Boolean(activeTool);
  const Icon = latestTool ? getToolIcon(latestTool) : ListChecks;
  const label = working && latestTool ? getToolActivityLabel(latestTool) : tools.length ? getToolRunSummary(tools) : t(working ? "tool.working" : "tool_run.summary.tool");
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
  return <Collapsible open={expanded} onOpenChange={setOpen} className="w-full min-w-0">
    <CollapsibleTrigger className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Icon className="size-4 shrink-0" strokeWidth={1.6} aria-hidden />
      <span className={cn("min-w-0 truncate", working && !needsInput && "lw-tool-shimmer")} title={label}>{label}</span>
      <span className="min-w-4 shrink-0 text-xs tabular-nums opacity-50">{tools.length || ""}</span>
      {failedTool && <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label={t("tool_run.failed")} />}
      {deniedTool && !failedTool && <Ban className="size-3.5 shrink-0" aria-label={t("tool_run.permission_denied")} />}
      <ChevronDown className="size-3.5 shrink-0 opacity-50 transition-[transform,opacity] group-hover:opacity-100 group-data-panel-open:rotate-180" aria-hidden />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div ref={viewport} data-scrollable className="ml-2 max-h-80 overflow-auto border-l border-border/60 py-2 pl-4 [overflow-anchor:none]"
        onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollHeight - node.clientHeight - node.scrollTop < 32; }}>
      <div ref={content} className="space-y-2">
        {parts.map((part, index) => {
          if (isReasoningUIPart(part)) return showDetails && <MessageContent key={`reasoning-${index}`} markdown className="chat-reasoning text-sm text-muted-foreground bg-transparent p-0">{part.text}</MessageContent>;
          const PartIcon = getToolIcon(part);
          return <div key={part.toolCallId}>
          {showDetails || isQuestionToolPart(part) || isEnvVarRequestToolPart(part) ? renderTool(part) :
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <PartIcon className="size-3.5 shrink-0" strokeWidth={1.6} aria-hidden />
              <span className={cn("truncate", isToolPartInFlight(part) && "lw-tool-shimmer")}>{getToolHistoryLabel(part)}</span>
              {part.state === "output-error" && !isToolPermissionDenied(part) && <span className="shrink-0 text-xs text-destructive">{t("tool_run.failed")}</span>}
            </div>}
        </div>;
        })}
      </div>
      </div>
    </CollapsibleContent>
  </Collapsible>;
}
