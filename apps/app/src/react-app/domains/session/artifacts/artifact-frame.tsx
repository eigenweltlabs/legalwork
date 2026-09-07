import { useState, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PanelHeader } from "@/react-app/design-system/panel-chrome";

export function ArtifactFrame({ title, icon, meta, actions, expandable, children }: {
  title: string;
  icon?: ReactNode;
  meta?: ReactNode;
  actions: ReactNode;
  expandable: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-artifact-expanded={expanded}
      className={expanded
        ? "fixed inset-0 z-40 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background mac:top-11"
        : "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"}
    >
      <PanelHeader wrapActions title={title} icon={icon} meta={meta}>
        {actions}
        {expandable && (
          <Tooltip>
            <TooltipTrigger render={(
              <Button variant="ghost" size="icon-sm" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Restore document panel" : "Expand document"}>
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            )} />
            <TooltipContent>{expanded ? "Restore document panel" : "Expand document"}</TooltipContent>
          </Tooltip>
        )}
      </PanelHeader>
      {children}
    </div>
  );
}
