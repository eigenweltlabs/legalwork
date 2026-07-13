/** @jsxImportSource react */
import { Loader2 } from "lucide-react";

import { useTemplateWorkflowRun } from "../../settings/state/template-workflow-generation";

type SidebarWorkflowGenerationBadgeProps = {
  /** Open the generation session in the chat view (clicking the badge). */
  onOpenSession: (workspaceId: string, sessionId: string) => void;
};

/**
 * Compact card shown in the home sidebar (same slot and styling as the update
 * badge) while a template-to-workflow generation run is in progress. Clicking
 * it opens the live agent session. It disappears on its own when the run
 * finishes; the Workflows view carries the done/error states.
 */
export function SidebarWorkflowGenerationBadge(props: SidebarWorkflowGenerationBadgeProps) {
  const run = useTemplateWorkflowRun();
  if (!run || run.status !== "running") return null;
  const folderName = run.templatesDir.split(/[\/\\]/).filter(Boolean).pop() || run.templatesDir;

  return (
    <div className="px-2 pt-2 mac:titlebar-no-drag">
      <div className="group relative rounded-lg border border-[color:var(--glass-border)] bg-sidebar-accent transition-colors mac:bg-black/5 mac:hover:bg-black/10 dark:mac:bg-white/10 dark:mac:hover:bg-white/15">
        <button
          type="button"
          onClick={() => props.onOpenSession(run.workspaceId, run.sessionId)}
          className="flex w-full items-center gap-2 p-3 text-left"
        >
          <Loader2 className="size-4 shrink-0 animate-spin text-sidebar-accent-foreground" strokeWidth={2.5} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-sidebar-accent-foreground">Generating workflows</div>
            <div className="mt-0.5 truncate text-xs text-sidebar-foreground/60">
              From “{folderName}”. Click to watch.
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
