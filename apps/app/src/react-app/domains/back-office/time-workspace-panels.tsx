import { useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { CalendarDays, List, MessageSquare, ReceiptText, ClipboardCheck, Loader2 } from "lucide-react";
import { BackOfficeSurface } from "./twenty-controls";
import { z } from "@legalwork/types/back-office";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { SidePanel, type PageCatalog, type WorkspacePage } from "../session/panel/side-panel";
import { EmbeddedWorkspaceChat } from "../session/chat/embedded-workspace-chat";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { usePanelTabStore, workspacePanelKey } from "../session/panel/panel-tab-store";
const viewSchema = z.enum(["entries", "invoices", "review", "timeline", "chat"]);
type View = z.infer<typeof viewSchema>;
export type TimelineView = "combined" | "matters";
const labelKeys = { entries: "timeWorkspace.entries", invoices: "back_office.invoices.plural", review: "back_office.billing.detail", timeline: "timesheets.timeline", chat: "timeWorkspace.chat" } as const;
const icons = { entries: List, invoices: ReceiptText, review: ClipboardCheck, timeline: CalendarDays, chat: MessageSquare };
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

function installLayout(sessionId: string, withInvoices: boolean, previousKey?: string) {
  const store = usePanelTabStore.getState();
  const current = store.sessions[sessionId];
  const layout = (previousKey && store.sessions[previousKey]) || store.readLayout(initialLayout(withInvoices));
  if (!layout) return;
  // Keep open editors, including unsaved documents, across reset and migration.
  const extra = (current?.tabs ?? []).filter(tab => tab.type !== "workspace-page" && !layout.tabs.some(item => item.id === tab.id));
  const target = layout.panes.find(pane => pane.tabIds.includes(idFor("chat"))) ?? layout.panes[0];
  const next = extra.length && target ? { ...layout, tabs: [...layout.tabs, ...extra], panes: layout.panes.map(pane => pane !== target ? pane : {
    ...pane, tabIds: [...pane.tabIds, ...extra.map(tab => tab.id)], activeTabId: pane.activeTabId ?? extra[0].id,
  }) } : layout;
  usePanelTabStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: next } }));
}

