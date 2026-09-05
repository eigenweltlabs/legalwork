"use client"

import { motion, useReducedMotion } from "motion/react"
import type { ReactNode } from "react"
import { useMessageList } from "@/components/chat/message-list-provider"
import { TaskSuggestions } from "@/components/chat/task-suggestions"
import "./session-surfaces.css"

export function WelcomeHeading() {
  return (
    <motion.div
      className="lw-session-welcome-heading"
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.42, ease: "easeOut" } },
      }}
    >
      <h2 className="lw-session-welcome-title">
        Hello. <span className="sr-only">Let’s get to work.</span>
        <span aria-hidden="true">
          {Array.from("Let’s get to work.", (letter, index) => (
            <span key={index} className="lw-welcome-letter" style={{ animationDelay: `${500 + index * 40}ms` }}>{letter}</span>
          ))}
        </span>
      </h2>
      <p className="lw-session-welcome-description">
        Review a document, draft something new, or explore your files.
      </p>
    </motion.div>
  )
}

/** A quiet, one-time entrance for each empty conversation. */
export function WelcomeSurface({ children, replayKey }: { children: ReactNode; replayKey: string }) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.section
      key={replayKey}
      aria-label="Start a conversation"
      className="lw-session-welcome"
      initial={reduceMotion ? false : "hidden"}
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: reduceMotion ? 0 : 0.075 } },
      }}
    >
      <WelcomeHeading />
      {children}
    </motion.section>
  )
}

export function SessionWelcome() {
  const { sessionId } = useMessageList()
  return <WelcomeSurface replayKey={sessionId}><TaskSuggestions /></WelcomeSurface>
}
