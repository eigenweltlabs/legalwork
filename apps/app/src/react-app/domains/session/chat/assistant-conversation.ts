/** Workspace membership alone does not make a subagent the personal Assistant. */
export function isAssistantConversation(sessionId: string | null | undefined, currentDayId: string | undefined, session?: { parentID?: string | null }) {
  return Boolean(sessionId && !session?.parentID && (sessionId === currentDayId || session));
}
