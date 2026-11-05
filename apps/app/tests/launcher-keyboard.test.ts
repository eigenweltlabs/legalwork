import { expect, test } from "bun:test";
import { enterTarget, escapeAction, footerVerb, isAskShortcut, isComposingKeyEvent, moveSelection, optionId, orderLauncherResults, reconcileSelection } from "../src/react-app/launcher/launcher-keyboard";
import type { LauncherSearchResult } from "@legalwork/types/launcher";

const items = [{ id: "a", primaryAction: "open" as const }, { id: "b", primaryAction: "attach" as const }, { id: "c", primaryAction: "run" as const }];
test("search can be sent directly while explicit Ask and chat drafts keep Shift+Enter for newlines", () => {
  expect(isAskShortcut({ key: "Enter", modifier: false, shift: true, mode: "search", command: false })).toBe(true);
  for (const mode of ["ask", "conversation"] as const) {
    expect(isAskShortcut({ key: "Enter", modifier: false, shift: true, mode, command: false })).toBe(false);
    expect(isAskShortcut({ key: "Enter", modifier: true, shift: false, mode, command: false })).toBe(true);
  }
  expect(isAskShortcut({ key: "Enter", modifier: false, shift: false, mode: "search", command: false })).toBe(false);
  expect(isAskShortcut({ key: "Enter", modifier: true, shift: false, mode: "command", command: true })).toBe(false);
});
test("streaming results cannot move a user selection or change the action under Enter", () => {
  expect(reconcileSelection({ id: null, source: "auto" }, items)).toEqual({ id: "a", source: "auto" });
  const user = moveSelection({ id: "a", source: "auto" }, items, 1);
  expect(user).toEqual({ id: "b", source: "user" });
  expect(reconcileSelection(user, [{ id: "z" }, ...items])).toEqual(user);
  expect(reconcileSelection(user, [{ id: "a" }, { id: "c" }])).toEqual({ id: null, source: "user" });
  expect(enterTarget({ id: null, source: "user" }, items)).toBeNull();
  expect(enterTarget(user, items)?.id).toBe("b");
  expect(moveSelection({ id: "c", source: "user" }, items, 1).id).toBe("c");
  expect(moveSelection({ id: null, source: "user" }, items, -1).id).toBe("c");
  expect(moveSelection({ id: "a", source: "user" }, [], 1)).toEqual({ id: null, source: "user" });
});

test("Escape goes back through menu, conversation, query and filter before closing", () => {
  expect(escapeAction({ overlayOpen: true, detail: true, query: true, category: true })).toBe("overlay");
  expect(escapeAction({ overlayOpen: false, detail: true, query: true, category: true })).toBe("view");
  expect(escapeAction({ overlayOpen: false, detail: false, query: true, category: true })).toBe("query");
  expect(escapeAction({ overlayOpen: false, detail: false, query: false, category: true })).toBe("filter");
  expect(escapeAction({ overlayOpen: false, detail: false, query: false, category: false })).toBe("panel");
  expect(isComposingKeyEvent({ isComposing: true })).toBe(true);
  expect(isComposingKeyEvent({ keyCode: 229 })).toBe(true);
  expect(isComposingKeyEvent({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
  expect(footerVerb(items[1], "search")).toBe("attach");
  expect(footerVerb(items[2], "command")).toBe("run");
  expect(footerVerb(null, "search")).toBe("none");
  expect(footerVerb(null, "ask")).toBe("ask");
});

test("keyboard selection follows displayed groups even when responses arrive out of order", () => {
  const result = (id: string, kind: LauncherSearchResult["kind"]): LauncherSearchResult => ({ id, kind, sourceId: "local", workspaceId: "w", title: id, match: "prefix", score: 1, actions: ["open"] });
  const ordered = orderLauncherResults([result("chat", "chats"), result("file-a", "files"), result("project", "projects"), result("file-b", "files")]);
  expect(ordered.map(item => item.id)).toEqual(["project", "file-a", "file-b", "chat"]);
  expect(moveSelection({ id: "file-a", source: "user" }, ordered, 1).id).toBe("file-b");
  expect(optionId("files\u0000local\u0000Müller.pdf")).not.toContain("\u0000");
});

test("home and command rows arriving later become selectable without displacing a manual choice", () => {
  const rows = [{ id: "new" }, { id: "saved" }, { id: "recent" }];
  expect(reconcileSelection({ id: null, source: "auto" }, rows).id).toBe("new");
  const selected = moveSelection({ id: "new", source: "auto" }, rows, 1);
  expect(enterTarget(selected, rows)?.id).toBe("saved");
  expect(reconcileSelection(selected, [{ id: "resume" }, ...rows])).toEqual(selected);
});
