"use client"

import { ArrowRight, ArrowUpRight, Plug } from "lucide-react"
import { motion, type Variants } from "motion/react"
import { useMessageList } from "@/components/chat/message-list-provider"
import { TaskIllustration, type TaskIllustrationKind } from "@/components/chat/task-illustration"
import { Button } from "@/components/ui/button"
import { IconTile } from "@/react-app/design-system/surface"
import { cn } from "@/lib/utils"
import { t } from "@/i18n";

// Built per render, not once at import: `t()` reads the current language.
const suggestions = (): { title: string; description: string; kind: TaskIllustrationKind; prompt: string }[] => [
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

export function TaskSuggestionCards({ className, providerConnectedCount, onConnect, onSelect }: {
  className?: string
  providerConnectedCount: number
  onConnect: () => void
  onSelect: (prompt: string) => void
}) {
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
      <motion.p variants={entrance} className="lw-task-suggestions-label">{t("task_suggestions.label")}</motion.p>
      <div className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-3">
        {suggestions().map((suggestion) => (
          <motion.div key={suggestion.kind} variants={entrance} className="min-w-0">
            <Button variant="ghost" className="lw-task-card" onClick={() => onSelect(suggestion.prompt)}>
              <span className="lw-task-card-art">
                <TaskIllustration kind={suggestion.kind} />
                <ArrowUpRight className="lw-task-card-arrow" size={15} aria-hidden="true" />
              </span>
              <span className="lw-task-card-copy">
                <span className="lw-task-card-title">{suggestion.title}</span>
                <span className="lw-task-card-description">{suggestion.description}</span>
              </span>
            </Button>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

export function TaskSuggestions({ className }: { className?: string }) {
  const { displaySuggestions, providerConnectedCount, dispatchAction, setPrompt } = useMessageList()
  if (!displaySuggestions) return null

  return (
    <TaskSuggestionCards
      className={className}
      providerConnectedCount={providerConnectedCount}
      onConnect={() => dispatchAction({ target: "settings", action: "open", section: "providers" })}
      onSelect={setPrompt}
    />
  )
}
