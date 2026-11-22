import { useLayoutEffect, useState, type ReactNode } from "react";
import { CalendarDays, List, MessageSquare, ReceiptText } from "lucide-react";
import { BackOfficeSurface } from "./twenty-controls";
import { z } from "@legalwork/types/back-office";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { SidePanel, type WorkspacePage } from "../session/panel/side-panel";
import { usePanelTabStore } from "../session/panel/panel-tab-store";

const viewSchema = z.enum(["entries", "invoices", "timeline", "chat"]);
type View = z.infer<typeof viewSchema>;
export type TimelineView = "combined" | "matters";
const labelKeys = { entries: "timeWorkspace.entries", invoices: "back_office.invoices.plural", timeline: "timesheets.timeline", chat: "timeWorkspace.chat" } as const;
const icons = { entries: List, invoices: ReceiptText, timeline: CalendarDays, chat: MessageSquare };
const idFor = (view: View) => "timekeeping:" + view;
const tabFor = (view: View) => ({ type: "workspace-page" as const, id: idFor(view), label: t(labelKeys[view]) });

function initialLayout(withInvoices: boolean) {
  const left: View[] = withInvoices ? ["entries", "invoices"] : ["entries"];
  const right: View[] = ["timeline", "chat"];
  const tabs = [...left, ...right].map(tabFor);
  const pane = (id: string, views: View[], active: View | null) => ({
    id, tabIds: views.map(idFor), activeTabId: active && views.includes(active) ? idFor(active) : null,
  });
  return { tabs, panes: [pane("main", left, "entries"), pane("side", right, "timeline")],
    tree: { type: "split", id: "workday", direction: "horizontal", first: { type: "pane", id: "main" }, second: { type: "pane", id: "side" } },
    sizes: { workday: { main: 67, side: 33 } }, focusedPaneId: "main" };
}

function installLayout(sessionId: string, withInvoices: boolean) {
  const layout = usePanelTabStore.getState().readLayout(initialLayout(withInvoices));
  if (layout) usePanelTabStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: layout } }));
}

// Existing layouts retain their pane order, focused tab and sizes. Add the new
// default once so closing Invoices remains a persistent layout choice.
function prepareLayout(sessionId: string, withInvoices: boolean) {
  const store = usePanelTabStore.getState();
  const existing = store.sessions[sessionId];
  const invoice = tabFor("invoices");
  if (!existing) installLayout(sessionId, withInvoices);
  if (!withInvoices) {
    if (existing?.tabs.some(tab => tab.id === invoice.id)) store.closeTab(sessionId, invoice.id);
    return;
  }
  const migrationKey = sessionId + ":invoice-tab-added";
  try {
    if (localStorage.getItem(migrationKey)) return;
    localStorage.setItem(migrationKey, "1");
  } catch { return; }
  if (!existing || existing.tabs.some(tab => tab.id === invoice.id)) return;
  const entries = idFor("entries");
  const target = existing.panes.find(pane => pane.tabIds.includes(entries)) ?? existing.panes[0];
  if (!target) return;
  const ids = [...target.tabIds];
  const index = ids.indexOf(entries);
  ids.splice(index >= 0 ? index + 1 : ids.length, 0, invoice.id);
  const tabs = [...existing.tabs];
  const entriesIndex = tabs.findIndex(tab => tab.id === entries);
  tabs.splice(entriesIndex >= 0 ? entriesIndex + 1 : tabs.length, 0, invoice);
  const panes = existing.panes.map(pane => pane === target ? { ...pane, tabIds: ids, activeTabId: pane.activeTabId ?? invoice.id } : pane);
  usePanelTabStore.setState(state => ({ sessions: { ...state.sessions,
    [sessionId]: { ...existing, tabs, panes },
  } }));
}

function InvoicePane({ shown, children }: { shown: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(shown);
  useLayoutEffect(() => { if (shown) setVisited(true); }, [shown]);
  return shown || visited
    ? <section className="flex h-full min-h-0 min-w-0 flex-col overflow-auto" data-workspace-tab="invoices">{children}</section>
    : null;
}

export function TimeWorkspacePanels({ scope, entries, timeline, chat, invoices, requestedTab, visible = true }: {
  scope: string;
  entries: ReactNode;
  invoices?: ReactNode;
  requestedTab?: "entries" | "invoices";
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
  const withInvoices = invoices != null;
  useLayoutEffect(() => { prepareLayout(sessionId, withInvoices); }, [sessionId, withInvoices]);
  useLayoutEffect(() => {
    if (!requestedTab || (requestedTab === "invoices" && !withInvoices)) return;
    const store = usePanelTabStore.getState();
    const layout = store.sessions[sessionId];
    const tab = tabFor(requestedTab);
    if (layout?.tabs.some(item => item.id === tab.id)) store.selectTab(sessionId, tab.id);
    else store.openTab(sessionId, tab, layout?.panes.find(pane => pane.tabIds.includes(idFor("entries")))?.id ?? layout?.panes[0]?.id);
  }, [sessionId, requestedTab, withInvoices]);

  const contents: Record<View, WorkspacePage["content"]> = {
    entries: <BackOfficeSurface className="time-workspace-entry-content" data-workspace-tab="entries">{entries}</BackOfficeSurface>,
    invoices: shown => <InvoicePane shown={shown}>{invoices}</InvoicePane>,
    timeline: <section className="time-workspace-timeline" data-workspace-tab="timeline" tabIndex={-1} aria-label={t(labelKeys.timeline, locale)}>{timeline(view, chooseView)}</section>,
    chat: shown => <section className="time-workspace-chat" data-workspace-tab="chat">{chat(shown)}</section>,
  };
  const pages = viewSchema.options.filter(id => id !== "invoices" || withInvoices).map((id): WorkspacePage => {
    const Icon = icons[id];
    return { id: idFor(id), type: "workspace-page", label: t(labelKeys[id], locale), icon: <Icon />, content: contents[id] };
  });
  return <div className="time-workspace-panels">
    <SidePanel sessionId={sessionId} workspaceId={null} workspaceRoot="" client={null} visible={visible}
      pageCatalog={{ pages, resetLabel: t("timeWorkspace.reset"), onReset: () => { installLayout(sessionId, withInvoices); chooseView("combined"); } }} />
  </div>;
}
