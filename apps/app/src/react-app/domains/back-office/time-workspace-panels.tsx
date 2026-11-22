import { useLayoutEffect, useState, type ReactNode } from "react";
import { CalendarDays, List, MessageSquare } from "lucide-react";
import { z } from "@legalwork/types/back-office";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { SidePanel, type WorkspacePage } from "../session/panel/side-panel";
import { usePanelTabStore } from "../session/panel/panel-tab-store";

const viewSchema = z.enum(["entries", "timeline", "chat"]);
type View = z.infer<typeof viewSchema>;
export type TimelineView = "combined" | "matters";
const labelKeys = { entries: "timeWorkspace.entries", timeline: "timesheets.timeline", chat: "timeWorkspace.chat" } as const;
const icons = { entries: List, timeline: CalendarDays, chat: MessageSquare };
const defaultGroups = {
  left: { tabs: ["entries"], active: "entries" },
  right: { tabs: ["timeline", "chat"], active: "timeline" },
} satisfies Record<string, { tabs: View[]; active: View }>;
const idFor = (view: View) => "timekeeping:" + view;

function initialLayout() {
  const groups = defaultGroups;
  const order = [...groups.left.tabs, ...groups.right.tabs];
  const tabs = order.map(view => ({ type: "workspace-page", id: idFor(view), label: t(labelKeys[view]) }));
  const pane = (id: string, views: View[], active: View | null) => ({
    id, tabIds: views.map(idFor), activeTabId: active && views.includes(active) ? idFor(active) : null,
  });
  return { tabs, panes: [pane("main", groups.left.tabs, groups.left.active), pane("side", groups.right.tabs, groups.right.active)],
    tree: { type: "split", id: "workday", direction: "horizontal", first: { type: "pane", id: "main" }, second: { type: "pane", id: "side" } },
    sizes: { workday: { main: 67, side: 33 } }, focusedPaneId: "main" };
}

function installLayout(sessionId: string) {
  const layout = usePanelTabStore.getState().readLayout(initialLayout());
  if (layout) usePanelTabStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: layout } }));
}

export function TimeWorkspacePanels({ scope, entries, timeline, chat, visible = true }: {
  scope: string;
  entries: ReactNode;
  timeline: (view: TimelineView, choose: (view: TimelineView) => void) => ReactNode;
  chat: (visible: boolean) => ReactNode;
  visible?: boolean;
}) {
  const sessionId = "timekeeping:" + scope;
  const locale = useLocale();
  const timelineKey = sessionId + ":timeline";
  const [view, setView] = useState<TimelineView>(() => {
    try {
      const chosen = localStorage.getItem(timelineKey);
      if (chosen === "matters" || chosen === "combined") return chosen;
    } catch { /* Use the previous setting if storage is unavailable. */ }
    return "combined";
  });

  function chooseView(next: TimelineView) {
    setView(next);
    try { localStorage.setItem(timelineKey, next); } catch { /* Window-local setting. */ }
  }
  useLayoutEffect(() => {
    if (!usePanelTabStore.getState().sessions[sessionId]) installLayout(sessionId);
  }, [sessionId]);

  const contents: Record<View, WorkspacePage["content"]> = {
    entries: <div className="time-workspace-entry-content" data-workspace-tab="entries">{entries}</div>,
    timeline: <section className="time-workspace-timeline" data-workspace-tab="timeline" tabIndex={-1} aria-label={t(labelKeys.timeline, locale)}>{timeline(view, chooseView)}</section>,
    chat: shown => <section className="time-workspace-chat" data-workspace-tab="chat">{chat(shown)}</section>,
  };
  const pages = viewSchema.options.map((id): WorkspacePage => {
    const Icon = icons[id];
    return { id: idFor(id), type: "workspace-page", label: t(labelKeys[id], locale), icon: <Icon />, content: contents[id] };
  });
  return <div className="time-workspace-panels">
    <SidePanel sessionId={sessionId} workspaceId={null} workspaceRoot="" client={null} visible={visible}
      pageCatalog={{ pages, resetLabel: t("timeWorkspace.reset"), onReset: () => { installLayout(sessionId); chooseView("combined"); } }} />
  </div>;
}
