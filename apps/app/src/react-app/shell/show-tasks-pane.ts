import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { requestTasksPane } from "../domains/tasks/tasks-pane-request";

/** Open the task on its own route, including from Settings and notifications. */
export function useShowTasksPane(): (taskId: string | null) => void {
  const navigate = useNavigate();
  return useCallback(
    (taskId: string | null) => {
      requestTasksPane(taskId);
      navigate("/tasks");
    },
    [navigate],
  );
}
