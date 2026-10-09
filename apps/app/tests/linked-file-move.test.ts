import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { linkedFileMovePrompts, prepareLinkedFileMove } from "../src/react-app/domains/workspace/linked-file-move";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { projectFileTab } from "../src/react-app/domains/workspace/project-file-tab";
import type { ProjectFileLink } from "@legalwork/types/project-files";

afterEach(() => { mock.restore(); linkedFileMovePrompts.setState({ items: [] }); usePanelTabStore.setState({ sessions: {} }); });
function setup() {
  const client = createLegalworkServerClient({ baseUrl: "http://local.invalid" });
  const remote = createLegalworkServerClient({ baseUrl: "http://remote.invalid" });
  const source = { projectId: "original-project", workspaceId: "original-workspace", name: "note.md", path: "Folder/note.md" };
  const link: ProjectFileLink = { id: "link", name: "Custom name", folder: "References", createdAt: 1, source };
  const projects = [{ client, ...source, name: "Original" }, { client: remote, projectId: "reader", workspaceId: "reader-workspace", name: "Reader" }];
  spyOn(client, "projectFileLinks").mockResolvedValue({ links: [] });
  const read = spyOn(remote, "projectFileLinks").mockResolvedValue({ links: [link] });
  const write = spyOn(remote, "updateProjectFileLink").mockResolvedValue({ links: [] });
  const queries = new QueryClient();
  const decide = mock(async () => true);
  return { client, remote, source, link, projects, read, write, queries, decide };
}
test("cancel leaves all link metadata and readers untouched", async () => {
  const x = setup(); x.decide.mockResolvedValue(false);
  const finish = await prepareLinkedFileMove(x.projects, { client: x.client, workspaceId: x.source.workspaceId }, "Folder", "Renamed", x.queries, x.decide);
  expect(finish).toBeNull(); expect(x.decide).toHaveBeenCalledWith("Reader"); expect(x.write).not.toHaveBeenCalled();
});
test("moving an original relinks descendants through the destination endpoint and follows open readers", async () => {
  const x = setup();
  const sibling = { ...x.link, id: "sibling", source: { ...x.source, path: "Folder-other/note.md" } };
  x.read.mockResolvedValue({ links: [x.link, sibling] });
  usePanelTabStore.getState().openTab("workspace:reader", projectFileTab(x.source));
  const finish = await prepareLinkedFileMove(x.projects, { client: x.client, workspaceId: x.source.workspaceId }, "Folder", "Renamed", x.queries, x.decide);
  expect(x.write).not.toHaveBeenCalled();
  await finish?.();
  expect(x.write).toHaveBeenCalledTimes(1);
  expect(x.write).toHaveBeenCalledWith("reader-workspace", { ...x.link, source: { ...x.source, path: "Renamed/note.md" } });
  expect(usePanelTabStore.getState().sessions["workspace:reader"].tabs[0]).toMatchObject({ value: "Renamed/note.md", sourceProject: { path: "Renamed/note.md" } });
});
test("concurrent link rename, deletion and deliberate retargeting are preserved", async () => {
  const x = setup();
  x.read.mockResolvedValue({ links: [x.link, { ...x.link, id: "deleted" }, { ...x.link, id: "retargeted" }] });
  const finish = await prepareLinkedFileMove(x.projects, { client: x.client, workspaceId: x.source.workspaceId }, "Folder", "Renamed", x.queries, x.decide);
  const renamed = { ...x.link, name: "Renamed by colleague", folder: "Elsewhere" };
  x.read.mockResolvedValue({ links: [renamed, { ...x.link, id: "retargeted", source: { ...x.source, path: "Different.md" } }] });
  await finish?.();
  expect(x.write).toHaveBeenCalledTimes(1);
  expect(x.write).toHaveBeenCalledWith("reader-workspace", { ...renamed, source: { ...x.source, path: "Renamed/note.md" } });
});
test("metadata failure offers retry after the move without repeating filesystem IO", async () => {
  const x = setup();
  x.write.mockRejectedValueOnce(new Error("Offline"));
  const finish = await prepareLinkedFileMove(x.projects, { client: x.client, workspaceId: x.source.workspaceId }, "Folder", "Renamed", x.queries, x.decide);
  await finish?.();
  const prompt = linkedFileMovePrompts.getState().items[0];
  expect(prompt.names).toBe("Reader"); expect(prompt.repair).toBeDefined();
  await prompt.repair?.();
  expect(x.write).toHaveBeenCalledTimes(2); expect(x.decide).toHaveBeenCalledTimes(1);
});
test("unavailable link inventory fails closed and unrelated endpoint identities do not match", async () => {
  const x = setup(); x.read.mockRejectedValue(new Error("Offline"));
  await expect(prepareLinkedFileMove(x.projects, { client: x.client, workspaceId: x.source.workspaceId }, "Folder", "Renamed", x.queries, x.decide)).rejects.toThrow("Offline");
  expect(x.decide).not.toHaveBeenCalled(); expect(x.write).not.toHaveBeenCalled();
  await prepareLinkedFileMove(x.projects, { client: x.remote, workspaceId: x.source.workspaceId }, "Folder", "Renamed", x.queries, x.decide);
  expect(x.read).toHaveBeenCalledTimes(1);
});
