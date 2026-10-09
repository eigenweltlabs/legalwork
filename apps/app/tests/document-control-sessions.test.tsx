import { documentControlTarget } from "../src/react-app/domains/session/panel/document-control-target";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentControlSessions, useDocumentControlSessions } from "../src/react-app/shell/control/document-control-sessions";
import { isDocumentReadTool } from "../src/react-app/domains/session/artifacts/document-agent-read";

function Scope({ request }: { request: string }) {
  const ids = useDocumentControlSessions("legacy-chat");
  return <span>{ids.includes(request) ? "allowed" : "denied"}</span>;
}
test("explicit project chat membership replaces the layout/legacy id", () => {
  for (const request of ["left-chat", "right-chat"]) expect(renderToStaticMarkup(<DocumentControlSessions sessionIds={["left-chat", "right-chat"]}><Scope request={request} /></DocumentControlSessions>)).toContain("allowed");
  for (const request of ["other-project-chat", "legacy-chat", "workspace:project-a"]) expect(renderToStaticMarkup(<DocumentControlSessions sessionIds={["left-chat", "right-chat"]}><Scope request={request} /></DocumentControlSessions>)).toContain("denied");
  expect(renderToStaticMarkup(<Scope request="legacy-chat" />)).toContain("allowed");
  expect(renderToStaticMarkup(<DocumentControlSessions sessionIds={[]}><Scope request="legacy-chat" /></DocumentControlSessions>)).toContain("denied");
});
test("read-only agent access allows known reads and fails closed for mutations and unknown tools", () => {
  for (const name of ["read_document", "read_selection", "read_changes", "read_comments", "find_text"]) expect(isDocumentReadTool("docx", name)).toBe(true);
  for (const name of ["read", "read_presentation", "preview"]) expect(isDocumentReadTool("office", name)).toBe(true);
  const formats: Array<"docx" | "office"> = ["docx", "office"];
  for (const format of formats) for (const name of ["save", "prepare_file_edit", "suggest_change", "add_comment", "accept_changes", "reject_changes", "write", "replace_text", "add_slide", "unknown"]) expect(isDocumentReadTool(format, name)).toBe(false);
});

test("chat focus retains one visible document; hidden or closed documents are excluded", () => {
  expect(documentControlTarget(["doc-a", "doc-b"], "doc-b", "doc-a")).toBe("doc-b");
  expect(documentControlTarget(["doc-a", "doc-b"], "chat-a", "doc-b")).toBe("doc-b");
  expect(documentControlTarget(["doc-a"], "chat-a", "doc-b")).toBe("doc-a");
  expect(documentControlTarget([], "chat-a", "doc-b")).toBeNull();
});
