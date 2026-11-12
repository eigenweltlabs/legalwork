import { expect, spyOn, test } from "bun:test";
import { createLegalworkServerClient, LegalworkServerError } from "../src/app/lib/legalwork-server";
import { isProjectRemoving, retainRemovingProjects, waitForProjectRemoval } from "../src/app/lib/project-removal-state";
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
  const removal = removeProjectFromSidebar({ baseUrl: "http://removal.test", deleteWorkspace: async () => { deleted.resolve(); return removedResponse; } }, "removed",
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
  await removeProjectFromSidebar({ baseUrl: "http://removal.test", deleteWorkspace: async () => { throw new LegalworkServerError(404, "workspace_not_found", "Gone"); } }, "removed",
    () => { removed = true; }, async () => {}, async () => {});
  expect(removed).toBe(true);
});

test("a rejected removal preserves the project and avoids desktop cleanup", async () => {
  const steps: string[] = [];
  await expect(removeProjectFromSidebar({ baseUrl: "http://removal.test", deleteWorkspace: async () => { throw new LegalworkServerError(403, "forbidden", "Denied"); } }, "kept",
    () => { steps.push("remove"); }, async () => { steps.push("forget"); }, async () => { steps.push("refresh"); })).rejects.toThrow("Denied");
  expect(steps).toEqual([]);
});

test("desktop cleanup failure still refreshes the successfully removed registry", async () => {
  const steps: string[] = [];
  await expect(removeProjectFromSidebar({ baseUrl: "http://removal.test", deleteWorkspace: async () => removedResponse }, "removed",
    () => { steps.push("remove"); }, async () => { throw new Error("Desktop unavailable"); }, async () => { steps.push("refresh"); })).rejects.toThrow("Desktop unavailable");
  expect(steps).toEqual(["remove", "refresh"]);
});

test("pending deletion retains a loading row across registry refreshes and ignores duplicate removal", async () => {
  const reply = deferred(), cleanup = deferred(), cleanupStarted = deferred();
  const server = "http://pending-removal.test";
  const project = { id: "pending", name: "Pending project" }, kept = { id: "kept", name: "Kept project" };
  let rows = [project, kept], requests = 0;
  const client = { baseUrl: server, deleteWorkspace: async () => { requests++; await reply.promise; return removedResponse; } };
  const removeRow = () => { rows = rows.filter(row => row.id !== project.id); };
  const refresh = async () => { rows = retainRemovingProjects(server, [project, kept], rows); };
  const removal = removeProjectFromSidebar(client, project.id, removeRow, async () => { cleanupStarted.resolve(); await cleanup.promise; }, refresh);
  try {
    expect(isProjectRemoving(project.id)).toBe(true);
    // The server registry already omits the project, but DELETE has not replied.
    rows = retainRemovingProjects(server, [kept], rows);
    expect(rows).toEqual([project, kept]);
    expect(retainRemovingProjects("http://other-server.test", [kept], rows)).toEqual([kept]);
    await removeProjectFromSidebar(client, project.id, removeRow, async () => {}, refresh);
    expect(requests).toBe(1);
    reply.resolve();
    await cleanupStarted.promise;
    expect(rows).toEqual([kept]);
    expect(isProjectRemoving(project.id)).toBe(true);
  } finally {
    reply.resolve(); cleanup.resolve(); await removal;
  }
  expect(isProjectRemoving(project.id)).toBe(false);
});

test("project reads pause and an in-flight 404 is cancelled after successful removal", async () => {
  const reply = deferred(), oldRead = deferred(), oldReadStarted = deferred();
  const client = createLegalworkServerClient({ baseUrl: "http://reads-removal.test", token: "test" });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let requests = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    requests++; oldReadStarted.resolve(); await oldRead.promise;
    return Response.json({ code: "workspace_not_found", message: "Gone" }, { status: 404 });
  }, { preconnect: fetch.preconnect }));
  const earlierRead = client.listSessions("removed");
  await oldReadStarted.promise;
  const removal = removeProjectFromSidebar({ baseUrl: client.baseUrl, deleteWorkspace: async () => { await reply.promise; return removedResponse; } }, "removed", () => {}, async () => {}, async () => {});
  const heldRead = client.storageRoots("removed");
  const results = Promise.allSettled([earlierRead, heldRead]);
  try {
    oldRead.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toBe(1);
    reply.resolve();
    await removal;
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.name).toBe("AbortError");
    }
    expect(requests).toBe(1);
  } finally {
    oldRead.resolve(); reply.resolve(); await removal; await results;
    fetchSpy.mockRestore(); warn.mockRestore();
  }
});

test("failed removal resumes held reads and leaves the row registered", async () => {
  const reply = deferred();
  const client = createLegalworkServerClient({ baseUrl: "http://rejected-removal.test", token: "test" });
  let requests = 0, rowRemoved = false;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    requests++; return Response.json({ roots: [] });
  }, { preconnect: fetch.preconnect }));
  const removal = removeProjectFromSidebar({ baseUrl: client.baseUrl, deleteWorkspace: async () => { await reply.promise; throw new LegalworkServerError(403, "forbidden", "Denied"); } }, "kept", () => { rowRemoved = true; }, async () => {}, async () => {});
  const rejected = removal.catch(error => error);
  const heldRead = client.storageRoots("kept");
  try {
    await Promise.resolve(); expect(requests).toBe(0);
    reply.resolve(); expect((await rejected).message).toBe("Denied");
    expect(await heldRead).toEqual({ roots: [] });
    expect(requests).toBe(1);
    expect(rowRemoved).toBe(false);
    expect(isProjectRemoving("kept")).toBe(false);
  } finally {
    reply.resolve(); await removal.catch(() => {}); await heldRead;
    fetchSpy.mockRestore();
  }
});

test("a held read can be cancelled while deletion is still waiting", async () => {
  const reply = deferred();
  const removal = removeProjectFromSidebar({ baseUrl: "http://cancel-removal.test", deleteWorkspace: async () => { await reply.promise; return removedResponse; } }, "removed", () => {}, async () => {}, async () => {});
  try {
    const controller = new AbortController();
    const read = waitForProjectRemoval("http://cancel-removal.test", "removed", controller.signal);
    controller.abort();
    await expect(read).rejects.toThrow();
    expect(isProjectRemoving("removed")).toBe(true);
  } finally { reply.resolve(); await removal; }
});
