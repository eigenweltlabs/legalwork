import { PORTFOLIO_TEMPLATE } from "./portfolio-template.js";
import { MORNING_BRIEFING_TEMPLATE } from "./briefing-template.js";
import { z } from "zod";

const text = z.string();
const rows = z.array(z.record(z.string(), z.unknown()));
const columns = z.array(z.object({ field: text, label: text }));
const chart = () => z.object({ rows, category: text, series: z.array(text).min(1), title: text.optional() });
const distribution = () => z.object({ rows, category: text, value: text, title: text.optional() });
const currency = z.string().regex(/^[A-Z]{3}$/).optional();
const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
export const SourceOwnerSchema = z.object({ kind: z.enum(["wiki", "workspace"]), id: z.string().min(1).max(200) });
export type SourceOwner = z.infer<typeof SourceOwnerSchema>;
// Order is the OpenUI positional argument contract. Keep this module React-free.
export const schemas = {
  Stack: z.object({ children: z.array(z.unknown()), columns: z.number().optional() }),
  Card: z.object({ title: text, children: z.array(z.unknown()), subtitle: text.optional() }),
  Heading: z.object({ text, level: z.number().optional() }),
  Text: z.object({ text }),
  Metric: z.object({ label: text, value: z.union([text, z.number()]), detail: text.optional(), currency }),
  QueryMetric: z.object({ label: text, rows, field: text, currency, detail: text.optional() }),
  ActionList: z.object({ rows, emptyText: text.optional() }),
  Table: z.object({ rows, columns, searchable: z.boolean().optional() }),
  Board: z.object({ rows, groupBy: text, titleField: text, fields: columns.optional(), groupOrder: z.array(text).optional() }),
  BarChart: chart(), HorizontalBarChart: chart(), StackedBarChart: chart(), LineChart: chart(), AreaChart: chart(),
  PieChart: distribution().extend({ shape: z.enum(["pie", "donut"]).optional() }), FunnelChart: distribution(),
  RankedBars: distribution().extend({ currency }),
  Badge: z.object({ text, tone: tone.optional() }),
  Callout: z.object({ title: text, description: text.optional(), tone: tone.optional() }),
  Source: z.object({ path: text, label: text.optional(), binding: text.optional() }),
};

