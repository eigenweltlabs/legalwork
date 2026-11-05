import { expect, test } from "bun:test";
import { createParser } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { MORNING_BRIEFING_TEMPLATE } from "./briefing-template";
import { OpenUIView, openUILibrary, safeActionHref } from "./runtime";

test("both briefing layouts parse and render the actual runtime catalog with source links", () => {
  const datasets: Record<string, unknown> = {
    matters: { total: 2, rows: [{ matter: "Aster", overdue: 1, due_today: 2, upcoming: 3 }, { matter: "Northstar", overdue: 0, due_today: 1, upcoming: 2 }] },
    emails: { total: 1, rows: [{ title: "Signature needed", detail: "Confirm the signatory", meta: "Client · 08:30", priority: "High", href: "https://mail.example.com/message/42" }] },
    tasks: { total: 1, rows: [{ title: "Review amendments", detail: "Aster · liability clause", href: "legalworktask://task-42" }] },
  };
  for (const program of [MORNING_BRIEFING_TEMPLATE.program, MORNING_BRIEFING_TEMPLATE.overviewProgram]) {
    const parser = createParser(openUILibrary.toJSONSchema());
    const parsed = parser.parse(program);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.meta.incomplete).toBe(false);
    const resolved = program.replace(/^(\w+) = Query\([^\n]*\)$/gm, (_, name: string) => `${name} = ${JSON.stringify(datasets[name])}`);
    expect(parser.parse(resolved).meta.errors).toEqual([]);
    const html = renderToStaticMarkup(<OpenUIView program={resolved} />);
    expect(html).toContain("Actions by matter");
    if (program === MORNING_BRIEFING_TEMPLATE.program) {
      expect(html).toContain('href="https://mail.example.com/message/42"');
      expect(html).toContain('href="legalworktask://task-42"');
      expect(html).toContain("Confirm the signatory");
    }
  }
});

test("action links reject scripts, local files and credentials while empty states stay readable", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,hi", "file:///secret", "https://user:password@example.com", "//example.com", "legalworktask://bad?execute=yes"]) expect(safeActionHref(href)).toBe(false);
  expect(safeActionHref("https://mail.example.com/message/42")).toBe(true);
  const html = renderToStaticMarkup(<OpenUIView program={'root = Stack([ActionList([], "Nothing urgent today"), ActionList([{title:"Unsafe",href:"javascript:alert(1)"}])])'} />);
  expect(html).toContain("Nothing urgent today");
  expect(html).toContain("Unsafe");
  expect(html).not.toContain("href=");
});
