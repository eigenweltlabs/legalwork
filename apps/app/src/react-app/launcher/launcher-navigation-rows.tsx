import { Fragment, type ReactNode, type DragEvent } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { t } from "@/i18n";
import { optionId } from "./launcher-keyboard";

export type NavigationRow = { id: string; title: string; subtitle?: string; meta?: ReactNode; Icon: LucideIcon; avatar?: ReactNode; run: () => void | Promise<unknown>; shortcut?: string; result?: LauncherSearchResult; openInApp?: () => void; hideId?: string; restorable?: boolean };

export function LauncherNavigationRows({ rows, selected, onSelect, onError, onOpenActions, canDrag, onDragStart, grouped = false }: { canDrag?: (result: LauncherSearchResult) => boolean; onDragStart?: (event: DragEvent<HTMLElement>, result: LauncherSearchResult) => void; grouped?: boolean; rows: NavigationRow[]; selected: string | null; onSelect: (id: string) => void; onError: (error: unknown) => void; onOpenActions?: (id: string) => void }) {
  const group = (id: string) => id.startsWith("category:") ? "find_group" : (id.startsWith("home:parked-draft:") || ["home:assistant", "home:project-chat"].includes(id)) ? "context_group" : "organize_group";
  return <>{rows.map(({ id, title, subtitle, meta, Icon, avatar, run, shortcut, result }, index) => <Fragment key={id}>{grouped && (index === 0 || group(rows[index - 1].id) !== group(id)) && <p className="launcher-section-title">{t(`launcher.flow.${group(id)}`)}</p>}<div id={optionId(id)} data-launcher-item role="option" aria-selected={selected === id} data-selected={selected === id} className="launcher-row" draggable={Boolean(result && canDrag?.(result))} onDragStart={event => { if (result) onDragStart?.(event, result); }}
    onMouseMove={() => onSelect(id)} onClick={() => void Promise.resolve().then(run).catch(onError)} onContextMenu={event => { if (onOpenActions) { event.preventDefault(); onSelect(id); onOpenActions(id); } }}>
    <span className="launcher-row-icon">{avatar ?? <Icon className="size-4" />}</span>
    <div className="launcher-row-main"><div className="launcher-row-title">{title}</div>{(meta ?? subtitle) && <div className="launcher-row-meta">{meta ?? subtitle}</div>}</div>
    {shortcut && <kbd className="launcher-row-shortcut">{shortcut}</kbd>}
    {onOpenActions && selected === id && <button type="button" aria-label={t("launcher.footer.actions")} onClick={event => { event.stopPropagation(); onOpenActions(id); }}><ChevronRight className="size-4" /></button>}
  </div></Fragment>)}</>;
}
