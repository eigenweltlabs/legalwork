import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarMenuSubButton } from "../src/components/ui/sidebar";
import { FolderIcon } from "../src/react-app/design-system/folder-icon";

import type { WorkspaceSessionGroup } from "../src/app/types";
import { allProjectSessions } from "../src/react-app/domains/session/sidebar/session-project-hover";
import { getRecentProjectSessions, type SessionListItem } from "../src/react-app/domains/session/sidebar/utils";

describe("sidebar accessibility", () => {
  test("session actions are native buttons and expose the current page", () => {
    const html = renderToStaticMarkup(
      React.createElement(SidebarMenuSubButton, {
        isActive: true,
        "aria-current": "page",
        children: "Review agreement",
      }),
    );

    expect(html).toMatch(/^<button\b/);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('tabindex="-1"');
  });

  test("folder assets keep their paint references isolated in a list", () => {
    const html = renderToStaticMarkup(
      React.createElement(React.Fragment, null,
        React.createElement(FolderIcon),
        React.createElement(FolderIcon, { open: true }),
      ),
    );
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
    const paintReferences = Array.from(html.matchAll(/url\(#([^)]+)\)/g), (match) => match[1]);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(paintReferences.every((reference) => ids.includes(reference))).toBe(true);
    expect(html.match(/aria-hidden="true"/g)?.length).toBe(2);
  });
});


describe("project recent sessions", () => {
  test("shows the five latest active conversations without changing their stored order", () => {
    const sessions: SessionListItem[] = Array.from({ length: 8 }, (_, index) => ({
      id: `session-${index}`, title: `Chat ${index}`, time: { created: index, updated: index },
    }));
    sessions.push({ id: "archived", title: "Archived", time: { updated: 100, archived: 1 } });
    sessions.push({ id: "child", title: "Subagent", parentID: "session-7", time: { updated: 99 } });
    sessions[0].time = { created: 0, updated: 20 };
    const originalOrder = sessions.map((session) => session.id);
    expect(getRecentProjectSessions(sessions).map((session) => session.id)).toEqual([
      "session-0", "session-7", "session-6", "session-5", "session-4",
    ]);
    expect(sessions.map((session) => session.id)).toEqual(originalOrder);
    expect(getRecentProjectSessions([])).toEqual([]);
  });
});


describe("current conversation in the sidebar", () => {
  const group: WorkspaceSessionGroup = {
    workspace: { id: "project-a", name: "Project A", path: "/project-a" },
    status: "ready",
    sessions: Array.from({ length: 20 }, (_, index) => ({
      id: `session-${index}`, title: `Chat ${index}`, time: { updated: index },
    })),
  };

  test("puts the open conversation above both preview limits without mutating saved order", () => {
    const otherGroup: WorkspaceSessionGroup = {
      workspace: { id: "project-b", name: "Project B", path: "/project-b" },
      status: "ready",
      sessions: [{ id: "newer-elsewhere", time: { updated: 1000 } }],
    };
    const original = group.sessions.map(session => session.id);
    const recent = allProjectSessions([otherGroup, group], undefined, "session-0").slice(0, 10);
    const project = allProjectSessions([group], undefined, "session-0").slice(0, 5);
    expect(recent[0].session.id).toBe("session-0");
    expect(project[0].session.id).toBe("session-0");
    expect(recent[1].session.id).toBe("newer-elsewhere");
    expect(project[1].session.id).toBe("session-19");
    expect(group.sessions.map(session => session.id)).toEqual(original);
  });

  test("also surfaces the current child conversation and follows a session switch", () => {
    const withChild = { ...group, sessions: [...group.sessions, { id: "child", parentID: "session-0", time: { updated: 0 } }] };
    expect(allProjectSessions([withChild], undefined, "child")[0].session.id).toBe("child");
    expect(allProjectSessions([withChild], undefined, "session-2")[0].session.id).toBe("session-2");
    expect(allProjectSessions([withChild]).some(({ session }) => session.id === "child")).toBe(false);
  });
});
