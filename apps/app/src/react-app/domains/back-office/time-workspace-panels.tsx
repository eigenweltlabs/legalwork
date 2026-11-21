import { useLayoutEffect, useState, type ReactNode } from "react";
import { CalendarDays, List, MessageSquare } from "lucide-react";
import { z } from "@legalwork/types/back-office";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { SidePanel, type WorkspacePage } from "../session/panel/side-panel";
import { usePanelTabStore } from "../session/panel/panel-tab-store";

const viewSchema = z.enum(["entries", "timeline", "chat"]);
type View = z.infer<typeof viewSchema>;
const groupSchema = z.object({ tabs: z.array(viewSchema), active: viewSchema.nullable() });
const legacySchema = z.object({
  view: z.union([viewSchema, z.literal("split")]).optional(),
  dock: z.object({ left: groupSchema, right: groupSchema }).optional(),
  layout: z.object({ entries: z.number().min(35).max(75) }).optional(),
  timeline: z.enum(["combined", "matters"]).optional(),
});
export type TimelineView = "combined" | "matters";
const labelKeys = { entries: "timeWorkspace.entries", timeline: "timesheets.timeline", chat: "timeWorkspace.chat" } as const;
const icons = { entries: List, timeline: CalendarDays, chat: MessageSquare };
const defaultGroups = {
  left: { tabs: ["entries"], active: "entries" },
  right: { tabs: ["timeline", "chat"], active: "timeline" },
} satisfies Record<string, z.infer<typeof groupSchema>>;
const idFor = (view: View) => "timekeeping:" + view;

function previousLayout(scope: string) {
  try {
    return legacySchema.safeParse(JSON.parse(localStorage.getItem("legalwork.time-workspace:" + scope) ?? "null")).data;
  } catch { return undefined; }
}

function initialLayout(saved?: z.infer<typeof legacySchema>) {
  const dock = saved?.dock ?? defaultGroups;
  const all = [...dock.left.tabs, ...dock.right.tabs];
  const groups = new Set(all).size === 3 && all.length === 3 ? dock : defaultGroups;
  const order = [...groups.left.tabs, ...groups.right.tabs];
  const tabs = order.map(view => ({ type: "workspace-page", id: idFor(view), label: t(labelKeys[view]) }));
  const pane = (id: string, views: View[], active: View | null) => ({
    id, tabIds: views.map(idFor), activeTabId: active && views.includes(active) ? idFor(active) : null,
  });
  if (saved?.view && saved.view !== "split")
    return { tabs, panes: [pane("main", order, saved.view)], focusedPaneId: "main" };
  const left = saved?.layout?.entries ?? 67;
  return { tabs, panes: [pane("main", groups.left.tabs, groups.left.active), pane("side", groups.right.tabs, groups.right.active)],
    tree: { type: "split", id: "workday", direction: "horizontal", first: { type: "pane", id: "main" }, second: { type: "pane", id: "side" } },
    sizes: { workday: { main: left, side: 100 - left } }, focusedPaneId: "main" };
}

function installLayout(sessionId: string, saved?: z.infer<typeof legacySchema>) {
  const layout = usePanelTabStore.getState().readLayout(initialLayout(saved));
  if (layout) usePanelTabStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: layout } }));
}

export function TimeWorkspacePanels({ scope, entries, timeline, chat, visible = true }: {
  scope: string;
  entries: ReactNode;
  timeline: (view: TimelineView, choose: (view: TimelineView) => void) => ReactNode;
  chat: ReactNode;
  visible?: boolean;
}) {
  const sessionId = "timekeeping:" + scope;
  const locale = useLocale();
  const [legacy] = useState(() => previousLayout(scope));
  const timelineKey = sessionId + ":timeline";
  const [view, setView] = useState<TimelineView>(() => {
    try {
      const chosen = localStorage.getItem(timelineKey);
      if (chosen === "matters" || chosen === "combined") return chosen;
    } catch { /* Use the previous setting if storage is unavailable. */ }
    return legacy?.timeline ?? "combined";
  });

  function chooseView(next: TimelineView) {
    setView(next);
    try { localStorage.setItem(timelineKey, next); } catch { /* Window-local setting. */ }
  }
  useLayoutEffect(() => {
    if (!usePanelTabStore.getState().sessions[sessionId]) installLayout(sessionId, legacy);
  }, [sessionId, legacy]);

  const contents: Record<View, ReactNode> = {
    entries: <div className="time-workspace-entry-content" data-workspace-tab="entries">{entries}</div>,
    timeline: <section className="time-workspace-timeline" data-workspace-tab="timeline" tabIndex={-1} aria-label={t(labelKeys.timeline, locale)}>{timeline(view, chooseView)}</section>,
    chat: <section className="time-workspace-chat" data-workspace-tab="chat">{chat}</section>,
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
