import { useMemo } from "react";
import { createClient } from "@/app/lib/opencode";
import { useSessionInteractions } from "../sync/use-session-interactions";
import { SessionSurface, type SessionSurfaceProps } from "../surface/session-surface";

/** Each open chat owns its approvals, questions and todos. Focusing a different
 * tab changes navigation, never the session to which an action is addressed. */
export function WorkspaceChat(props: SessionSurfaceProps) {
  const client = useMemo(() => createClient(props.opencodeBaseUrl, props.workspaceRoot || undefined,
    { token: props.legalworkToken, mode: "legalwork" }), [props.opencodeBaseUrl, props.workspaceRoot, props.legalworkToken]);
  const interactions = useSessionInteractions({ client, workspaceId: props.workspaceId, sessionId: props.sessionId, workspaceRoot: props.workspaceRoot });
  return <div className="h-full min-h-0" data-workspace-chat={props.sessionId} data-workspace-tab-active={props.active !== false}>
    <SessionSurface {...props} {...interactions} />
  </div>;
}
