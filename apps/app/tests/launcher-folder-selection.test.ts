import { expect, test } from "bun:test";
import { launcherFolderTarget } from "../src/react-app/launcher/launcher-folder-picker";

test("folder confirmation uses the highlighted child without requiring navigation into it", () => {
  const folders = [{ path: "Contracts/Drafts", name: "Drafts" }, { path: "Contracts/Signed", name: "Signed" }];
  expect(launcherFolderTarget("Contracts", null, folders)).toEqual({ path: "Contracts", name: null });
  expect(launcherFolderTarget("Contracts", "Contracts/Drafts", folders)).toEqual(folders[0]);
  expect(launcherFolderTarget("Contracts", "Contracts/Signed", folders)).toEqual(folders[1]);
  expect(launcherFolderTarget("Contracts/Signed", null, [])).toEqual({ path: "Contracts/Signed", name: null });
});

test("a removed highlighted folder cannot silently confirm a different folder", () => {
  expect(launcherFolderTarget("Contracts", "Contracts/Deleted", [{ path: "Contracts/Signed", name: "Signed" }])).toBeNull();
  expect(launcherFolderTarget("", null, [])).toEqual({ path: "", name: null });
});