export const OPENUI_CATALOG = {
  id: "legalwork-1",
  components: {
    Stack: "Stack(children, columns=1): responsive layout, 1 to 4 columns",
    Card: "Card(title, children, subtitle?): stock OpenUI card",
    Heading: "Heading(text, level=2)",
    Text: "Text(text): plain text, no HTML",
    Metric: "Metric(label, value, detail?, currency?): grouped number or ISO currency amount in major units",
    QueryMetric: "QueryMetric(label, rows, field, currency?, detail?): show a numeric field from a single summary row. Bind an ungrouped metrics query.",
    HorizontalBarChart: "HorizontalBarChart(rows, categoryField, [numericSeriesFields], title?): horizontal rankings for named categories",
    AreaChart: "AreaChart(rows, categoryField, [numericSeriesFields], title?): shaded time series in chronological order",
    StackedBarChart: "StackedBarChart(rows, categoryField, [numericSeriesFields], title?): compare parts with a common unit",
    FunnelChart: "FunnelChart(rows, stageField, numericValueField, title?): sequential stages with compatible populations",
    ActionList: "ActionList(rows, emptyText?): readable linked action rows. Fields: title, detail?, meta?, priority?, href? (exact https source or legalworktask:// link). Missing links remain plain text. No mutations.",
    Table: "Table(rows, [{field,label}], searchable=true): sortable, searchable source-linked rows",
    Board: "Board(rows, groupBy, titleField, [{field,label}]?, [groupOrder]? ): stage columns including empty stages, source-linked cards. In writable wiki dashboards, users can drag cards or select a stage for a queried properties.* string field. Reports stay read-only.",
    BarChart: "BarChart(rows, categoryField, [numericSeriesFields], title?)",
    LineChart: "LineChart(rows, categoryField, [numericSeriesFields], title?)",
    PieChart: "PieChart(rows, categoryField, numericValueField, title?, shape=donut): choose pie or donut",
    RankedBars: "RankedBars(rows, categoryField, numericValueField, title?, currency?): ranked categories with an exact value alongside each bar. Best for portfolio values or counts.",
    Badge: "Badge(text, tone=neutral)",
    Callout: "Callout(title, description?, tone=info)",
    Source: "Source(path, label?, bindingName?): open a source in a named dataset's source owner, or this view's owner when binding is omitted",
  },
  templates: { morningBriefing: MORNING_BRIEFING_TEMPLATE, backOfficePortfolio: PORTFOLIO_TEMPLATE },
  rules: [
    "Return bare OpenUI Lang, never JavaScript, JSX, HTML, cloud bundles or fenced program text.",
    "Assign root = Stack([...]). Assignments use '=' and references use their variable name; no return statement.",
    "Query data with clients = Query(\"wiki_query\", {name:\"clients\"}, {rows:[],total:0}); then pass clients.rows to components.",
    "The Query name must match a live Back Office or wiki query binding or saved dataset. No other tool calls, URLs or mutations are exposed.",
    "Use actual query or report data. Never invent totals, records or citations. Server totals can exceed the bounded row set; the viewer displays truncation.",
    "For wiki-backed dashboards, use wiki_fields and wiki_query to inspect indexed fields. Use groupBy/metrics on the server for aggregates over the full result set.",
    "Rows carry source provenance from the host. Board and table filters are local to returned rows. Human board moves use the host's revision-checked property API; agent edits require typed wiki tools.",
    "Use one page heading, a row of metrics, then charts and tables. Metric is already an OpenUI overview card: do not wrap each metric in another Card. Avoid nested cards and repeated titles. Use short supporting text; a brief Badge or Text is enough for demo-data labels.",
    "Reports and dashboards work with project files, connected sources, user-provided data, and wikis. For Back Office, first call legalwork_back_office_discover then legalwork_back_office_query. Put the exact tested binding, including source, directoryId and objectId, in queries with mode dashboard. This works in projects, the Assistant and wikis, including custom models. For static documents and external data pass named datasets with queries: {}. Query(\"data\", {name:\"binding\"}, {rows:[],total:0}) reads a dataset or a live binding. Dataset dashboards refresh when their saved data is updated; they do not automatically re-fetch the original documents or external sources.",
    "For a portfolio use a row of QueryMetric cards, then Stack([RankedBars(...), PieChart(...)], 2) for a ranking and composition, followed by the searchable register. Show exact currency in the metric and label currency axes or chart titles. Use area charts for change over time, funnels only for ordered stages. Never invent trends, benchmarks, percentages or controls.",
    "view_create/view_update return unsaved previews. The user chooses Save and a destination in the app. The main Assistant may instead use legalwork_assistant_save_report for authorized files in its own workspace. Never hand-write view files. Only a saved reference returned by that tool or view_read/view_list belongs in a legalwork-view Markdown fence.",
  ],
  example: 'clients = Query("wiki_query", {name:"clients"}, {rows:[],total:0})\nroot = Stack([Heading("Client engagements", 1), Metric("Clients", clients.total), Card("Engagement stages", [Board(clients.rows, "properties.stage", "title", [{field:"properties.partner",label:"Partner"}])])])',
};
export const OPENUI_CATALOG_PROMPT = JSON.stringify(OPENUI_CATALOG, null, 2);

/** Cloud response bundles can execute script definitions. Only the local DSL is accepted. */
export function isLocalOpenUIProgram(program: string) {
  return program.length <= 100_000 && !/^\s*(?:\{|\[|```|<)/.test(program) && !/\b(?:Script|Mutation)\s*\(/.test(program);
}
