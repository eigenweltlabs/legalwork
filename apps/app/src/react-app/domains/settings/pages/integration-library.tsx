import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Download, Info, ListFilter, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Share2, Trash2, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SectionHeading, IconTile } from "@/react-app/design-system/surface";
import { t } from "@/i18n";
import type { ImportedPlugin } from "@/app/lib/extension-imports";
import type { ConnectorState } from "./connector-status";

/** The page owns toolbar positions; each library keeps its own actions and search state. */
export type IntegrationLibrarySource = "all" | "personal" | "team";
export type IntegrationLibraryKind = "connector" | "skill" | "storage";
export type IntegrationAddRequest = { kind: IntegrationLibraryKind; id: number };
export const IntegrationLibraryLayoutContext = createContext<{ actions: HTMLElement | null; search: HTMLElement | null; leadingActions?: HTMLElement | null; directoryRequest?: number; directoryActions?: ReactNode; customPluginOpen?: boolean; pluginSearch?: string; onRefresh?: () => void; revision?: number; source?: IntegrationLibrarySource; addRequest?: IntegrationAddRequest | null; onAddHandled?: () => void; connectorToOpen?: string | null; onConnectorOpened?: () => void; ownsMoreMenu?: boolean; importedPackages?: readonly ImportedPlugin[]; connectorState?: (name: string) => ConnectorState | undefined } | null>(null);
/** Embedded team catalogues follow their library's search. */
export const IntegrationLibrarySearchContext = createContext({ query: "", hasOtherResults: false });

/** Use the same pane-relative content column and gutters as Tasks. */
export function IntegrationLibraryPage({ children }: { children: ReactNode }) {
  return <div className="@container/page flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
    <div className="lw-page-content lw-page-top flex min-h-0 flex-1 flex-col overflow-hidden pb-8">{children}</div>
  </div>;
}

export function useIntegrationLibraryLayout() {
  return useContext(IntegrationLibraryLayoutContext);
}

/** The shared Add menu opens the selected library before its existing form. */
export function useIntegrationAddRequest(kind: IntegrationLibraryKind, onAdd: () => void | Promise<void>) {
  const layout = useIntegrationLibraryLayout();
  const handled = useRef<number | null>(null);
  useEffect(() => {
    const request = layout?.addRequest;
    if (!request || request.kind !== kind || handled.current === request.id) return;
    handled.current = request.id;
    layout.onAddHandled?.();
    void onAdd();
  }, [kind, layout?.addRequest, layout?.onAddHandled, onAdd]);
  return Boolean(layout?.onAddHandled);
}

export function IntegrationLibraryActions({ children }: { children: ReactNode }) {
  const layout = useIntegrationLibraryLayout();
  if (layout) return layout.actions ? createPortal(children, layout.actions) : null;
  return children;
}

export type IntegrationAddAction = { label: string; onClick: () => void | Promise<void>; icon: LucideIcon; disabled?: boolean };

export function IntegrationSourceFilter(props: { value: IntegrationLibrarySource; onChange: (source: IntegrationLibrarySource) => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="outline" size="sm" title={t("integrations.filter_source")} />}>
      <ListFilter className="size-3.5" />{props.value === "all" ? t("integrations.filter") : props.value === "personal" ? t("integrations.source_personal") : t("firm_hub.scope_team")}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuRadioGroup aria-label={t("integrations.filter_source")} value={props.value} onValueChange={value => { if (value === "all" || value === "personal" || value === "team") props.onChange(value); }}>
        <DropdownMenuRadioItem value="all" closeOnClick>{t("integrations.all_sources")}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="personal" closeOnClick>{t("integrations.source_personal")}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="team" closeOnClick>{t("firm_hub.scope_team")}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function IntegrationAddMenu(props: { actions: IntegrationAddAction[]; disabled?: boolean; triggerRef?: RefObject<HTMLButtonElement | null>; label?: string; size?: "default" | "sm" }) {
  const [only] = props.actions;
  if (props.actions.length === 1 && only) return <Button ref={props.triggerRef} size={props.size ?? "sm"} disabled={props.disabled || only.disabled} onClick={only.onClick} title={only.label}><Plus className="size-3.5" />{props.label ?? t("common.add")}</Button>;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button ref={props.triggerRef} size={props.size ?? "sm"} disabled={props.disabled} />}><Plus className="size-3.5" />{props.label ?? t("common.add")}<ChevronDown className="size-3.5" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end">{props.actions.map(action => { const Icon = action.icon; return <DropdownMenuItem key={action.label} disabled={action.disabled} onClick={action.onClick}><Icon />{action.label}</DropdownMenuItem>; })}</DropdownMenuContent>
  </DropdownMenu>;
}

