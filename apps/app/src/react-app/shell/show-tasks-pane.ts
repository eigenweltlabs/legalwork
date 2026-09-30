import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { requestTasksPane } from "../domains/tasks/tasks-pane-request";
import { readActiveWorkspaceId, readLastSessionFor } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";

/** The paths the session route renders: where the Tasks pane lives. */
const SESSION_VIEW_PATH = /^\/(?:session|tasks|evals)(?:\/|$)|^\/workspace\/[^/]+\/(?:session|evals|project)(?:\/|$)/;

/** Whether a path shows the session view (and so can open the Tasks pane in place). */
export function isSessionViewPath(pathname: string): boolean {
  return SESSION_VIEW_PATH.test(pathname);
}

/** The workspace a settings path names, if it names one. */
function workspaceOfPath(pathname: string): string | null {
  const match = /^\/workspace\/([^/]+)\//.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Show a task — or, with null, the task list — in the Tasks pane, from
 * anywhere in the app (a task notification). The pane lives in the session
 * view: from another screen the app returns to the session the user was last
 * in, and the pane opens there.
 */
export function useShowTasksPane(): (taskId: string | null) => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback(
    (taskId: string | null) => {
      requestTasksPane(taskId);
      if (isSessionViewPath(pathname)) return;
      const workspaceId = workspaceOfPath(pathname) ?? readActiveWorkspaceId();
      navigate(workspaceId ? workspaceSessionRoute(workspaceId, readLastSessionFor(workspaceId)) : "/session");
    },
    [navigate, pathname],
  );
}
