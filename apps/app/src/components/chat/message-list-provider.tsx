"use memo";

import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"
import * as React from "react"
import type { LegalworkServerClient } from "@/app/lib/legalwork-server"

interface MessageListContextValue {
  /** For the few cards the app fetches itself rather than waiting for the
   * agent, e.g. the matter graph. Null where no server is attached. */
  legalworkClient: LegalworkServerClient | null
  workspaceId: string
  sessionId: string
  showThinking: boolean
  developerMode: boolean
  displaySuggestions: boolean
  providerConnectedCount: number
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
  onEditUserMessage: (messageId: string, text: string) => void
}

const MessageListContext = React.createContext<MessageListContextValue | null>(null)

interface MessageListProviderProps {
  children: React.ReactNode
  legalworkClient?: LegalworkServerClient | null
  workspaceId: string
  sessionId: string
  showThinking: boolean
  developerMode: boolean
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
  onEditUserMessage: (messageId: string, text: string) => void
  displaySuggestions: boolean
  providerConnectedCount: number
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
}

export interface DispatchAction {
  target: "settings"
  action: "open"
  section: "commands" | "skills" | "mcps" | "plugins" | "providers"
}

export function MessageListProvider({
  children,
  legalworkClient = null,
  workspaceId,
  sessionId,
  showThinking,
  developerMode,
  displaySuggestions,
  providerConnectedCount,
  dispatchAction,
  setPrompt,
  onRevertToUserMessage,
  onForkAtMessage,
  onEditUserMessage,
}: MessageListProviderProps) {
  const value = React.useMemo(
    () => ({
      legalworkClient,
      workspaceId,
      sessionId,
      showThinking,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
      onEditUserMessage,
    }),
    [
      legalworkClient,
      workspaceId,
      sessionId,
      showThinking,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
      onEditUserMessage,
    ],
  )

  return (
    <MessageListContext.Provider value={value}>
      {children}
    </MessageListContext.Provider>
  )
}

export function useMessageList() {
  const context = React.useContext(MessageListContext)

  if (!context) {
    throw new Error("useMessageList must be used within a MessageListProvider")
  }

  return context
}

export function useSessionErrorMessage() {
  const { workspaceId, sessionId } = useMessageList();

  return useSessionActivityStore(state => state.getSessionError(workspaceId, sessionId));
}