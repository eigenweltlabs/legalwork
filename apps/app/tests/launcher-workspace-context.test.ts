import { expect, test } from "bun:test";
import type { SessionPanelState } from "../src/react-app/domains/session/panel/panel-tab-store";
import { workspaceContextSnapshot } from "../src/react-app/launcher/workspace-context-model";
import { launcherOpenSchema } from "@legalwork/types/launcher";
import { namedCategoryQuery, categorySuggestions, normalizeLauncherAliases } from "../src/react-app/launcher/launcher-query";

const panel: Pick<SessionPanelState, "tabs" | "panes" | "focusedPaneId"> = {
  tabs: [
    { id: "local", type: "artifact", label: "A.md", value: "Contracts/A.md", preview: "markdown" },
    { id: "foreign", type: "artifact", label: "B.md", preview: "markdown", sourceProject: { projectId: "B", workspaceId: "B", name: "B.md", path: "Private/B.md" } },
    { id: "chat", type: "chat", label: "Review", sessionId: "session-A" },
  ],
  panes: [{ id: "left", activeTabId: "local", tabIds: ["local"] }, { id: "right", activeTabId: "foreign", tabIds: ["foreign"] }, { id: "bottom", activeTabId: "chat", tabIds: ["chat"] }],
  focusedPaneId: "right",
};
test("focused foreign document keeps its real source but asks and saves in the working project", () => {
  const result = workspaceContextSnapshot({ workspace: { id: "A", name: "Matter A" }, panel, selection: "Clause 7", now: 1 });
  expect(result.context).toMatchObject({ workspaceId: "A", paneId: "right", selection: "Clause 7", document: { workspaceId: "B", path: "Private/B.md" } });
  expect(result.context.folder).toBeUndefined();
  const local = workspaceContextSnapshot({ workspace: { id: "A", name: "Matter A" }, panel: { ...panel, focusedPaneId: "left" }, now: 2 });
  expect(local.context.folder).toBe("Contracts");
  expect(workspaceContextSnapshot({ workspace: { id: "A", name: "Matter A" }, panel, folder: "New work", now: 3 }).context.folder).toBe("New work");
});
test("focusing a chat keeps the last visible document but never mistakes chat selection for document text", () => {
  const result = workspaceContextSnapshot({ workspace: { id: "A", name: "Matter A" }, panel: { ...panel, focusedPaneId: "bottom" }, lastDocumentId: "foreign", selection: "Chat selection", now: 1 });
  expect(result.context).toMatchObject({ sessionId: "session-A", document: { workspaceId: "B" } });
  expect(result.context.selection).toBeUndefined();
  const closed = workspaceContextSnapshot({ workspace: { id: "A", name: "Matter A" }, panel: { ...panel, panes: panel.panes.filter(pane => pane.id !== "right"), focusedPaneId: "bottom" }, lastDocumentId: "foreign", now: 2 });
  expect(closed.context.document?.workspaceId).toBe("A");
});
test("file handoff validates destination data and category queries keep their type", () => {
  expect(launcherOpenSchema.safeParse({ source: { projectId: "B", workspaceId: "B", name: "B", path: "../secret" }, destination: "A" }).success).toBe(false);
  expect(namedCategoryQuery("doc Contract")).toEqual({ category: "files", rest: "Contract" });
  expect(categorySuggestions("do", normalizeLauncherAliases(null))).toContain("files");
  expect(namedCategoryQuery("doctrine")).toBeNull();
});
