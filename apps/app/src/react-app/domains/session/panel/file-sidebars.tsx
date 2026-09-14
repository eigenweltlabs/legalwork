/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import type { FileSidebarItem } from "../../../shell/ui-state-store";

/** Keep visited navigation panes mounted so previews, rail switches and closing
 * the navigation column preserve folder expansion, search and scroll position.
 * Unvisited panes do not load their connections or folders.
 */
export function FileSidebars(props: {
  active: FileSidebarItem | null;
  memory: ReactNode;
  files: ReactNode;
}) {
  const panelRef = usePanelRef();
  const expandedWidth = useRef(300);
  const [visited, setVisited] = useState<FileSidebarItem[]>([]);
  useEffect(() => {
    const active = props.active;
    if (active) {
      setVisited((current) => (current.includes(active) ? current : [...current, active]));
    }
    // Panel constraints are re-registered when visibility changes. Resize only
    // after the group has applied them, so a reopening does not use maxSize=0.
    const frame = requestAnimationFrame(() => {
      if (active) panelRef.current?.resize(expandedWidth.current);
      else panelRef.current?.collapse();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.active, panelRef]);

  return (
    <>
      <ResizableHandle withHandle className={props.active ? "hidden lg:flex" : "hidden"} />
      <ResizablePanel
        id="file-navigation"
        panelRef={panelRef}
        collapsible={!props.active}
        collapsedSize="0px"
        defaultSize={props.active ? "300px" : "0px"}
        minSize={props.active ? "220px" : "0px"}
        maxSize={props.active ? "40%" : "0px"}
        disabled={!props.active}
        onResize={(size) => {
          if (props.active && size.inPixels > 0) expandedWidth.current = size.inPixels;
        }}
        className="min-h-0 overflow-hidden"
      >
        {(["memory", "files"] satisfies FileSidebarItem[]).map((kind) => (
          <div key={kind} hidden={props.active !== kind} className="h-full min-h-0">
            {props.active === kind || visited.includes(kind) ? props[kind] : null}
          </div>
        ))}
      </ResizablePanel>
    </>
  );
}
