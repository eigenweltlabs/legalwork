import { expect, test } from "bun:test";
import { LegalworkServerError } from "../src/app/lib/legalwork-server";
import { removeProjectFromSidebar } from "../src/react-app/shell/project-removal";
import { createCoalescedRefresh } from "../src/react-app/shell/coalesced-refresh";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const removedResponse = { ok: true, deleted: true, persisted: true, activeId: "kept", items: [] };

test("a confirmed removal disappears while desktop cleanup is still waiting and invalidates an older list", async () => {
  const deleted = deferred(), oldList = deferred(), cleanup = deferred(), cleanupStarted = deferred();
  let rows = ["removed", "kept"], calls = 0;
  const refresh = createCoalescedRefresh(async current => {
    const list = ++calls === 1 ? ["removed", "kept"] : ["kept"];
    if (calls === 1) await oldList.promise;
    if (current()) rows = list;
  });
  const oldRefresh = refresh();
  await Promise.resolve();
  const removal = removeProjectFromSidebar({ deleteWorkspace: async () => { deleted.resolve(); return removedResponse; } }, "removed",
    () => { rows = rows.filter(id => id !== "removed"); },
    async () => { cleanupStarted.resolve(); await cleanup.promise; }, refresh);
  await deleted.promise;
  await cleanupStarted.promise;
  try {
    // The removed project must not remain as a row whose session request can become a 404 error.
    expect(rows).toEqual(["kept"]);
    oldList.resolve();
    await oldRefresh;
    expect(rows).toEqual(["kept"]);
  } finally {
    oldList.resolve(); cleanup.resolve(); await removal;
  }
});

test("an already removed server project still clears the local row", async () => {
  let removed = false;
  await removeProjectFromSidebar({ deleteWorkspace: async () => { throw new LegalworkServerError(404, "workspace_not_found", "Gone"); } }, "removed",
    () => { removed = true; }, async () => {}, async () => {});
  expect(removed).toBe(true);
});

test("a rejected removal preserves the project and avoids desktop cleanup", async () => {
  const steps: string[] = [];
  await expect(removeProjectFromSidebar({ deleteWorkspace: async () => { throw new LegalworkServerError(403, "forbidden", "Denied"); } }, "kept",
    () => { steps.push("remove"); }, async () => { steps.push("forget"); }, async () => { steps.push("refresh"); })).rejects.toThrow("Denied");
  expect(steps).toEqual([]);
});

test("desktop cleanup failure still refreshes the successfully removed registry", async () => {
  const steps: string[] = [];
  await expect(removeProjectFromSidebar({ deleteWorkspace: async () => removedResponse }, "removed",
    () => { steps.push("remove"); }, async () => { throw new Error("Desktop unavailable"); }, async () => { steps.push("refresh"); })).rejects.toThrow("Desktop unavailable");
  expect(steps).toEqual(["remove", "refresh"]);
});
