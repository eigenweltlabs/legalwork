"use client"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { isToolPartInFlight, isToolPermissionDenied } from "@/lib/tool-activity"
import { getToolHistoryLabel, getToolIcon } from "@/components/tools/tool-presentation"
import { cn } from "@/lib/utils"
import {
  ChevronDown,
  Ban,
  CircleAlert,
} from "lucide-react"
import type { DynamicToolUIPart, ToolUIPart } from "ai"
import { t } from "@/i18n";

export type ToolPart = ToolUIPart | DynamicToolUIPart

export type ToolProps = {
  title?: string
  toolPart: ToolPart
  defaultOpen?: boolean
  className?: string
}

const formatValue = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

function isDiffText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.includes("@@") || value.includes("+++ ") || value.includes("--- "))
  )
}

/** Tools like apply_patch carry the diff in their input (patchText). */
function getInputDiff(input: unknown): string | null {
  if (isDiffText(input)) {
    return input
  }
  if (typeof input === "object" && input !== null && "patchText" in input) {
    const value = input.patchText
    if (isDiffText(value)) {
      return value
    }
  }
  return null
}

function diffLineClass(line: string) {
  if (line.startsWith("+")) return "text-green-11 bg-green-1/40"
  if (line.startsWith("-")) return "text-red-11 bg-red-1/40"
  if (line.startsWith("@@")) return "text-blue-11 bg-blue-1/30"
  return ""
}

function DiffLines({ diff }: { diff: string }) {
  return (
    <div className="max-h-60 overflow-auto rounded-md font-mono leading-relaxed">
      {diff.split("\n").map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={cn(
            "whitespace-pre-wrap wrap-break-word px-1",
            diffLineClass(line)
          )}
        >
          {line || " "}
        </div>
      ))}
    </div>
  )
}

const Tool = ({ title, toolPart, defaultOpen = false, className }: ToolProps) => {
  const { state, input } = toolPart
  const inFlight = isToolPartInFlight(toolPart)
  const denied = isToolPermissionDenied(toolPart)
  const isError = state === "output-error" && !denied
  const label = title ?? getToolHistoryLabel(toolPart)
  const hasInput = input !== null && input !== undefined
  const hasOutput = "output" in toolPart && toolPart.output !== undefined
  const inputDiff = getInputDiff(input)
  const Icon = getToolIcon(toolPart)

  return (
    <Collapsible className={className} defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        className="group text-muted-foreground hover:text-foreground flex w-full min-w-0 cursor-pointer items-center justify-start gap-2 overflow-hidden text-start text-sm transition-colors"
      >
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <span className="transition-opacity group-hover:opacity-0">
            {denied ? <Ban className="size-4" /> : isError ? (
              <CircleAlert className="text-destructive size-4" />
            ) : (
              <Icon className="size-3.5" />
            )}
          </span>
          <ChevronDown className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100 group-data-panel-open:rotate-180" />
        </span>
        <span className={cn("min-w-0 truncate", inFlight && "lw-tool-shimmer")}>{label}</span>
        {isError ? (
          <span className="text-destructive shrink-0 text-xs">{t("tool_run.failed")}</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden text-sm transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="bg-muted mt-2 flex flex-col gap-2 rounded-lg p-2 text-xs">
          {hasInput ? (
            inputDiff !== null ? (
              <DiffLines diff={inputDiff} />
            ) : (
              <pre className="whitespace-pre-wrap wrap-break-word">
                {formatValue(input)}
              </pre>
            )
          ) : null}
          {hasOutput ? (
            isDiffText(toolPart.output) ? (
              <DiffLines diff={toolPart.output} />
            ) : (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
                {formatValue(toolPart.output)}
              </pre>
            )
          ) : null}
          {isError && toolPart.errorText ? (
            <pre className="text-destructive whitespace-pre-wrap wrap-break-word">
              {toolPart.errorText}
            </pre>
          ) : null}
          {inFlight && !hasInput ? (
            <span className="text-muted-foreground">{t("tool.waiting_for_input")}</span>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export { Tool }