/** Library tools first, refresh last. This menu never creates or shares an unrelated item. */
export function IntegrationMoreMenu(props: { children?: ReactNode; busy?: boolean; onRefresh?: () => void; pageToolbar?: boolean; triggerRef?: RefObject<HTMLButtonElement | null> }) {
  const layout = useIntegrationLibraryLayout();
  const refresh = layout?.onRefresh ?? props.onRefresh;
  if (layout?.ownsMoreMenu && !props.pageToolbar) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button ref={props.triggerRef} variant="ghost" size="icon-sm" aria-label={t("integrations.more_actions")} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {props.children}
      {props.children ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem disabled={props.busy || !refresh} onClick={refresh}><RefreshCw />{t("common.refresh")}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Every library uses the same click-to-open row and trailing action menu. */
export function IntegrationLibraryRow(props: { name: string; description: string; icon: ReactNode; source?: ReactNode; status?: ReactNode; busy?: boolean; selected?: boolean; opensEditor?: boolean; onOpen: () => void; onEdit?: () => void; onExport?: () => void; onShare?: () => void; onRemove?: () => void; actions?: ReactNode }) {
  return <div className={cn("flex items-center gap-3 rounded-xl px-1 py-2.5 transition-colors hover:bg-muted/30", props.selected && "bg-muted")}>
    <button type="button" onClick={props.onOpen} aria-haspopup={props.opensEditor ? undefined : "dialog"} aria-pressed={props.selected} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {props.icon}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{props.name}</span><span className="mt-0.5 block max-w-[64ch] truncate text-xs text-muted-foreground">{props.description}</span></span>
      {props.source ? <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{props.source}</span> : null}
      {props.status}
    </button>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={props.busy} aria-label={t("integrations.item_actions", { name: props.name })} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={props.onOpen}>{props.opensEditor ? <Pencil /> : <Info />}{t(props.opensEditor ? "common.edit" : "integrations.view_details")}</DropdownMenuItem>
        {props.onEdit ? <DropdownMenuItem onClick={props.onEdit}><Pencil />{t("common.edit")}</DropdownMenuItem> : null}
        {props.onExport ? <DropdownMenuItem onClick={props.onExport}><Download />{t("skill_export.action")}</DropdownMenuItem> : null}
        {props.onShare ? <DropdownMenuItem onClick={props.onShare}><Share2 />{t("firm_hub.share_with_firm")}</DropdownMenuItem> : null}
        {props.actions}
        {props.onRemove ? <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={props.onRemove}><Trash2 />{t("common.remove")}</DropdownMenuItem></> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

/** Shared structure for the three integration libraries; setup lives in dialogs. */
export function IntegrationLibraryHeader(props: { title: string; description: string; leadingActions?: ReactNode; actions?: ReactNode }) {
  const layout = useIntegrationLibraryLayout();
  if (layout) return <>{layout.leadingActions && props.leadingActions ? createPortal(props.leadingActions, layout.leadingActions) : null}<IntegrationLibraryActions>{props.actions}</IntegrationLibraryActions></>;
  return <div className="flex flex-wrap items-start justify-between gap-4">
    <SectionHeading className="min-w-0 flex-1 basis-64" title={props.title} description={props.description} />
    {props.leadingActions || props.actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{props.leadingActions}{props.actions}</div> : null}
  </div>;
}

export function IntegrationSearch(props: { value: string; onChange: (value: string) => void; label: string; children?: ReactNode; toolbar?: boolean }) {
  const layout = useIntegrationLibraryLayout();
  const search = <div className={props.toolbar && layout ? "relative w-full" : "relative w-full sm:max-w-sm"}>
      <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" className="ps-9 pe-9 [&::-webkit-search-cancel-button]:appearance-none" aria-label={props.label} placeholder={props.label} value={props.value} onChange={event => props.onChange(event.target.value)} />
      {props.value ? <Button variant="ghost" size="icon-sm" className="absolute end-1 top-1/2 -translate-y-1/2" aria-label={t("integrations.clear_search")} onClick={() => props.onChange("")}><X className="size-3.5" /></Button> : null}
    </div>;
  if (props.toolbar && layout) return <>{layout.search ? createPortal(search, layout.search) : null}{props.children}</>;
  return <div className="space-y-3">{search}{props.children}</div>;
}

export function IntegrationGroupHeading(props: { title: string; count: number; children?: ReactNode; hideInLibrary?: boolean }) {
  const layout = useIntegrationLibraryLayout();
  if (props.hideInLibrary && layout) return null;
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">{props.title}<span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal tabular-nums text-muted-foreground">{props.count}</span></h3>
    {props.children}
  </div>;
}

export function IntegrationEmptyState(props: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  const Icon = props.icon;
  return <div className="flex flex-col items-center rounded-2xl border border-border bg-muted/20 px-6 py-12 text-center">
    <IconTile className="mb-4"><Icon className="size-5 text-muted-foreground" /></IconTile>
    <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
    {props.description ? <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{props.description}</p> : null}
    {props.action ? <div className="mt-5">{props.action}</div> : null}
  </div>;
}
