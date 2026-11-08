import { expect, test } from "bun:test";
import { createParser, createStreamingParser } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { OPENUI_CATALOG } from "./catalog";
import { OpenUIView, openUILibrary } from "./runtime";

test("the agent catalog offers content guidance without a ready-made dashboard or briefing", () => {
  expect(OPENUI_CATALOG).not.toHaveProperty("templates");
  expect(OPENUI_CATALOG).not.toHaveProperty("example");
  expect(OPENUI_CATALOG.contentGuidance.length).toBeGreaterThan(0);
  for (const suggestion of OPENUI_CATALOG.contentGuidance) {
    expect(typeof suggestion).toBe("string");
    expect(suggestion).not.toMatch(/root\s*=|Query\(|Stack\(/);
  }
});

test("dashboard metrics and rankings retain their requested columns and optional captions", () => {
  const program = `totals = [{revenue:21714,count:14}]
root = Stack([
  Stack([QueryMetric("Revenue", totals, "revenue", "EUR", "Net"), QueryMetric("Invoices", totals, "count", {detail:"Issued invoices"}), Metric("Paid", 4)], {columns:3}),
  Stack([RankedBars([], "client", "value"), RankedBars([], "matter", "value")], {columns:2}),
  Stack([QueryMetric("Receivables", totals, "revenue", {currency:"EUR",detail:"Outstanding"})], 1)
])`;
  const parsed = createParser(openUILibrary.toJSONSchema()).parse(program);
  expect(parsed.meta.errors).toEqual([]);
  const html = renderToStaticMarkup(<OpenUIView locale="en" program={program} />);
  expect(html).toContain("repeat(3, minmax(0, 1fr))");
  expect(html).toContain("repeat(2, minmax(0, 1fr))");
  expect(html).toContain("Issued invoices");
  expect(html).toContain("€21,714.00");
  expect(html).toContain("Outstanding");
});

test("a live query can drive a standalone chart chosen by the agent", () => {
  const program = 'areas = Query("data", {name:"areas"}, {rows:[]})\nroot = RankedBars(areas.rows, "area", "count")';
  const parsed = createParser(openUILibrary.toJSONSchema()).parse(program);
  expect(parsed.meta.errors).toEqual([]);
  expect(parsed.meta.incomplete).toBe(false);
  expect(parsed.root?.typeName).toBe("RankedBars");
  expect(parsed.queryStatements).toHaveLength(1);
  expect(parsed.mutationStatements).toEqual([]);
});
test("streaming surfaces an unfinished string, then completes without losing its prefix", () => {
  const parser = createStreamingParser(openUILibrary.toJSONSchema());
  const partial = parser.push('root = Text("Client');
  expect(partial.root?.props.text).toBe("Client");
  expect(partial.meta.incomplete).toBe(true);
  const complete = parser.push(' engagements")');
  expect(complete.root?.props.text).toBe("Client engagements");
  expect(complete.meta.errors).toEqual([]);
  expect(complete.meta.incomplete).toBe(false);
});
test("bundled stock components render a report without a provider or network", () => {
  const html = renderToStaticMarkup(<OpenUIView program={'root = Stack([Heading("Portfolio",1), Metric("Clients",12), Card("Status", [Badge("Active","success"), Table([{title:"Aster",stage:"Diligence"}],[{field:"title",label:"Client"},{field:"stage",label:"Stage"}]), Board([{title:"Aster",stage:"Diligence"}],"stage","title")])])'} />);
  expect(html).toContain("Portfolio");
  expect(html).toContain("Aster");
  expect(html).toContain("Diligence");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("cdn.jsdelivr");
});
test("board lifecycle order is explicit and columns have separately scrolling card lists", () => {
  const html = renderToStaticMarkup(<OpenUIView program={'root = Board([{title:"Existing",stage:"Active"},{title:"New",stage:"Prospect"}],"stage","title",[],["Prospect","Active"])'} />);
  expect(html.indexOf("Prospect")).toBeLessThan(html.indexOf("Active"));
  expect(html).toContain("lw-view-board-items");
});
test("empty stages survive and move controls require a host capability, disabled during streaming", () => {
  const program = 'root = Board([{title:"Review",path:"Review.md",stage:"Draft"}],"stage","title",[],["Draft","Active","Archived"])';
  const boardActions = { canMove: () => true, move: async () => {} };
  const editable = renderToStaticMarkup(<OpenUIView program={program} boardActions={boardActions} />);
  expect(editable).toContain('aria-label="Move Review to stage"');
  expect(editable).toContain('draggable="true"');
  expect(editable).toContain('value="Archived"');
  expect(editable).toContain('No records');
  for (const html of [
    renderToStaticMarkup(<OpenUIView program={program} />),
    renderToStaticMarkup(<OpenUIView program={program} boardActions={boardActions} streaming />),
    renderToStaticMarkup(<OpenUIView program={program} boardActions={{ ...boardActions, canMove: () => false }} />),
  ]) {
    expect(html).not.toContain('<select');
    expect(html).not.toContain('draggable="true"');
  }
});

test("query-bound tables, charts and boards wait for rows instead of throwing during initial render", () => {
  const program = 'data = Query("data", {name:"rows"})\nroot = Stack([Table(data.rows,[{field:"name",label:"Name"}]), BarChart(data.rows,"name",["count"]), LineChart(data.rows,"name",["count"]), PieChart(data.rows,"name","count"), Board(data.rows,"stage","name")])';
  const html = renderToStaticMarkup(<OpenUIView program={program} query={async () => ({ rows: [] })} />);
  expect(html).toContain('role="status"');
  expect(html).not.toContain("No matching records");
});

test("imported rows with unavailable sources render their values without misleading links", () => {
  for (const component of ['Table(rows,[{field:"title",label:"Matter"}])', 'Board(rows,"stage","title")']) {
    const render = (available: boolean) => renderToStaticMarkup(<OpenUIView program={`rows = [{title:"Shared matter",path:"Matter.md",stage:"Active",__viewSourceAvailable:${available}}]\nroot = ${component}`} openSource={() => {}} />);
    expect(render(false)).toContain("Shared matter");
    expect(render(false)).not.toContain('class="lw-view-source"');
    expect(render(true)).toContain('class="lw-view-source"');
  }
});
