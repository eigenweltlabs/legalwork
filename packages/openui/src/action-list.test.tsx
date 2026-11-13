import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenUIView, safeActionHref } from "./runtime";

test("action lists render source links and their supporting detail", () => {
  const program = 'root = ActionList([{title:"Signature needed",detail:"Confirm the signatory",href:"https://mail.example.com/message/42"},{title:"Review amendments",href:"legalworktask://task-42"}])';
  const html = renderToStaticMarkup(<OpenUIView program={program} />);
  expect(html).toContain('href="https://mail.example.com/message/42"');
  expect(html).toContain('href="legalworktask://task-42"');
  expect(html).toContain("Confirm the signatory");
});

test("action links reject scripts, local files and credentials while empty states stay readable", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,hi", "file:///secret", "https://user:password@example.com", "//example.com", "legalworktask://bad?execute=yes"]) expect(safeActionHref(href)).toBe(false);
  expect(safeActionHref("https://mail.example.com/message/42")).toBe(true);
  const html = renderToStaticMarkup(<OpenUIView program={'root = Stack([ActionList([], "Nothing urgent today"), ActionList([{title:"Unsafe",href:"javascript:alert(1)"}])])'} />);
  expect(html).toContain("Nothing urgent today");
  expect(html).toContain("Unsafe");
  expect(html).not.toContain("href=");
});
