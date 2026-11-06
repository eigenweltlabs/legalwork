import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, Globe, X } from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { usePanelTabStore, workspacePanelKey } from "../panel/panel-tab-store";
import { DocumentMiniPreview, useDocumentRuntime } from "../artifacts/document-runtime";
import { assistantBrowserWorkerIds, useTaskBrowserTabs, visibleTaskBrowserTabs } from "./task-browser-tabs";
import { openBackgroundTab } from "./open-background-tab";
import { magneticTabDock, tabThrowVelocity, type TabDock } from "./magnetic-tab-dock";
import { useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { emptyInteractionSessions, interactionSessionsKey, type InteractionSessions } from "../sync/interaction-state";
import { useSessionActivityStore, type SessionActivityStatus } from "../status/session-activity-store";
import type { Client } from "@/app/types";

const subscribeEmpty = () => () => {};
const emptyStatuses: Record<string, SessionActivityStatus> = {};
const zero = () => 0;
const cardWidth = 220;
const cardHeight = 143;
const cardGap = 12;
const chatDocks = new Map<string, TabDock>();

type MiniTab = { id: string; label: string; preview: ReactNode; open: () => void; openOnClick?: boolean; close: () => void };

function BrowserMiniPreview({ id }: { id: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await window.__LEGALWORK_ELECTRON__?.browser?.previewTab?.(id);
        if (!cancelled && value) setImage(value);
      } catch { /* Navigation can temporarily make a preview unavailable. */ }
      if (!cancelled) timer = setTimeout(refresh, 2500);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id]);
  return image ? <img src={image} alt="" className="h-full w-full object-cover object-top" />
    : <div className="flex h-full items-center justify-center bg-gray-2"><Globe className="size-8 text-gray-7" /></div>;
}

function MiniCard({ tab, toggle, onSurfaceClick, onPointerDown, expanded, count, depth, columns, dock }: {
  tab: MiniTab; toggle: () => void; onSurfaceClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  expanded: boolean; count: number; depth: number; columns: number; dock: TabDock;
}) {
  const covered = !expanded && depth > 0;
  const stackDepth = Math.min(depth, 2);
  const horizontal = dock.horizontal === "right" ? -1 : 1;
  const vertical = dock.vertical === "bottom" ? -1 : 1;
  return <div
    className={`absolute isolate overflow-hidden rounded-lg bg-white transition-[transform,opacity] duration-[90ms] ease-out will-change-transform motion-reduce:transition-none ${covered ? "shadow-[0_0_0_1px_rgb(0_0_0/0.05)]" : "shadow-[0_10px_28px_-8px_rgb(0_0_0/0.18),0_2px_8px_-2px_rgb(0_0_0/0.06),0_0_0_1px_rgb(0_0_0/0.04)]"}`}
    style={{
      width: cardWidth, height: cardHeight, zIndex: count - depth,
      [dock.horizontal]: 12, [dock.vertical]: 12,
      pointerEvents: covered ? "none" : "auto",
      opacity: !expanded && depth > 2 ? 0 : 1,
      transformOrigin: `${dock.horizontal} ${dock.vertical}`,
      transform: expanded
        ? `translate(${horizontal * (depth % columns) * (cardWidth + cardGap)}px, ${vertical * Math.floor(depth / columns) * (cardHeight + cardGap)}px)`
        : `translate(${horizontal * stackDepth * 6}px, ${vertical * stackDepth * 5}px) rotate(${horizontal * vertical * stackDepth * 2}deg) scale(${1 - stackDepth * 0.025})`,
    }}
    inert={covered}
    aria-hidden={covered || undefined}
    data-background-tab={tab.id}
  >
    {tab.preview}
    <button type="button" className="absolute inset-0 touch-none cursor-grab rounded-lg active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-blue-8"
      onPointerDown={onPointerDown} onClick={onSurfaceClick}
      title={tab.label} aria-label={tab.openOnClick ? t("background_tabs.open", { name: tab.label }) : t("background_tabs.toggle")} aria-expanded={tab.openOnClick ? undefined : expanded} />
    <div className="absolute left-1.5 top-1.5 flex gap-0.5 rounded-full bg-white/90 p-0.5 shadow-sm">
      <Button variant="ghost" size="icon" className="size-5 rounded-full text-black/60 hover:bg-black/10 hover:text-black" aria-label={t("background_tabs.close", { name: tab.label })} title={t("background_tabs.close", { name: tab.label })} onClick={tab.close}><X className="size-3.5" /></Button>
      <Button variant="ghost" size="icon" className="size-5 rounded-full text-black/60 hover:bg-black/10 hover:text-black" aria-label={t("background_tabs.open", { name: tab.label })} title={t("background_tabs.open", { name: tab.label })} onClick={tab.open}><ArrowUpRight className="size-3.5" /></Button>
    </div>
    {depth === 0 && count > 1 && <button type="button" className="absolute right-1.5 top-1.5 flex h-6 items-center gap-0.5 rounded-full bg-white/90 px-1.5 text-[10px] font-medium text-black/80 shadow-sm hover:bg-white" onClick={toggle} aria-expanded={expanded} aria-label={t("background_tabs.count", { count })}>
      {count}<ChevronDown className={`size-3 ${expanded ? "rotate-180" : ""}`} />
    </button>}
  </div>;
}

