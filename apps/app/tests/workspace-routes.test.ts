import { describe, expect, test } from "bun:test";
import { isSessionIndexRoute, parseWorkspaceSessionLink, sessionMainPage, wikiWorkspaceRoute } from "../src/react-app/shell/workspace-routes";

test("returned chat links navigate internally and reject external or non-chat destinations", () => {
  const route = "/workspace/ws_project-1/session/ses_review-1";
  expect(parseWorkspaceSessionLink(route)).toBe(route);
  expect(parseWorkspaceSessionLink(`#${route}`)).toBe(route);
  for (const href of ["https://example.com" + route, "//example.com" + route, "/workspace/a/settings", "/workspace/a/session/../settings", "javascript:alert(1)", route + "?redirect=https://example.com", "/workspace/%2e%2e/session/x"])
    expect(parseWorkspaceSessionLink(href)).toBeNull();
});

describe("main page navigation", () => {
  test("Tasks to Projects and browser history always resolve to a collapsed-sidebar page", () => {
    // Repeated entries represent renders while a route transition is pending
    // or workspace/session metadata refreshes. Neither can clear the page.
    const paths = ["/tasks", "/tasks", "/projects", "/projects", "/tasks", "/projects"];
    expect(paths.map(sessionMainPage)).toEqual(["tasks", "tasks", "projects", "projects", "tasks", "projects"]);
  });

  test("every global main pane is recognized on its first render", () => {
    expect(["/scheduled", "/calendar", "/workflows", "/recorder", "/wikis", "/evals"].map(sessionMainPage))
      .toEqual(["scheduled", "calendar", "workflows", "recorder", "wikis", "evals"]);
    expect(sessionMainPage("/workspace/project-a/evals")).toBe("evals");
  });

  test("project pages, Home and chats retain their own expanded sidebar layout", () => {
    const paths = [
      "/home", "/session", "/workspace/project-a/project",
      "/workspace/project-a/tasks", "/workspace/project-a/reviews", "/workspace/project-a/calendar",
      "/workspace/project-a/session", "/workspace/project-a/session/tasks", "/workspace/project-a/session/evals",
    ];
    for (const path of paths) expect(sessionMainPage(path)).toBeNull();
  });
});

describe("wiki workspace routes", () => {
  test("wiki roots and chats stay in global navigation without restoring a project chat", () => {
    const root = wikiWorkspaceRoute(" wiki / one ");
    const chat = wikiWorkspaceRoute(" wiki / one ", " session #1 ");
    expect(root).toBe("/wikis/wiki%20%2F%20one");
    expect(chat).toBe("/wikis/wiki%20%2F%20one/session/session%20%231");
    for (const route of [root, chat, root + "/"]) {
      expect(sessionMainPage(route)).toBe("wikis");
      expect(isSessionIndexRoute(route)).toBe(false);
    }
    expect(wikiWorkspaceRoute("wiki", " ")).toBe("/wikis/wiki");
  });
});
