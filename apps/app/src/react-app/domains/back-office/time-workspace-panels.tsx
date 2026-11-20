import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Columns2,
  List,
  MessageSquare,
  PanelRight,
  RotateCcw,
} from "lucide-react";
import { useGroupRef } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

const tabs = ["entries", "timeline", "chat"] as const;
const panes = ["left", "right"] as const;
type Tab = (typeof tabs)[number];
type Pane = (typeof panes)[number];
type View = Tab | "split";
type TabGroup = { tabs: Tab[]; active: Tab | null };
type Dock = Record<Pane, TabGroup>;
export type TimelineView = "combined" | "matters";

const tabLabels = {
  entries: "timeWorkspace.entries",
  timeline: "timesheets.timeline",
  chat: "timeWorkspace.chat",
} satisfies Record<Tab, string>;
const defaultLayout = { entries: 67, private: 33 };
type Preferences = {
  layout: typeof defaultLayout;
  view: View;
  timeline: TimelineView;
  dock: Dock;
};
const defaultPreferences: Preferences = {
  layout: defaultLayout,
  view: "split",
  timeline: "combined",
  dock: {
    left: { tabs: ["entries"], active: "entries" },
    right: { tabs: ["timeline", "chat"], active: "timeline" },
  },
};
const views = [
  { id: "split", label: "timeWorkspace.split", icon: Columns2 },
  { id: "entries", label: tabLabels.entries, icon: List },
  { id: "timeline", label: tabLabels.timeline, icon: PanelRight },
  { id: "chat", label: tabLabels.chat, icon: MessageSquare },
] satisfies { id: View; label: string; icon: typeof List }[];
const tabMime = "application/x-legalwork-time-tab";

function isTab(value: unknown): value is Tab {
  return tabs.some((tab) => tab === value);
}
function readTabGroup(value: unknown): TabGroup | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("tabs" in value) ||
    !Array.isArray(value.tabs)
  )
    return;
  const chosen = value.tabs.filter(isTab);
  return {
    tabs: chosen,
    active:
      "active" in value && isTab(value.active) && chosen.includes(value.active)
        ? value.active
        : (chosen[0] ?? null),
  };
}
function readDock(value: unknown): Dock {
  if (
    !value ||
    typeof value !== "object" ||
    !("left" in value) ||
    !("right" in value)
  )
    return defaultPreferences.dock;
  const left = readTabGroup(value.left),
    right = readTabGroup(value.right);
  if (!left || !right) return defaultPreferences.dock;
  const all = [...left.tabs, ...right.tabs];
  return all.length === tabs.length && new Set(all).size === tabs.length
    ? { left, right }
    : defaultPreferences.dock;
}
function readPreferences(key: string): Preferences {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!saved || typeof saved !== "object") return defaultPreferences;
    const view = "view" in saved && isTab(saved.view) ? saved.view : "split";
    const timeline =
      "timeline" in saved && saved.timeline === "matters"
        ? "matters"
        : "combined";
    const layout = "layout" in saved ? saved.layout : null;
    const left =
      layout && typeof layout === "object" && "entries" in layout
        ? layout.entries
        : null;
    return {
      view,
      timeline,
      dock: readDock("dock" in saved ? saved.dock : undefined),
      layout:
        typeof left === "number" && left >= 35 && left <= 75
          ? { entries: left, private: 100 - left }
          : defaultLayout,
    };
  } catch {
    return defaultPreferences;
  }
}

function paneOf(dock: Dock, tab: Tab): Pane {
  return dock.left.tabs.includes(tab) ? "left" : "right";
}
function changeDock(dock: Dock, tab: Tab, to: Pane, before?: Tab): Dock {
  if (before === tab) return dock;
  const from = paneOf(dock, tab);
  if (from === to && !before && dock[to].tabs.at(-1) === tab) return dock;
  const source = dock[from];
  const fromTabs = source.tabs.filter((item) => item !== tab);
  const toTabs = from === to ? fromTabs : [...dock[to].tabs];
  const position = before ? toTabs.indexOf(before) : -1;
  toTabs.splice(position < 0 ? toTabs.length : position, 0, tab);
  const docked = {
    ...dock,
    [from]: {
      tabs: fromTabs,
      active:
        source.active === tab
          ? (fromTabs[
              Math.min(source.tabs.indexOf(tab), fromTabs.length - 1)
            ] ?? null)
          : source.active,
    },
    [to]: { tabs: toTabs, active: tab },
  };
  return docked;
}

