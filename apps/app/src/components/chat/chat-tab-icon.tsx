import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { emptyInteractionSessions, interactionSessionsKey, type InteractionSessions } from "@/react-app/domains/session/sync/interaction-state";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { unreadSession, useSessionInboxStore } from "@/react-app/domains/session/sidebar/session-inbox-store";
import { isStreamingSessionStatus } from "@/react-app/domains/session/sidebar/utils";
import { SessionInboxIndicators } from "./session-inbox-indicators";
import { SubagentDot, subagentColors } from "./subagent-dot";

export function ChatTabIndicators({ workspaceId, sessionId }: { workspaceId: string | null; sessionId: string }) {
  const status = useSessionActivityStore(state => workspaceId ? state.getStatus(workspaceId, sessionId) : "idle");
  const unread = useSessionInboxStore(state => unreadSession(state, sessionId));
  return <SessionInboxIndicators unread={unread} status={status} isStreaming={isStreamingSessionStatus(status)} isActive={status !== "idle"} />;
}

export function ChatTabIcon({ workspaceId, sessionId }: { workspaceId: string | null; sessionId: string }) {
  const key = useMemo(() => workspaceId ? interactionSessionsKey(workspaceId) : null, [workspaceId]);
  const sessions = useQueryCacheState<InteractionSessions>(key, emptyInteractionSessions);
  const colors = useMemo(() => subagentColors(sessionId, sessions), [sessionId, sessions]);
  const status = useSessionActivityStore(state => workspaceId ? state.getStatus(workspaceId, sessionId) : "idle");
  return sessions[sessionId]?.parentID
    ? <SubagentDot color={colors.get(sessionId)} status={status} />
    : <MessageSquare />;
}