/** Only this lightweight overlay updates during interaction; editor hosts remain mounted. */
function FloatingTabStack({ tabs, sessionId }: { tabs: MiniTab[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [dock, setDock] = useState<TabDock>(() => chatDocks.get(sessionId) ?? { horizontal: "right", vertical: "top" });
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [group, setGroup] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scroll = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const disposeDrag = useRef(() => {});
  const pendingSnap = useRef<{ left: number; top: number; vx: number; vy: number } | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const columns = Math.max(1, Math.min(3, Math.floor((size.width - 32 + cardGap) / (cardWidth + cardGap))));
  const visibleColumns = expanded ? Math.min(columns, tabs.length) : 1;
  const rows = expanded ? Math.ceil(tabs.length / columns) : 1;
  const width = visibleColumns * (cardWidth + cardGap) - cardGap + 24;
  const contentHeight = rows * (cardHeight + cardGap) - cardGap + 24;
  const height = Math.min(contentHeight, Math.max(cardHeight + 24, size.height - 8));

  useLayoutEffect(() => {
    if (!container) return;
    const resize = () => setSize(previous => previous.width === container.clientWidth && previous.height === container.clientHeight
      ? previous : { width: container.clientWidth, height: container.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  const animateHome = (vx: number, vy: number) => {
    if (reducedMotion) { x.set(0); y.set(0); return; }
    const velocity = (value: number) => Math.max(-2400, Math.min(2400, value));
    void animate(x, 0, { type: "spring", stiffness: 360, damping: 38, velocity: velocity(vx), restDelta: 0.5 });
    void animate(y, 0, { type: "spring", stiffness: 360, damping: 38, velocity: velocity(vy), restDelta: 0.5 });
  };
  const settle = () => {
    const pending = pendingSnap.current;
    if (!pending || !container || !group) return;
    pendingSnap.current = null;
    const bounds = group.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(group).transform);
    // Changing the CSS dock must not teleport the group before its spring starts.
    x.set(pending.left - (bounds.left - viewport.left - transform.m41));
    y.set(pending.top - (bounds.top - viewport.top - transform.m42));
    animateHome(pending.vx, pending.vy);
  };
  useLayoutEffect(settle, [dock.horizontal, dock.vertical, expanded, width, height, container, group]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = dock.vertical === "bottom" ? contentHeight - height : 0;
  }, [dock.vertical, expanded, contentHeight, height]);
  useEffect(() => () => { disposeDrag.current(); x.stop(); y.stop(); }, [x, y]);

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || !container || !group) return;
    disposeDrag.current();
    x.stop(); y.stop();
    pendingSnap.current = null;
    dragged.current = false;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY, offsetX: x.get(), offsetY: y.get() };
    const samples = [{ x: event.clientX, y: event.clientY, time: event.timeStamp }];
    target.setPointerCapture(pointerId);
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      if (!dragged.current && Math.hypot(dx, dy) < 4) return;
      dragged.current = true;
      samples.push({ x: next.clientX, y: next.clientY, time: next.timeStamp });
      while (samples.length > 2 && samples[1].time < next.timeStamp - 80) samples.shift();
      x.set(start.offsetX + dx); y.set(start.offsetY + dy);
    };
    const finish = (cancelled: boolean, time: number) => {
      disposeDrag.current();
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      if (!dragged.current) { animateHome(0, 0); return; }
      const viewport = container.getBoundingClientRect();
      const bounds = group.getBoundingClientRect();
      const transform = new DOMMatrixReadOnly(getComputedStyle(group).transform);
      const dx = x.get() - transform.m41;
      const dy = y.get() - transform.m42;
      const front = group.querySelector<HTMLElement>("[data-background-tab]:last-child");
      if (!front) return;
      const velocity = cancelled ? { x: 0, y: 0 } : tabThrowVelocity(samples, time);
      const next = !cancelled ? magneticTabDock(
        { x: bounds.left - viewport.left + dx + bounds.width / 2, y: bounds.top - viewport.top + dy + bounds.height / 2 },
        { width: viewport.width, height: viewport.height }, velocity,
      ) : dock;
      const frontBounds = front.getBoundingClientRect();
      pendingSnap.current = { left: frontBounds.left - viewport.left + dx - 12, top: frontBounds.top - viewport.top + dy - 12, vx: velocity.x, vy: velocity.y };
      setExpanded(false);
      chatDocks.set(sessionId, next);
      setDock(next);
      if (!expanded && next.horizontal === dock.horizontal && next.vertical === dock.vertical) settle();
    };
    const up = (next: globalThis.PointerEvent) => { if (next.pointerId === pointerId) finish(false, next.timeStamp); };
    const cancel = (next: globalThis.PointerEvent) => { if (next.pointerId === pointerId) finish(true, next.timeStamp); };
    const blur = () => finish(true, performance.now());
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    disposeDrag.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
    };
  };
  const toggle = () => setExpanded(value => !value);
  const onSurfaceClick = (event: MouseEvent<HTMLButtonElement>, tab: MiniTab) => {
    if (!dragged.current || event.detail === 0) { if (tab.openOnClick) tab.open(); else toggle(); }
  };
  return <section ref={setContainer} className="pointer-events-none absolute inset-0 z-20" aria-label={t("background_tabs.label")}>
    <motion.div ref={setGroup} className="absolute will-change-transform" style={{ x, y, width, height, [dock.horizontal]: 4, [dock.vertical]: 4 }}
      data-background-tab-group={`${dock.vertical}-${dock.horizontal}`}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setExpanded(false); } }}
    >
      <div ref={scroll} className={contentHeight > height ? "h-full overflow-y-auto overscroll-contain" : "h-full"}>
        <div className="relative" style={{ height: contentHeight }}>
          {tabs.map((tab, index) => <MiniCard key={tab.id} tab={tab} toggle={toggle} onSurfaceClick={event => onSurfaceClick(event, tab)} onPointerDown={startDrag}
            expanded={expanded} count={tabs.length} depth={tabs.length - 1 - index} columns={columns} dock={dock} />)}
        </div>
      </div>
    </motion.div>
  </section>;
}

