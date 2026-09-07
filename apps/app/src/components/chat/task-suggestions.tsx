"use client"

import { ArrowRight, ArrowUpRight, Plug } from "lucide-react"
import { motion, type Variants } from "motion/react"
import { useMessageList } from "@/components/chat/message-list-provider"
import { TaskIllustration, type TaskIllustrationKind } from "@/components/chat/task-illustration"
import { Button } from "@/components/ui/button"
import { IconTile } from "@/react-app/design-system/surface"
import { cn } from "@/lib/utils"

const SUGGESTIONS: { title: string; description: string; kind: TaskIllustrationKind; prompt: string }[] = [
  {
    title: "Build a review grid",
    description: "Key terms, side by side.",
    kind: "grid",
    prompt: "Review the contracts in this folder and build a review grid — one row per document, with columns for the parties, effective date, term, governing law, and assignment/change-of-control. Put a short value in each cell with a citation to the source document, and flag anything missing or unusual.",
  },
  {
    title: "Redline a contract",
    description: "Thoughtful changes. Clear rationale.",
    kind: "redline",
    prompt: "Redline this contract: propose your changes as tracked redlines and give me a short rationale for each. If we have a standard template or playbook, mark it up against that.",
  },
  {
    title: "Summarize documents",
    description: "The details that matter, at a glance.",
    kind: "summary",
    prompt: "Summarize the contracts in this folder. For each one, note what it is in a sentence, then give me an overall summary of what this set covers and anything that stands out — citing the source file for the important points.",
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
              <span className="block text-[13px] font-medium text-dls-text">Connect a model provider</span>
              <span className="block text-xs font-normal text-dls-secondary">Choose your AI to get started</span>
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </motion.div>
      ) : null}
      <motion.p variants={entrance} className="lw-task-suggestions-label">A place to start</motion.p>
      <div className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-3">
        {SUGGESTIONS.map((suggestion) => (
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
