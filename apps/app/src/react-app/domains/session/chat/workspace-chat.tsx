import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "../sync/session-sync";
import { useEffect, useMemo } from "react";
import { createClient } from "@/app/lib/opencode";
import { useSessionInteractions } from "../sync/use-session-interactions";
import { SessionSurface, type SessionSurfaceProps } from "../surface/session-surface";

/** Each open chat owns its approvals, questions and todos. Focusing a different
 * tab changes navigation, never the session to which an action is addressed. */
export function WorkspaceChat(props: SessionSurfaceProps) {
  const client = useMemo(() => createClient(props.opencodeBaseUrl, props.workspaceRoot || undefined,
    { token: props.legalworkToken, mode: "legalwork" }), [props.opencodeBaseUrl, props.workspaceRoot, props.legalworkToken]);
  useEffect(() => {
    const input = { workspaceId: props.workspaceId, baseUrl: props.opencodeBaseUrl, legalworkToken: props.legalworkToken };
    const releaseWorkspace = ensureWorkspaceSessionSync(input);
    const releaseSession = trackWorkspaceSessionSync(input, props.sessionId);
    return () => { releaseSession(); releaseWorkspace(); };
  }, [props.workspaceId, props.opencodeBaseUrl, props.legalworkToken, props.sessionId]);
  const interactions = useSessionInteractions({ client, workspaceId: props.workspaceId, sessionId: props.sessionId, workspaceRoot: props.workspaceRoot });
  return <div className="h-full min-h-0" data-workspace-chat={props.sessionId} data-workspace-tab-active={props.active !== false}>
    <SessionSurface {...props} {...interactions} />
  </div>;
}
