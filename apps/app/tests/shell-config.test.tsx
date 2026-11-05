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
  expect(config?.chatSectionOrder).toEqual(["navNewChat", "sectionPinned", "sectionPinnedProjects", "sectionSharedProjects", "sectionProjects", "sectionRecent"]);
});

test("Assistant is visible for existing profiles and its visibility choice survives reload", () => {
  expect(readConfig(null)?.navAssistant).toBe(true);
  expect(readConfig({ navNewChat: false })?.navAssistant).toBe(true);
  expect(readConfig({ navAssistant: false })?.navAssistant).toBe(false);
  expect(readConfig({ navAssistant: true })?.navAssistant).toBe(true);
});

test("older sidebar preferences gain pinned projects without reordering saved sections", () => {
  const savedOrder = ["sectionRecent", "sectionProjects", "navNewChat", "sectionPinned"];
  const config = readConfig({ chatSectionOrder: savedOrder, sectionProjects: false });
  expect(config?.sectionPinnedProjects).toBe(true);
  expect(config?.sectionProjects).toBe(false);
  expect(config?.chatSectionOrder).toEqual(["sectionRecent", "sectionSharedProjects", "sectionProjects", "navNewChat", "sectionPinned", "sectionPinnedProjects"]);
  expect(readConfig({ chatSectionOrder: ["sectionPinned", "sectionRecent", "sectionProjects", "navNewChat"] })?.chatSectionOrder)
    .toEqual(["sectionPinned", "sectionPinnedProjects", "sectionRecent", "sectionSharedProjects", "sectionProjects", "navNewChat"]);
});

test("the saved visibility and position of pinned projects survive a reload", () => {
  const savedOrder = ["sectionPinnedProjects", "sectionRecent", "sectionProjects", "sectionSharedProjects", "sectionPinned", "navNewChat"];
  const config = readConfig({ chatSectionOrder: savedOrder, sectionPinnedProjects: false });
  expect(config?.sectionPinnedProjects).toBe(false);
  expect(config?.chatSectionOrder).toEqual(savedOrder);
});


test("older sidebar preferences gain Wiki without changing existing choices", () => {
  const savedOrder = ["navHome", "navRecorder", "navEvaluations", "navProjects", "navCalendar", "navTasks", "navScheduled", "navWorkflows"];
  const config = readConfig({ navOrder: savedOrder, navRecorder: false, navTasks: false });
  expect(config?.navWikis).toBe(true);
  expect(config?.navOrder.filter(key => key !== "navWikis")).toEqual(savedOrder);
  expect(config?.navOrder.indexOf("navWikis")).toBe((config?.navOrder.indexOf("navRecorder") ?? -1) + 1);
  expect(config?.navRecorder).toBe(false);
  expect(config?.navTasks).toBe(false);
});

test("the saved Wiki visibility and position survive a reload", () => {
  const defaults = readConfig(null);
  expect(defaults?.navWikis).toBe(true);
  expect(defaults?.navOrder).toContain("navWikis");
  const savedOrder = ["navWikis", ...(defaults?.navOrder.filter(key => key !== "navWikis") ?? [])];
  const config = readConfig({ navOrder: savedOrder, navWikis: false });
  expect(config?.navWikis).toBe(false);
  expect(config?.navOrder).toEqual(savedOrder);
});
