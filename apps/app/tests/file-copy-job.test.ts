import { afterEach, expect, mock, test } from "bun:test";
import { fileCopyJobs, startFileCopy } from "../src/react-app/domains/workspace/file-copy-job";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";

afterEach(() => { usePanelTabStore.setState({ sessions: {} }); fileCopyJobs.setState({ entries: {} }); });
test("copy opens before IO and retries inside the same tab after failure", async () => {
  const store = usePanelTabStore.getState();
  const copy = mock(async () => {
    expect(usePanelTabStore.getState().sessions["workspace:copy"].tabs).toHaveLength(1);
    throw new Error("Offline");
  });
  await startFileCopy("report.pdf", tab => store.openTab("workspace:copy", tab), copy);
  const before = usePanelTabStore.getState().sessions["workspace:copy"];
  const id = before.tabs[0].id;
  expect(fileCopyJobs.getState().entries[id]).toMatchObject({ status: "failed", error: "Offline" });
  const retry = mock(async () => ({ path: "report.pdf" }));
  copy.mockImplementation(retry);
  await fileCopyJobs.getState().entries[id].retry();
  const after = usePanelTabStore.getState().sessions["workspace:copy"];
  expect(after.tabs).toHaveLength(1);
  expect(after.tabs[0]).toMatchObject({ id, value: "report.pdf", preview: "pdf" });
  expect(after.layout).toBe(before.layout);
  expect(fileCopyJobs.getState().entries[id]).toBeUndefined();
});
test("finishing a closed copy never resurrects tabs or changes another project's state", async () => {
  const store = usePanelTabStore.getState();
  store.openTab("workspace:other", { id: "chat", type: "chat", sessionId: "chat", label: "Chat" });
  const other = usePanelTabStore.getState().sessions["workspace:other"];
  let finish = (_file: { path: string }) => {};
  const copied = new Promise<{ path: string }>(resolve => { finish = resolve; });
  const running = startFileCopy("report.pdf", tab => store.openTab("workspace:copy", tab), () => copied);
  const tab = usePanelTabStore.getState().sessions["workspace:copy"].tabs[0];
  store.closeTab("workspace:copy", tab.id);
  finish({ path: "report.pdf" }); await running;
  expect(usePanelTabStore.getState().sessions["workspace:copy"].tabs).toHaveLength(0);
  expect(usePanelTabStore.getState().sessions["workspace:other"]).toBe(other);
  expect(fileCopyJobs.getState().entries[tab.id]).toBeUndefined();
});