export function TimeWorkspacePanels({
  scope,
  entries,
  timeline,
  chat,
}: {
  scope: string;
  entries: ReactNode;
  timeline: (
    view: TimelineView,
    choose: (view: TimelineView) => void,
  ) => ReactNode;
  chat: ReactNode;
}) {
  const key = "legalwork.time-workspace:" + scope;
  const id = useId();
  const locale = useLocale();
  const [preferences, setPreferences] = useState(() => readPreferences(key));
  const [narrow, setNarrow] = useState(false);
  const [dropPane, setDropPane] = useState<Pane>();
  const [dockNotice, setDockNotice] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const group = useGroupRef();
  const targets = useRef<Record<Pane, HTMLDivElement | null>>({
    left: null,
    right: null,
  });
  const [hosts] = useState(() => ({
    entries: document.createElement("div"),
    timeline: document.createElement("div"),
    chat: document.createElement("div"),
  }));
  const dragging = useRef<Tab>(undefined);
  const focusNext = useRef<Tab>(undefined);
  const { dock } = preferences;
  const view =
    narrow && preferences.view === "split" ? "entries" : preferences.view;
  const activePane = view === "split" ? undefined : paneOf(dock, view);

  useLayoutEffect(() => {
    if (!root.current) return;
    const element = root.current;
    const resize = () => {
      if (element.offsetWidth > 0) setNarrow(element.offsetWidth < 780);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    // Keep each editor's portal mounted, including when the tab moves.
    // Reparenting the host preserves uncontrolled fields and in-progress work.
    for (const tab of tabs) {
      const pane = paneOf(dock, tab);
      const host = hosts[tab];
      const target = targets.current[pane];
      host.id = id + "-content-" + tab;
      host.dataset.workspaceTab = tab;
      host.className = "time-workspace-tab-content";
      host.hidden = view === "split" ? dock[pane].active !== tab : view !== tab;
      host.setAttribute("role", view === "split" ? "tabpanel" : "region");
      host.setAttribute("aria-label", t(tabLabels[tab], locale));
      if (target && host.parentElement !== target) target.appendChild(host);
    }
    if (focusNext.current && view === "split") {
      document.getElementById(id + "-tab-" + focusNext.current)?.focus();
      focusNext.current = undefined;
    }
  }, [dock, hosts, id, locale, view]);

  function update(patch: Partial<Preferences>) {
    setPreferences((previous) => {
      const next = { ...previous, ...patch };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Layout still applies to this window. */
      }
      return next;
    });
  }
  function activate(pane: Pane, tab: Tab, focus = false) {
    if (focus) document.getElementById(id + "-tab-" + tab)?.focus();
    if (dock[pane].active !== tab)
      update({ dock: { ...dock, [pane]: { ...dock[pane], active: tab } } });
  }
  function move(tab: Tab, pane: Pane, before?: Tab, focus = false) {
    const next = changeDock(dock, tab, pane, before);
    if (next === dock) return;
    if (focus) focusNext.current = tab;
    update({ dock: next });
  }
  function reorder(pane: Pane, tab: Tab, direction: -1 | 1) {
    const items = dock[pane].tabs;
    const next = items.indexOf(tab) + direction;
    if (next < 0 || next >= items.length) return;
    move(tab, pane, items[next + (direction === 1 ? 1 : 0)], true);
    setDockNotice(t("timeWorkspace.tabPosition", {
      tab: t(tabLabels[tab]), position: next + 1, total: items.length,
    }));
  }
  function internalDrag(event: DragEvent) {
    return dragging.current && event.dataTransfer.types.includes(tabMime);
  }
  function drop(event: DragEvent, pane: Pane, before?: Tab) {
    if (view !== "split" || !internalDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const tab = event.dataTransfer.getData(tabMime);
    if (isTab(tab) && tab === dragging.current) move(tab, pane, before);
    dragging.current = undefined;
    setDropPane(undefined);
  }

  function renderPane(pane: Pane) {
    const { tabs, active } = dock[pane];
    const activeIndex = active ? tabs.indexOf(active) : -1;
    const other = pane === "left" ? "right" : "left";
    const Arrow = pane === "left" ? ArrowRight : ArrowLeft;
    const moveLabel =
      active &&
      t(
        pane === "left" ? "timeWorkspace.moveRight" : "timeWorkspace.moveLeft",
        { tab: t(tabLabels[active]) },
      );
    return (
      <div
        className="time-workspace-dock"
        data-pane={pane}
        data-drop-target={dropPane === pane || undefined}
        onDragOver={(event) => {
          if (view !== "split" || !internalDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropPane(pane);
        }}
        onDragLeave={(event) => {
          if (!(
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ))
            setDropPane((current) => (current === pane ? undefined : current));
        }}
        onDrop={(event) => drop(event, pane)}
      >
        {view === "split" && (
          <div className="time-workspace-dock-bar">
            {tabs.length > 0 ? (
              <div
                className="time-workspace-dock-tabs"
                role="tablist"
                aria-label={t(
                  pane === "left"
                    ? "timeWorkspace.leftPane"
                    : "timeWorkspace.rightPane",
                )}
              >
                {tabs.map((tab, index) => (
                  <Button
                    key={tab}
                    id={id + "-tab-" + tab}
                    role="tab"
                    variant={active === tab ? "secondary" : "ghost"}
                    size="xs"
                    aria-selected={active === tab}
                    aria-keyshortcuts={tabs.length > 1 ? "Shift+ArrowLeft Shift+ArrowRight" : undefined}
                    tabIndex={active === tab ? 0 : -1}
                    aria-controls={id + "-content-" + tab}
                    draggable
                    onClick={() => activate(pane, tab)}
                    onKeyDown={(event) => {
                      if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                        event.preventDefault();
                        reorder(pane, tab, event.key === "ArrowLeft" ? -1 : 1);
                        return;
                      }
                      const next =
                        event.key === "ArrowLeft"
                          ? tabs[(index - 1 + tabs.length) % tabs.length]
                          : event.key === "ArrowRight"
                            ? tabs[(index + 1) % tabs.length]
                            : event.key === "Home"
                              ? tabs[0]
                              : event.key === "End"
                                ? tabs[tabs.length - 1]
                                : undefined;
                      if (!next) return;
                      event.preventDefault();
                      activate(pane, next, true);
                    }}
                    onDragStart={(event) => {
                      dragging.current = tab;
                      event.dataTransfer.setData(tabMime, tab);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      dragging.current = undefined;
                      setDropPane(undefined);
                    }}
                    onDrop={(event) => drop(event, pane, tab)}
                  >
                    {t(tabLabels[tab])}
                  </Button>
                ))}
              </div>
            ) : (
              <span className="time-workspace-dock-empty">
                {t("timeWorkspace.dropTab")}
              </span>
            )}
            {active && (
              <div className="time-workspace-dock-actions">
                {tabs.length > 1 && ([-1, 1] as const).map(direction => {
                  const label = t(direction === -1 ? "timeWorkspace.moveEarlier" : "timeWorkspace.moveLater", { tab: t(tabLabels[active]) });
                  const Chevron = direction === -1 ? ChevronLeft : ChevronRight;
                  return <Button key={direction} type="button" size="icon-xs" variant="ghost"
                    aria-label={label} title={label} disabled={activeIndex + direction < 0 || activeIndex + direction >= tabs.length}
                    onClick={() => reorder(pane, active, direction)}>
                    <Chevron size={13} />
                  </Button>;
                })}
                <Button type="button" size="icon-xs" variant="ghost"
                  aria-label={moveLabel || undefined} title={moveLabel || undefined}
                  onClick={() => move(active, other, undefined, true)}>
                  <Arrow size={13} />
                </Button>
              </div>
            )}
          </div>
        )}
        <div
          className="time-workspace-dock-content"
          ref={(element) => {
            targets.current[pane] = element;
          }}
        />
      </div>
    );
  }

  return (
    <div className="time-workspace-panels" ref={root}>
      <span className="sr-only" role="status">{dockNotice}</span>
      <div
        className="time-workspace-views"
        role="group"
        aria-label={t("timeWorkspace.views")}
      >
        {views
          .filter((control) => !narrow || control.id !== "split")
          .map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              size="sm"
              variant={view === id ? "secondary" : "ghost"}
              aria-pressed={view === id}
              onClick={() => update({ view: id })}
            >
              <Icon size={14} />
              {t(label)}
            </Button>
          ))}
        <Button
          size="icon-sm"
          variant="ghost"
          className="time-workspace-reset"
          title={t("timeWorkspace.reset")}
          aria-label={t("timeWorkspace.reset")}
          onClick={() => {
            group.current?.setLayout(defaultLayout);
            update(defaultPreferences);
          }}
        >
          <RotateCcw size={14} />
        </Button>
      </div>
      <ResizablePanelGroup
        className="time-workspace-group"
        data-view={view}
        data-active-pane={activePane}
        groupRef={group}
        defaultLayout={preferences.layout}
        orientation="horizontal"
        disabled={view !== "split"}
        onLayoutChanged={(layout) => {
          if (
            layout.entries >= 35 &&
            layout.private >= 25 &&
            Math.abs(layout.entries - preferences.layout.entries) > 0.1
          )
            update({
              layout: { entries: layout.entries, private: layout.private },
            });
        }}
      >
        <ResizablePanel
          id="entries"
          className="time-workspace-pane"
          minSize="35%"
        >
          {renderPane("left")}
        </ResizablePanel>
        <ResizableHandle withHandle aria-label={t("timeWorkspace.resize")} />
        <ResizablePanel
          id="private"
          className="time-workspace-pane"
          minSize="25%"
        >
          {renderPane("right")}
        </ResizablePanel>
      </ResizablePanelGroup>
      {createPortal(
        <div className="time-workspace-entry-content">{entries}</div>,
        hosts.entries,
      )}
      {createPortal(
        <section className="time-workspace-timeline">
          {timeline(preferences.timeline, (timeline) => update({ timeline }))}
        </section>,
        hosts.timeline,
      )}
      {createPortal(
        <section className="time-workspace-chat">{chat}</section>,
        hosts.chat,
      )}
    </div>
  );
}