export function BackgroundTabStack({ sessionId, workspaceId, client, assistantChat = false }: { sessionId: string; workspaceId: string; client: Client; assistantChat?: boolean }) {
  const runtime = useDocumentRuntime();
  useSyncExternalStore(runtime?.subscribe ?? subscribeEmpty, runtime?.version ?? zero);
  const panels = usePanelTabStore(state => state.sessions);
  const browsers = useTaskBrowserTabs(state => state.tabs);
  const statuses = useSessionActivityStore(state => state.statusesByWorkspaceId[workspaceId] ?? emptyStatuses);
  const sessions = useQueryCacheState<InteractionSessions>(interactionSessionsKey(workspaceId), emptyInteractionSessions);
  const owners = [...new Set(browsers.flatMap(tab => tab.background && !tab.dismissed && tab.taskSessionId ? [tab.taskSessionId] : []))].sort();
  // Browser state updates repeatedly during navigation. Cache by owner IDs so
  // those updates cannot cancel discovery before the parent tile appears.
  const workers = useQuery({
    queryKey: ["assistant-browser-workers", workspaceId, sessionId, owners],
    enabled: assistantChat && owners.length > 0,
    queryFn: () => assistantBrowserWorkerIds(id => client.session.get({ sessionID: id }), sessionId, owners),
    staleTime: 30_000,
  });
  const tabs: MiniTab[] = [];
  for (const entry of runtime?.entries.values() ?? []) {
    if (!entry.tasks.has(sessionId) || entry.dismissed.has(sessionId)) continue;
    if (panels[entry.props.sessionId]?.tabs.some(tab => tab.id === entry.props.tab.id)) continue;
    tabs.push({ id: entry.key, label: entry.props.tab.label,
      preview: <DocumentMiniPreview entry={entry} />, open: () => openBackgroundTab(entry.props.sessionId, sessionId, entry.props.tab), close: () => runtime?.dismiss(entry, sessionId) });
  }
  for (const tab of visibleTaskBrowserTabs(browsers, sessionId, assistantChat, sessions, workers.data, statuses)) {
    tabs.push({ id: tab.id, label: tab.label, openOnClick: true, preview: <BrowserMiniPreview id={tab.id} />,
      open: () => openBackgroundTab(workspacePanelKey(workspaceId), sessionId, { ...tab, background: false }),
      close: () => { void window.__LEGALWORK_ELECTRON__?.browser?.dismissTab?.(tab.id); } });
  }
  return tabs.length ? <FloatingTabStack tabs={tabs} sessionId={sessionId} /> : null;
}