// Existing layouts retain their pane order, focused tab and sizes. Add the new
// default once so closing Invoices remains a persistent layout choice.
function prepareLayout(sessionId: string, withInvoices: boolean, legacyKey: string) {
  const store = usePanelTabStore.getState();
  const layoutKey = sessionId + ":workday-layout";
  const existingLayout = store.sessions[sessionId];
  if (sessionId !== legacyKey && (!existingLayout || (!existingLayout.tabs.some(tab => tab.type === "workspace-page") && !localStorage.getItem(layoutKey)))) {
    installLayout(sessionId, withInvoices, legacyKey);
    const previous = localStorage.getItem(legacyKey + ":invoice-tab-added");
    if (previous) localStorage.setItem(sessionId + ":invoice-tab-added", previous);
  }
  if (sessionId !== legacyKey) localStorage.setItem(layoutKey, "1");
  const existing = usePanelTabStore.getState().sessions[sessionId];
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

export function TimeWorkspacePanels({ scope, conversation, entries, timeline, chat, chatBusy, invoices, review, requestedTab, visible = true }: {
  scope: string;
  conversation?: Awaited<ReturnType<LegalworkServerClient["privateTimeConversation"]>>;
  entries: ReactNode;
  invoices?: ReactNode;
  review?: ReactNode;
  requestedTab?: "entries" | "invoices" | "review";
  timeline: (view: TimelineView, choose: (view: TimelineView) => void, expanded: boolean, toggleExpanded: () => void) => ReactNode;
  chat: (visible: boolean, sessionId?: string, active?: boolean) => ReactNode;
  chatBusy?: boolean;
  visible?: boolean;
}) {
  const host = useContext(EmbeddedWorkspaceChat);
  const projectId = conversation?.workspace.id;
  const connected = Boolean(projectId && host?.workspaceId === projectId);
  const legacyKey = "timekeeping:" + scope;
  const sessionId = projectId ? workspacePanelKey(projectId) : legacyKey;
  const locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  const workspaceTabs = usePanelTabStore(state => state.sessions[sessionId]?.tabs);
  const retiredTabs = workspaceTabs?.filter(tab => tab.id === "timekeeping:invoice-approval" || tab.id.startsWith("timekeeping:invoice-document:"));
  useLayoutEffect(() => {
    for (const tab of retiredTabs ?? []) usePanelTabStore.getState().closeTab(sessionId, tab.id);
  }, [sessionId, workspaceTabs]);
  const timelineId = idFor("timeline");
  const timelineFocused = usePanelTabStore(state => {
    const session = state.sessions[sessionId];
    return Boolean(session?.panes.some(pane => pane.id === session.focusedPaneId && pane.activeTabId === timelineId));
  });
  useLayoutEffect(() => {
    if (!visible || !timelineFocused) setExpanded(false);
  }, [visible, timelineFocused]);
  function toggleExpanded() {
    usePanelTabStore.getState().selectTab(sessionId, timelineId);
    setExpanded(value => !value);
  }
  const timelineKey = legacyKey + ":timeline";
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
  const withReview = review != null;
  useLayoutEffect(() => {
    prepareLayout(sessionId, withInvoices, legacyKey);
    if (withReview) return;
    const store = usePanelTabStore.getState();
    const reviewId = idFor("review");
    if (store.sessions[sessionId]?.tabs.some(tab => tab.id === reviewId)) store.closeTab(sessionId, reviewId);
  }, [sessionId, withInvoices, withReview, legacyKey]);
  useLayoutEffect(() => {
    if (!requestedTab || (requestedTab === "invoices" && !withInvoices) || (requestedTab === "review" && !withReview)) return;
    const store = usePanelTabStore.getState();
    const layout = store.sessions[sessionId];
    const tab = tabFor(requestedTab);
    if (layout?.tabs.some(item => item.id === tab.id)) store.selectTab(sessionId, tab.id);
    else store.openTab(sessionId, tab, layout?.panes.find(pane => pane.tabIds.includes(idFor("entries")))?.id ?? layout?.panes[0]?.id);
  }, [sessionId, requestedTab, withInvoices, withReview]);

  const contents: Record<View, WorkspacePage["content"]> = {
    entries: <BackOfficeSurface className="time-workspace-entry-content" data-workspace-tab="entries">{entries}</BackOfficeSurface>,
    invoices: shown => <InvoicePane shown={shown}>{invoices}</InvoicePane>,
    review: <BackOfficeSurface className="time-workspace-entry-content" data-workspace-tab="review">{review}</BackOfficeSurface>,
    timeline: <section className="time-workspace-timeline" data-workspace-tab="timeline" tabIndex={-1} aria-label={t(labelKeys.timeline, locale)}
      onKeyDown={event => {
        if (!expanded || event.key !== "Escape" || event.defaultPrevented ||
            event.currentTarget.querySelector('[role="dialog"][data-open], [aria-haspopup][aria-expanded="true"]')) return;
        event.stopPropagation();
        setExpanded(false);
      }}>{timeline(view, chooseView, expanded, toggleExpanded)}</section>,
    chat: shown => <section className="time-workspace-chat" data-workspace-tab="chat">{chat(shown)}</section>,
  };
  const pages = viewSchema.options.filter(id => (id !== "invoices" || withInvoices) && (id !== "review" || withReview)).map((id): WorkspacePage => {
    const Icon = icons[id];
    return { id: idFor(id), type: "workspace-page", label: t(labelKeys[id], locale), showInNewTab: id !== "chat", icon: id === "chat" && chatBusy ? <Loader2 className="animate-spin" aria-label={t("session.assistant_thinking")} /> : <Icon />, content: contents[id] };
  });
  const catalog: PageCatalog = { pages, renderChat: (id, active) => chat(visible, id, active), focusMode: expanded && timelineFocused, resetLabel: t("timeWorkspace.reset"),
    onReset: () => { installLayout(sessionId, withInvoices); chooseView("combined"); } };
  return <div className="time-workspace-panels">
    {connected && host && conversation ? host.renderPanel(catalog, visible, conversation.day.sessionId) :
      <SidePanel sessionId={legacyKey} workspaceId={null} workspaceRoot="" client={null} visible={visible} pageCatalog={catalog} />}
  </div>;
}
