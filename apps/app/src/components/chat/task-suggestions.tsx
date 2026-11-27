"use client"

import { ArrowRight, ArrowUpRight, Cpu, Plug, Ticket, Wrench } from "lucide-react"
import { useContext } from "react"
import { ChatWorkspaceContext } from "./chat-workspace-context"
import { motion, type Variants } from "motion/react"
import { useMessageList } from "@/components/chat/message-list-provider"
import { TaskIllustration, type TaskIllustrationKind } from "@/components/chat/task-illustration"
import { Button } from "@/components/ui/button"
import { IconTile } from "@/react-app/design-system/surface"
import { cn } from "@/lib/utils"
import { t } from "@/i18n";

// Built per render, not once at import: `t()` reads the current language.
const suggestions = (workspace: "project" | "wiki" | "timekeeping" | "support"): { title: string; description: string; kind: TaskIllustrationKind; prompt: string }[] => workspace === "support" ? [
  { title: t("support.starter_troubleshoot"), description: t("support.starter_troubleshoot_description"), prompt: t("support.starter_troubleshoot_prompt"), kind: "grid" },
  { title: t("support.starter_model"), description: t("support.starter_model_description"), prompt: t("support.starter_model_prompt"), kind: "redline" },
  { title: t("support.starter_ticket"), description: t("support.starter_ticket_description"), prompt: t("support.starter_ticket_prompt"), kind: "summary" },
] : workspace === "timekeeping" ? [
  { title: t("timeChat.review"), description: t("timeChat.reviewDetail"), prompt: t("timeChat.reviewPrompt"), kind: "grid" },
  { title: t("timeChat.draft"), description: t("timeChat.draftDetail"), prompt: t("timeChat.draftPrompt"), kind: "redline" },
  { title: t("timeChat.remember"), description: t("timeChat.rememberDetail"), prompt: t("timeChat.rememberPrompt"), kind: "summary" },
] : workspace === "wiki" ? [
  { title: t("task_suggestions.wiki_explore_title"), description: t("task_suggestions.wiki_explore_desc"), kind: "summary", prompt: t("task_suggestions.wiki_explore_prompt") },
  { title: t("task_suggestions.wiki_update_title"), description: t("task_suggestions.wiki_update_desc"), kind: "redline", prompt: t("task_suggestions.wiki_update_prompt") },
  { title: t("task_suggestions.wiki_dashboard_title"), description: t("task_suggestions.wiki_dashboard_desc"), kind: "grid", prompt: t("task_suggestions.wiki_dashboard_prompt") },
] : [
  {
    title: t("task_suggestions.grid_title"),
    description: t("task_suggestions.grid_desc"),
    kind: "grid",
    prompt: t("task_suggestions.grid_prompt"),
  },
  {
    title: t("task_suggestions.redline_title"),
    description: t("task_suggestions.redline_desc"),
    kind: "redline",
    prompt: t("task_suggestions.redline_prompt"),
  },
  {
    title: t("task_suggestions.summary_title"),
    description: t("task_suggestions.summary_desc"),
    kind: "summary",
    prompt: t("task_suggestions.summary_prompt"),
  },
]

const entrance = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.42, ease: "easeOut" } },
} satisfies Variants

const supportIcons = { grid: Wrench, redline: Cpu, summary: Ticket };

export function TaskSuggestionCards({ className, providerConnectedCount, onConnect, onSelect, variant }: {
  className?: string
  variant?: "support"
  providerConnectedCount: number
  onConnect: () => void
  onSelect: (prompt: string) => void
}) {
  const workspace = useContext(ChatWorkspaceContext)
  return (
    <div className={cn("lw-task-suggestions @container", className)}>
      {providerConnectedCount === 0 ? (
        <motion.div variants={entrance}>
          <Button
            variant="ghost"
            className="lw-provider-connect"
            onClick={onConnect}
          >
            <IconTile size="sm" variant="glass"><Plug size={16} aria-hidden="true" /></IconTile>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-[13px] font-medium text-dls-text">{t("task_suggestions.connect_provider")}</span>
              <span className="block text-xs font-normal text-dls-secondary">{t("task_suggestions.connect_provider_desc")}</span>
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </motion.div>
      ) : null}
      <motion.p variants={entrance} className="lw-task-suggestions-label">{t(variant === "support" ? "support.starter_label" : "task_suggestions.label")}</motion.p>
      <div className="grid min-w-0 grid-cols-1 gap-3 @xl:grid-cols-3">
        {suggestions(variant ?? workspace).map((suggestion) => {
          const SupportIcon = variant === "support" ? supportIcons[suggestion.kind] : null;
          return (
            <motion.div key={suggestion.kind} variants={entrance} className="min-w-0">
              <Button variant="ghost" className="lw-task-card" data-task-kind={suggestion.kind} onClick={() => onSelect(suggestion.prompt)}>
                <span className="lw-task-card-art">
                  {SupportIcon ? (
                    <span className="flex size-full items-center justify-center bg-muted/70">
                      <SupportIcon className="size-7 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
                    </span>
                  ) : <TaskIllustration kind={suggestion.kind} />}
                  <span className="lw-task-card-action" aria-hidden="true"><ArrowUpRight className="lw-task-card-arrow" size={14} /></span>
                </span>
                <span className="lw-task-card-copy">
                  <span className="lw-task-card-title">{suggestion.title}</span>
                  <span className="lw-task-card-description">{suggestion.description}</span>
                </span>
              </Button>
            </motion.div>
          );
        })}
      </div>
    </div>
  )
}

export function TaskSuggestions({ className, variant }: { className?: string; variant?: "support" }) {
  const { displaySuggestions, providerConnectedCount, dispatchAction, setPrompt } = useMessageList()
  if (!displaySuggestions) return null

  return (
    <TaskSuggestionCards
      className={className}
      variant={variant}
      providerConnectedCount={providerConnectedCount}
      onConnect={() => dispatchAction({ target: "settings", action: "open", section: "providers" })}
      onSelect={setPrompt}
    />
  )
}
