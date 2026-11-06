import { expect, test } from "bun:test";
import { createParser, createStreamingParser } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { OPENUI_CATALOG } from "./catalog";
import { OpenUIView, openUILibrary } from "./runtime";

test("the agent catalog example parses with the exact runtime component schemas", () => {
  const parsed = createParser(openUILibrary.toJSONSchema()).parse(OPENUI_CATALOG.example);
  expect(parsed.meta.errors).toEqual([]);
  expect(parsed.meta.incomplete).toBe(false);
  expect(parsed.root?.typeName).toBe("Stack");
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
