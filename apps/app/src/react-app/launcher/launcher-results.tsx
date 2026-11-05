import { LauncherResultOrigin } from "./launcher-result-origin";
import { useEffect, useRef, useState } from "react";
import { CheckSquare, ChevronRight, File, FileText, Folder, Image, ListTodo, Mail, MessageSquare, Mic, Presentation, Sheet, Square } from "lucide-react";
import type { LauncherResultAction, LauncherSearchResult, LauncherSourceState } from "@legalwork/types/launcher";
import { formatRelativeTime } from "@/app/utils";
import { searchTerms } from "@legalwork/types/search";
import { t } from "@/i18n";
import { primaryResultAction, resultActionMenu } from "./action-catalog";
import { resultKey } from "./launcher-search-session";
import { handleLauncherFocusKey } from "./launcher-focus";
import { FILE_TYPE_PRESETS } from "./launcher-typed-filters";

import { optionId, RESULT_KIND_ORDER } from "./launcher-keyboard";
export const CATEGORY_ICONS = { projects: Folder, files: FileText, chats: MessageSquare, tasks: ListTodo, recordings: Mic };
export function fileTypeIcon(extension: string) {
  const type = extension.toLowerCase().replace(/^\./, "");
  if (FILE_TYPE_PRESETS.images.includes(type)) return Image;
  if (FILE_TYPE_PRESETS.spreadsheets.includes(type)) return Sheet;
  if (FILE_TYPE_PRESETS.presentations.includes(type)) return Presentation;
  if (FILE_TYPE_PRESETS.emails.includes(type)) return Mail;
  return FILE_TYPE_PRESETS.documents.includes(type) ? FileText : File;
}
export function resultIcon(item: LauncherSearchResult) {
  return item.fileType === "folder" ? Folder : item.kind === "files" ? fileTypeIcon(item.fileType ?? (item.path ?? item.title).split(".").at(-1) ?? "") : CATEGORY_ICONS[item.kind];
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = searchTerms(query).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  return <>{text.split(new RegExp(`(${terms.join("|")})`, "gi")).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}
export function coverageLabel(sources: LauncherSourceState[]) {
  if (!sources.length) return "";
  if (sources.some(source => source.coverage === "searching")) return t("launcher.coverage.searching");
  if (sources.some(source => source.coverage === "indexing")) return t("launcher.coverage.indexing");
  const unavailable = sources.filter(source => source.coverage === "unavailable" || source.coverage === "offline");
  if (unavailable.length) return t("launcher.coverage.unavailable", { count: unavailable.length, names: unavailable.map(source => source.label).join(", ") });
  if (sources.some(source => source.coverage === "partial" || source.limited)) return t("launcher.coverage.partial");
  return "";
}
export type LauncherExtraAction = "open-in-app" | "copy-to-clipboard" | "hide";
export function actionLabel(action: LauncherResultAction | "run" | "open-conversation" | LauncherExtraAction) { return t(`launcher.result_action.${action}`); }

export function LauncherResultList(props: {
  items: LauncherSearchResult[]; sources: LauncherSourceState[]; query: string; selectedKey: string | null; multiSelect: Set<string>; pins: Set<string>; pending: boolean; hideEmpty?: boolean;
  onSelect: (key: string) => void; onRun: (result: LauncherSearchResult, action: LauncherResultAction) => void; onToggleMulti: (key: string) => void; onOpenActions: (key: string) => void;
}) {
  const groups = RESULT_KIND_ORDER.map(kind => ({ kind, items: props.items.filter(item => item.kind === kind), sources: props.sources.filter(source => source.kind === kind) })).filter(group => group.items.length);
  if (!groups.length) return props.hideEmpty ? null : <div className="launcher-empty">{props.pending ? t("launcher.coverage.searching") : props.query.length === 1 ? t("content_search.keep_typing") : t("content_search.no_results")}</div>;
  return <>
    {groups.map(group => <section key={group.kind}>
      <div className="launcher-section-title"><span>{t(`launcher.kind.${group.kind}`)}</span><span className="launcher-coverage">{coverageLabel(group.sources)}</span></div>
      {group.items.map(item => {
        const key = resultKey(item);
        const Icon = resultIcon(item);
        const primary = primaryResultAction(item);
        const multi = props.multiSelect.has(key);
        const details = [item.path && item.path !== item.title ? item.path : null, item.completed ? t("tasks.status_done") : item.status, item.updatedAt ? formatRelativeTime(item.updatedAt) : null].filter(Boolean).join(" · ");
        return <div key={key} id={optionId(key)} data-launcher-item role="option" aria-selected={props.selectedKey === key} data-key={key} data-selected={props.selectedKey === key} data-multi={multi} className="launcher-row"
          onMouseMove={() => props.onSelect(key)} onClick={event => { if (event.metaKey || event.ctrlKey) props.onToggleMulti(key); else props.onRun(item, primary); }} onContextMenu={event => { event.preventDefault(); props.onSelect(key); props.onOpenActions(key); }}>
          <span className="launcher-row-icon" onClick={event => { event.stopPropagation(); props.onToggleMulti(key); }} aria-hidden="true">{item.kind === "files" ? multi ? <CheckSquare className="size-4" /> : props.multiSelect.size ? <Square className="size-4" /> : <Icon className="size-4" /> : <Icon className="size-4" />}</span>
          <div className="launcher-row-main">
            <div className="launcher-row-title"><Highlight text={item.title} query={props.query} /></div>
            <div className="launcher-row-meta">{item.subtitle && <LauncherResultOrigin item={item} />}{item.subtitle && details ? " · " : ""}{details}{item.incomplete ? ` · ${t("content_search.partial")}` : ""}</div>
            {item.excerpt && item.excerpt !== item.path && <div className="launcher-row-excerpt"><Highlight text={item.excerpt} query={props.query} /></div>}
          </div>
          <span className="launcher-row-hint">{props.selectedKey === key ? <button type="button" aria-label={t("launcher.footer.actions")} onClick={event => { event.stopPropagation(); props.onOpenActions(key); }}><ChevronRight className="size-4" /></button> : item.kind === "projects" ? <Folder className="size-3.5" /> : null}</span>
        </div>;
      })}
    </section>)}
  </>;
}

export type LauncherTransferAction = "copy-to-project" | "move-to-project";
export function LauncherActionMenu(props: { result: LauncherSearchResult; multiSelected: number; pinned: boolean; extra: LauncherExtraAction[]; projects: { id: string; name: string }[]; onRun: (action: LauncherResultAction) => void; onExtra: (action: LauncherExtraAction) => void; onTransfer: (action: LauncherTransferAction, projectId: string) => void; onClose: () => void }) {
  const actions = resultActionMenu(props.result, props.multiSelected).filter(action => (action !== "copy-to-project" && action !== "move-to-project") || props.projects.length > 0);
  // Copy and move ask for the destination inside the same menu; nothing moves before a project is chosen.
  const [pick, setPick] = useState<LauncherTransferAction | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape" || event.key === "ArrowLeft") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (pick) setPick(null); else propsRef.current.onClose();
        return;
      }
      if (handleLauncherFocusKey(event, menuRef.current, true)) event.stopImmediatePropagation();
    };
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) propsRef.current.onClose(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onPointer, true); };
  }, [props.result.id, props.result.kind, props.result.sourceId, pick]);
  if (pick) return <div ref={menuRef} className="launcher-actions-menu" role="menu" aria-label={t("launcher.transfer.pick")}>
    <div className="launcher-section-title">{t("launcher.transfer.pick")}</div>
    {props.projects.map(project => <button key={project.id} type="button" role="menuitem" onMouseMove={event => event.currentTarget.focus()} onClick={() => props.onTransfer(pick, project.id)}>{project.name}</button>)}
    <button type="button" role="menuitem" onMouseMove={event => event.currentTarget.focus()} onClick={() => setPick(null)}>{t("launcher.transfer.back")}</button>
  </div>;
  return <div ref={menuRef} className="launcher-actions-menu" role="menu" aria-label={props.result.title}>
    {props.extra.filter(action => action !== "hide").map(action => <button key={action} type="button" role="menuitem" onMouseMove={event => event.currentTarget.focus()} onClick={() => props.onExtra(action)}>{actionLabel(action)}</button>)}
    {actions.length > 0 && <div role="separator" className="launcher-menu-separator" />}
    {actions.map(action => <button key={action} type="button" role="menuitem" onMouseMove={event => event.currentTarget.focus()} onClick={() => { if (action === "copy-to-project" || action === "move-to-project") setPick(action); else props.onRun(action); }}>{actionLabel(action)}{action === "compare" && props.multiSelected >= 2 ? ` (${props.multiSelected})` : ""}</button>)}
    <div role="separator" className="launcher-menu-separator" />
    {props.extra.filter(action => action === "hide").map(action => <button key={action} type="button" role="menuitem" onMouseMove={event => event.currentTarget.focus()} onClick={() => props.onExtra(action)}>{actionLabel(action)}</button>)}
  </div>;
}
