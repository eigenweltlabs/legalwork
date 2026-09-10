import { expect, test } from "bun:test";
import {
  restorePanelLayout,
  setFileSidebarState,
  setSidePanelState,
  useUiStateStore,
} from "../src/react-app/shell/ui-state-store";

test("opening and closing a viewer leaves either file sidebar selected", () => {
  const initial = { ...useUiStateStore.getState(), sidePanelState: {}, fileSidebarState: {} };
  for (const sidebar of ["memory", "files"] satisfies ("memory" | "files")[]) {
    const browsing = setFileSidebarState(initial, "chat", sidebar);
    const previewing = setSidePanelState(browsing, "chat", "panel");
    expect(previewing.fileSidebarState.chat).toBe(sidebar);
    expect(setSidePanelState(previewing, "chat", null).fileSidebarState.chat).toBe(sidebar);
    expect(setFileSidebarState(previewing, "chat", null).sidePanelState.chat).toBe("panel");
    expect(setFileSidebarState(previewing, "chat", sidebar === "memory" ? "files" : "memory").sidePanelState.chat).toBe(
      "panel",
    );
    expect(setFileSidebarState(previewing, "other-chat", "files").fileSidebarState.chat).toBe(sidebar);
  }
});

test("restores existing single-pane choices into independent navigation without opening a viewer", () => {
  const previous = { sidePanelState: { one: "memory", two: "files", three: "panel" } } satisfies Parameters<
    typeof restorePanelLayout
  >[0];
  expect(restorePanelLayout(previous)).toEqual({
    sidePanelState: { one: null, two: null, three: "panel" },
    fileSidebarState: { one: "memory", two: "files" },
  });
  expect(previous.sidePanelState.one).toBe("memory");
});

test("preserves independent viewer and navigation choices across persisted-state reloads", () => {
  const layout = {
    sidePanelState: { one: "panel", two: "memory" },
    fileSidebarState: { one: "files", two: null },
  } satisfies Parameters<typeof restorePanelLayout>[0];
  expect(restorePanelLayout(JSON.parse(JSON.stringify(layout)))).toEqual({
    sidePanelState: { one: "panel", two: null },
    fileSidebarState: { one: "files", two: null },
  });
});
