import type { ReactElement } from "react";
import { FolderOpen } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import type { WorkspaceSessionGroup } from "@/app/types";
import { compareSessionRecency, getRootSessions, isSessionArchived } from "./utils";

export function allProjectSessions(groups: WorkspaceSessionGroup[], pinnedIds?: ReadonlySet<string>) {
  const seen = new Set<string>();
  return groups.flatMap(group => {
    const active = group.sessions.filter(session => !isSessionArchived(session));
    const roots = new Set(getRootSessions(active).map(session => session.id));
    return active.filter(session => {
      // Explicit pins also surface child chats in the global pinned section.
      if ((!roots.has(session.id) && !pinnedIds?.has(session.id)) || seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    }).map(session => ({ session, workspace: group.workspace }));
  })
    .sort((a, b) => compareSessionRecency(a.session, b.session));
}

export function SessionProjectHover({ session, projectName, children }: {
  session: WorkspaceSessionGroup["sessions"][number]; projectName: string; children: ReactElement;
}) {
  return <HoverCard><HoverCardTrigger render={children} delay={450} />
    <HoverCardContent side="right" align="start" className="w-80 space-y-2 p-3">
      <div className="font-medium leading-snug">{getDisplaySessionTitle(session.title)}</div>
      <div className="flex items-center gap-2 text-muted-foreground"><FolderOpen className="size-4 shrink-0" /><span className="truncate">{projectName}</span></div>
    </HoverCardContent>
  </HoverCard>;
}
