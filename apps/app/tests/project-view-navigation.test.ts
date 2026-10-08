import { describe, expect, test } from "bun:test";
import { acceptsProjectViewDrag, readProjectViewDrag, startProjectViewDrag } from "../src/react-app/domains/session/sidebar/project-view-drag";
import { projectViewFromPath, workspaceViewRoute } from "../src/react-app/shell/workspace-routes";
import type { ProjectView } from "../src/react-app/domains/session/panel/project-view";

// Native drag data is protected during dragover and readable only during drop.
function payload() {
  const entries = new Map<string, string>();
  const data: Pick<DataTransfer, "types" | "effectAllowed" | "getData" | "setData"> = {
    get types() { return [...entries.keys()]; },
    effectAllowed: "uninitialized",
    getData: (key: string) => entries.get(key) ?? "",
    setData: (key: string, value: string) => { entries.set(key, value); },
  };
  return data;
}

describe("project view navigation", () => {
  const views: ProjectView[] = ["home", "calendar", "tasks", "reviews", "files", "sessions"];
  for (const view of views) {
    test(`${view} has an unambiguous project route`, () => {
      const route = workspaceViewRoute("project / a", view);
      expect(projectViewFromPath(route)).toBe(view);
      expect(projectViewFromPath(`${route}/`)).toBe(view);
    });
  }
  test("global pages and chat routes are not project overviews", () => {
    for (const path of ["/home", "/tasks", "/files", "/workspace/a/session", "/workspace/a/session/sessions", "/workspace/a/settings/files"]) {
      expect(projectViewFromPath(path)).toBeUndefined();
    }
  });
  test("drop validation rejects foreign and malformed views", () => {
    const data = payload();
    startProjectViewDrag(data, "project-a", "files");
    expect(readProjectViewDrag(data, "project-a")).toBe("files");
    expect(readProjectViewDrag(data, "project-b")).toBeNull();
    data.setData("application/x-legalwork-project-view", "settings");
    expect(readProjectViewDrag(data, "project-a")).toBeNull();
    data.setData("application/x-legalwork-project-view", "files");
    data.setData("application/x-legalwork-project-view-project-a", "project-b");
    expect(readProjectViewDrag(data, "project-a")).toBeNull();
  });
  test("page drags do not cross projects or accept file and chat payloads", () => {
    const data = { types: ["application/x-legalwork-project-view", "application/x-legalwork-project-view-project-a"] };
    expect(acceptsProjectViewDrag(data, "project-a")).toBe(true);
    expect(acceptsProjectViewDrag(data, "project-b")).toBe(false);
    expect(acceptsProjectViewDrag({ types: ["Files", "application/x-legalwork-session-id"] }, "project-a")).toBe(false);
  });
});
