import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarMenuSubButton } from "../src/components/ui/sidebar";
import { FolderIcon } from "../src/react-app/design-system/folder-icon";

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
