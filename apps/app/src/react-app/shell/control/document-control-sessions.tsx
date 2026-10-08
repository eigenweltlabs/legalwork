import { createContext, use, useMemo, type ReactNode } from "react";

// Pane identity is project-scoped; agent identity remains the OpenCode chat id.
// An explicit empty list grants no chat access (e.g. a project with no open chats).
const DocumentControlSessionsContext = createContext<readonly string[] | null>(null);
export function DocumentControlSessions({ sessionIds, children }: { sessionIds: readonly string[] | null; children: ReactNode }) {
  return <DocumentControlSessionsContext value={sessionIds}>{children}</DocumentControlSessionsContext>;
}
export function useDocumentControlSessions(legacySessionId: string) {
  const sessionIds = use(DocumentControlSessionsContext);
  return useMemo(() => sessionIds ?? [legacySessionId], [sessionIds, legacySessionId]);
}
