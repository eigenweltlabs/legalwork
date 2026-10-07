import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShellConfigProvider, useShellConfig, type ShellConfig } from "../src/react-app/shell/shell-config";

function readConfig(saved: object | null) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let config: ShellConfig | undefined;
  function ReadConfig() {
    config = useShellConfig().config;
    return null;
  }
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: () => saved === null ? null : JSON.stringify(saved) },
    } });
    renderToStaticMarkup(<ShellConfigProvider><ReadConfig /></ShellConfigProvider>);
    return config;
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("new sidebars enable pinned projects beside pinned chats", () => {
  const config = readConfig(null);
  expect(config?.sectionPinnedProjects).toBe(true);
  expect(config?.chatSectionOrder).toEqual(["navNewChat", "sectionPinned", "sectionPinnedProjects", "sectionProjects", "sectionRecent"]);
});

test("older sidebar preferences gain pinned projects without reordering saved sections", () => {
  const savedOrder = ["sectionRecent", "sectionProjects", "navNewChat", "sectionPinned"];
  const config = readConfig({ chatSectionOrder: savedOrder, sectionProjects: false });
  expect(config?.sectionPinnedProjects).toBe(true);
  expect(config?.sectionProjects).toBe(false);
  expect(config?.chatSectionOrder).toEqual([...savedOrder, "sectionPinnedProjects"]);
  expect(readConfig({ chatSectionOrder: ["sectionPinned", "sectionRecent", "sectionProjects", "navNewChat"] })?.chatSectionOrder)
    .toEqual(["sectionPinned", "sectionPinnedProjects", "sectionRecent", "sectionProjects", "navNewChat"]);
});

test("the saved visibility and position of pinned projects survive a reload", () => {
  const savedOrder = ["sectionPinnedProjects", "sectionRecent", "sectionProjects", "sectionPinned", "navNewChat"];
  const config = readConfig({ chatSectionOrder: savedOrder, sectionPinnedProjects: false });
  expect(config?.sectionPinnedProjects).toBe(false);
  expect(config?.chatSectionOrder).toEqual(savedOrder);
});
