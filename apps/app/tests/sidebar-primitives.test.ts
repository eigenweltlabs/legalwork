import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarMenuSubButton } from "../src/components/ui/sidebar";
import { FolderIcon } from "../src/react-app/design-system/folder-icon";

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
