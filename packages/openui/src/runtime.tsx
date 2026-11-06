import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createLibrary, defineComponent, Renderer, useIsQueryLoading } from "@openuidev/react-lang";
import { Card } from "@openuidev/react-ui/Card";
import { CardHeader } from "@openuidev/react-ui/CardHeader";
import { TextContent } from "@openuidev/react-ui/TextContent";
import { OverviewCardBlock } from "@openuidev/react-ui/OverviewCardBlock";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@openuidev/react-ui/Table";
import { BarChart, LineChart, PieChart } from "@openuidev/react-ui/Charts";
import { Tag } from "@openuidev/react-ui/Tag";
import { Callout } from "@openuidev/react-ui/Callout";
import { Input } from "@openuidev/react-ui/Input";
import { ThemeProvider } from "@openuidev/react-ui/ThemeProvider";
import { isLocalOpenUIProgram, schemas, SourceOwnerSchema, type SourceOwner } from "./catalog";

type Row = Record<string, unknown>;
type Column = { field: string; label: string };
export type BoardActions = {
  canMove: (row: Row, field: string) => boolean;
  move: (row: Row, field: string, value: string) => Promise<void>;
};
const Host = createContext<{ openLink?: (href: string) => void; openSource?: (path: string, owner?: SourceOwner, binding?: string) => void; boardActions?: BoardActions; streaming: boolean }>({ streaming: false });
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function fieldLabel(field: string) { return field.replace(/^properties\./, "").replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
function stageTone(value: unknown): "neutral" | "info" | "success" | "warning" | "danger" {
  const text = String(value).toLowerCase();
  return /overdue|over budget|high|blocked/.test(text) ? "danger" : /awaiting|review|hold|onboarding/.test(text) ? "warning" : /active|complete|current/.test(text) ? "success" : /progress|retainer|scoping/.test(text) ? "info" : "neutral";
}
function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return numberFormat.format(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function SourceButton({ path, sourceOwner, binding, available, children }: { path: unknown; sourceOwner?: unknown; binding?: string; available?: unknown; children: ReactNode }) {
  const host = useContext(Host);
  const owner = SourceOwnerSchema.safeParse(sourceOwner);
  return available !== false && typeof path === "string" && host.openSource && !host.streaming
    ? <button type="button" className="lw-view-source" onClick={() => host.openSource?.(path, owner.success ? owner.data : undefined, binding)}>{children}</button>
    : <span>{children}</span>;
}
function ActionList({ rows, emptyText = "No items" }: { rows: Row[]; emptyText?: string }) {
  const host = useContext(Host);
  if (!rows.length) return <p className="lw-view-muted">{emptyText}</p>;
  return <ul className="lw-view-actions">{rows.slice(0, 1000).map((row, index) => {
    const title = display(row.title);
    const href = row.__viewSourceAvailable !== false && typeof row.href === "string" && safeActionHref(row.href) ? row.href : null;
    return <li key={index}>
      <div className="lw-view-action-heading">{href && !host.streaming ? <a href={href} className="lw-view-source" target="_blank" rel="noopener noreferrer" onClick={event => {
        if (host.openLink) { event.preventDefault(); host.openLink(href); }
        else if (!href.startsWith("https://")) event.preventDefault();
      }}>{title}</a> : <strong>{title}</strong>}{row.priority ? <Tag text={display(row.priority)} variant={stageTone(row.priority)} size="sm" /> : null}</div>
      {row.detail ? <p className="lw-view-prose">{display(row.detail)}</p> : null}
      {row.meta ? <p className="lw-view-muted">{display(row.meta)}</p> : null}
    </li>;
  })}</ul>;
}
export function safeActionHref(href: string) {
  if (/^legalworktask:\/\/[\w-]+\/?$/.test(href)) return true;
  try { const url = new URL(href); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

function DataTable({ rows, columns, searchable = true }: { rows: Row[]; columns: Column[]; searchable?: boolean }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ field: string; desc: boolean } | null>(null);
  const visible = useMemo(() => {
    const next = rows.slice(0, 1000).filter(row => !search || columns.some(col => display(row[col.field]).toLocaleLowerCase().includes(search.toLocaleLowerCase())));
    return sort ? next.sort((a, b) => (typeof a[sort.field] === "number" && typeof b[sort.field] === "number" ? Number(a[sort.field]) - Number(b[sort.field]) : display(a[sort.field]).localeCompare(display(b[sort.field]), undefined, { numeric: true })) * (sort.desc ? -1 : 1)) : next;
  }, [rows, columns, search, sort]);
  return <div className="lw-view-table">{searchable && rows.length > 5 && <Input aria-label="Filter displayed rows" placeholder="Filter displayed rows…" value={search} onChange={event => setSearch(event.target.value)} />}
    <Table><TableHeader><TableRow>{columns.map(col => <TableHead key={col.field}><button type="button" onClick={() => setSort(current => ({ field: col.field, desc: current?.field === col.field && !current.desc }))}>{col.label}{sort?.field === col.field ? sort.desc ? " ↓" : " ↑" : ""}</button></TableHead>)}</TableRow></TableHeader><TableBody>{visible.map((row, i) => <TableRow key={typeof row.path === "string" ? row.path : i}>{columns.map((col, j) => <TableCell key={col.field} className={typeof row[col.field] === "number" ? "lw-view-number" : undefined}>{j === 0 ? <SourceButton path={row.path} sourceOwner={row.__viewSourceOwner} binding={typeof row.__viewBinding === "string" ? row.__viewBinding : undefined} available={row.__viewSourceAvailable}>{display(row[col.field])}</SourceButton> : /(?:stage|status|priority)$/.test(col.field) && typeof row[col.field] === "string" ? <Tag text={display(row[col.field])} variant={stageTone(row[col.field])} size="sm" /> : display(row[col.field])}</TableCell>)}</TableRow>)}</TableBody></Table>
    {!visible.length && <p className="lw-view-muted">No matching records</p>}
  </div>;
}
function Board({ rows, groupBy, titleField, fields = [], groupOrder = [] }: { rows: Row[]; groupBy: string; titleField: string; fields?: Column[]; groupOrder?: string[] }) {
  const host = useContext(Host);
  const actions = host.streaming ? undefined : host.boardActions;
  const dragging = useRef<Row | null>(null);
  const moving = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const groups = new Map<string, Row[]>();
  for (const row of rows.slice(0, 1000)) { const key = display(row[groupBy]); groups.set(key, [...(groups.get(key) ?? []), row]); }
  const stages = [...new Set([...groupOrder, ...groups.keys()])];
  const move = async (row: Row, value: string) => {
    if (!actions?.canMove(row, groupBy) || moving.current || !stages.includes(value) || value === display(row[groupBy])) return;
    moving.current = true; setPending(true); setError("");
    try { await actions.move(row, groupBy, value); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { moving.current = false; setPending(false); }
  };
  return <div>{error && <p role="alert" className="lw-view-board-error">{error}</p>}<div className="lw-view-board" aria-busy={pending}>{stages.map(name => {
    const items = groups.get(name) ?? [];
    return <section key={name} className={`lw-view-board-column${dropTarget === name ? " lw-view-board-drop" : ""}`} onDragOver={event => {
      if (dragging.current && actions?.canMove(dragging.current, groupBy) && !moving.current) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(name); }
    }} onDragLeave={() => setDropTarget(null)} onDrop={event => {
      if (!dragging.current) return;
      event.preventDefault(); event.stopPropagation(); setDropTarget(null);
      if (dragging.current) void move(dragging.current, name);
      dragging.current = null;
    }}><div className="lw-view-board-heading"><Tag text={name || "Unassigned"} variant={stageTone(name)} size="sm" /><span className="lw-view-board-count">{items.length}</span></div><div className="lw-view-board-items">{items.map((row, i) => {
      const editable = Boolean(actions?.canMove(row, groupBy));
      const title = display(row[titleField]) || "Untitled";
      return <article key={typeof row.path === "string" ? row.path : i} draggable={editable && !pending} onDragStart={event => { if (!editable || pending) { event.preventDefault(); return; } event.stopPropagation(); dragging.current = row; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", title); }} onDragEnd={() => { dragging.current = null; setDropTarget(null); }}>
        <Card width="full" variant="sunk" className="lw-view-board-card"><SourceButton path={row.path} sourceOwner={row.__viewSourceOwner} binding={typeof row.__viewBinding === "string" ? row.__viewBinding : undefined} available={row.__viewSourceAvailable}><strong>{title}</strong></SourceButton>{fields.map(field => <div className="lw-view-board-field" key={field.field}><span>{field.label}</span><span>{display(row[field.field])}</span></div>)}
          {editable && <select className="lw-view-board-stage" aria-label={`Move ${title} to stage`} disabled={pending} value={name} onChange={event => void move(row, event.target.value)}>{stages.map(stage => <option key={stage} value={stage}>{stage || "Unassigned"}</option>)}</select>}
        </Card>
      </article>;
    })}{!items.length && <p className="lw-view-board-empty">No records</p>}</div></section>;
  })}</div></div>;
}
function Chart({ kind, rows, category, series, title }: { kind: "bar" | "line" | "pie"; rows: Row[]; category: string; series: string[]; title?: string }) {
  const categoryName = fieldLabel(category);
  const seriesNames = series.map(fieldLabel);
  const data = rows.slice(0, 1000).flatMap(row => {
    const entry: Record<string, string | number> = { [categoryName]: display(row[category]) };
    for (const field of series) if (typeof row[field] === "number" && Number.isFinite(row[field])) entry[fieldLabel(field)] = row[field];
    return Object.keys(entry).length > 1 ? [entry] : [];
  });
  return <div className="lw-view-chart">{title && <h3>{title}</h3>}{data.length ? kind === "pie" ? <PieChart data={data} categoryKey={categoryName} dataKey={seriesNames[0]} variant="donut" height={300} /> : kind === "bar" ? <BarChart data={data} categoryKey={categoryName} height={300} legend={series.length > 1} /> : <LineChart data={data} categoryKey={categoryName} height={300} /> : <p className="lw-view-muted">No numeric data to display</p>}<details><summary>View chart data</summary><DataTable rows={data} columns={[categoryName, ...seriesNames].map(field => ({ field, label: field }))} searchable={false} /></details></div>;
}

// Query references are null until the renderer resolves them, despite the catalog's
// final-value schema. Do not mount a data component into a permanent error boundary.
function RowsReady({ rows, children }: { rows: Row[] | null | undefined; children: ReactNode }) {
  const loading = useIsQueryLoading();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const { streaming } = useContext(Host);
  if (rows != null) return children;
  // Queries start after the first commit; keep that initial frame recoverable.
  if (!mounted || loading || streaming) return <p className="lw-view-query-status" role="status">Loading data…</p>;
  return <p className="lw-view-board-error" role="alert">This view's data is unavailable. Check the dataset name and rows binding.</p>;
}

export const openUILibrary = createLibrary({ id: "legalwork-1", components: [
  defineComponent({ name: "Stack", props: schemas.Stack, description: "Responsive layout", component: ({ props, renderNode }) => <div className="lw-view-stack" style={{ gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, Math.round(props.columns ?? 1)))}, minmax(0, 1fr))` }}>{props.children.map((child, i) => <div className="lw-view-stack-item" key={i}>{renderNode(child)}</div>)}</div> }),
  defineComponent({ name: "Card", props: schemas.Card, description: "Titled card", component: ({ props, renderNode }) => <Card width="full" className="lw-view-card"><CardHeader title={props.title} subtitle={props.subtitle} /><div className="lw-view-card-body">{props.children.map((child, i) => <div key={i}>{renderNode(child)}</div>)}</div></Card> }),
  defineComponent({ name: "Heading", props: schemas.Heading, description: "Section heading", component: ({ props }) => props.level === 1 ? <h1 className="lw-view-title">{props.text}</h1> : <h2 className="lw-view-heading">{props.text}</h2> }),
  defineComponent({ name: "Text", props: schemas.Text, description: "Plain prose", component: ({ props }) => <TextContent variant="clear"><p className="lw-view-prose">{props.text}</p></TextContent> }),
  defineComponent({ name: "Metric", props: schemas.Metric, description: "Metric with context", component: ({ props }) => <OverviewCardBlock className="lw-view-metric" items={[{ top: props.label, bottom: { value: display(props.value), subtext: props.detail } }]} /> }),
  defineComponent({ name: "ActionList", props: schemas.ActionList, description: "Source-linked actions", component: ({ props }) => <RowsReady rows={props.rows}><ActionList {...props} /></RowsReady> }),
  defineComponent({ name: "Table", props: schemas.Table, description: "Data table", component: ({ props }) => <RowsReady rows={props.rows}><DataTable {...props} /></RowsReady> }),
  defineComponent({ name: "Board", props: schemas.Board, description: "Grouped stage board", component: ({ props }) => <RowsReady rows={props.rows}><Board {...props} /></RowsReady> }),
  defineComponent({ name: "BarChart", props: schemas.BarChart, description: "Bar chart", component: ({ props }) => <RowsReady rows={props.rows}><Chart {...props} kind="bar" /></RowsReady> }),
  defineComponent({ name: "LineChart", props: schemas.LineChart, description: "Line chart", component: ({ props }) => <RowsReady rows={props.rows}><Chart {...props} kind="line" /></RowsReady> }),
  defineComponent({ name: "PieChart", props: schemas.PieChart, description: "Donut chart", component: ({ props }) => <RowsReady rows={props.rows}><Chart rows={props.rows} category={props.category} series={[props.value]} title={props.title} kind="pie" /></RowsReady> }),
  defineComponent({ name: "Badge", props: schemas.Badge, description: "Status", component: ({ props }) => <Tag text={props.text} variant={props.tone} size="sm" /> }),
  defineComponent({ name: "Callout", props: schemas.Callout, description: "Notice", component: ({ props }) => <Callout title={props.title} description={props.description} variant={props.tone ?? "info"} /> }),
  defineComponent({ name: "Source", props: schemas.Source, description: "Local source", component: ({ props }) => <SourceButton path={props.path} binding={props.binding}>{props.label ?? props.path}</SourceButton> }),
] });
export function OpenUIView({ program, query, openSource, openLink, boardActions, streaming = false, dark = false, onError }: { program: string; query?: (name: string) => Promise<unknown>; openLink?: (href: string) => void; openSource?: (path: string, owner?: SourceOwner, binding?: string) => void; boardActions?: BoardActions; streaming?: boolean; dark?: boolean; onError?: (message: string) => void }) {
  const themeId = `lw-openui-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const toolProvider = useMemo(() => { const resolve = async (args: Record<string, unknown>) => {
    if (streaming || typeof args.name !== "string" || !query) throw new Error("Data is unavailable for this preview");
    return query(args.name);
  }; return { data: resolve, wiki_query: resolve }; }, [query, streaming]);
  if (!isLocalOpenUIProgram(program)) return <div role="alert">This view contains an unsupported program format.</div>;
  return <div className="lw-openui" id={themeId}><ThemeProvider mode={dark ? "dark" : "light"} cssSelector={`#${themeId}`}><Host.Provider value={{ openSource, openLink, boardActions, streaming }}><Renderer response={program} library={openUILibrary} isStreaming={streaming} toolProvider={toolProvider} publishObservability={false} queryLoader={<span className="lw-view-query-status" role="status">Updating…</span>} onError={errors => { if (!streaming) onError?.(errors.map(error => error.message).join("\n")); }} /></Host.Provider></ThemeProvider></div>;
}
