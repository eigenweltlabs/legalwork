import { expect, test } from "bun:test";
import { ViewRecordSchema, type ViewOwner } from "@legalwork/types/views";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { rememberViewCopy, savedViewKey, verifyViewCopies, viewCopyCandidates, createViewCopyStore } from "../src/react-app/domains/views/view-save-locations";

const project: ViewOwner = { kind: "workspace", id: "project" };
const wiki: ViewOwner = { kind: "wiki", id: "wiki" };
const original = ViewRecordSchema.parse({ version: 1, title: "Cases", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Cases")', queries: {}, owner: project, id: "00000000-0000-4000-8000-000000000001", revision: "r1", updatedAt: 1 });
const copy = { ...original, owner: wiki, id: "00000000-0000-4000-8000-000000000002", title: "Team cases" };
const url = "https://worker.example";

test("copies remain discoverable from the chat, original, and renamed copy after reopening", () => {
  const scope = { key: `${url}:generation` };
  const first = rememberViewCopy([], url, scope, original);
  const second = rememberViewCopy(first, url, { key: savedViewKey(url, original), existing: original }, copy);
  // Persisted receipts contain only identities, never the dashboard's private content.
  const reopened = JSON.parse(JSON.stringify(second));
  expect(JSON.stringify(reopened)).not.toContain(original.program);
  for (const key of [scope.key, savedViewKey(url, original), savedViewKey(url, copy)]) {
    expect(viewCopyCandidates(reopened, url, { key }).map(view => view.owner)).toEqual([project, wiki]);
  }
  expect(viewCopyCandidates(reopened, "https://other-worker.example", { key: savedViewKey("https://other-worker.example", original) })).toEqual([]);
  expect(viewCopyCandidates(reopened, url, { key: savedViewKey(url, { ...original, revision: "edited" }) })).toEqual([]);
});

test("copying an existing untracked file includes the original and retains further destinations", () => {
  const scope = { key: savedViewKey(url, original), existing: original };
  const first = rememberViewCopy([], url, scope, copy);
  const third = { ...copy, owner: { kind: "workspace", id: "other" } satisfies ViewOwner, id: "00000000-0000-4000-8000-000000000003" };
  const second = rememberViewCopy(first, url, { key: savedViewKey(url, copy), existing: copy }, third);
  expect(viewCopyCandidates(second, url, scope)).toHaveLength(3);
  expect(rememberViewCopy(second, url, scope, original)[0].views).toHaveLength(3);
});

test("only actual saved revisions count; deletion, denied access, and edits reopen that destination", async () => {
  let state: "present" | "deleted" | "denied" | "edited" | "unavailable" = "present";
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname.includes(original.id)) return Response.json(original);
    if (state === "deleted" || state === "denied") return Response.json({ code: "view_unavailable", message: "Unavailable" }, { status: state === "deleted" ? 404 : 403 });
    if (state === "unavailable") return Response.json({ code: "server_error", message: "Disconnected" }, { status: 503 });
    return Response.json(state === "edited" ? { ...copy, revision: "changed" } : copy);
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "test" });
    expect((await verifyViewCopies(client, [original, copy])).map(view => view.owner)).toEqual([project, wiki]);
    for (const next of ["deleted", "denied", "edited"] satisfies (typeof state)[]) {
      state = next;
      expect((await verifyViewCopies(client, [original, copy])).map(view => view.owner)).toEqual([project]);
    }
    state = "unavailable";
    await expect(verifyViewCopies(client, [original, copy])).rejects.toMatchObject({ status: 503 });
  } finally { server.stop(true); }
});


test("saved locations survive the real persistence and rehydration path", async () => {
  const data = new Map<string, string>();
  const store = createViewCopyStore(() => ({
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  }));
  const scope = { key: savedViewKey(url, original), existing: original };
  store.getState().remember(url, scope, copy);
  const serialized = data.get("legalwork.view-copy-locations")!;
  store.setState({ groups: [] });
  data.set("legalwork.view-copy-locations", serialized);
  await store.persist.rehydrate();
  expect(viewCopyCandidates(store.getState().groups, url, scope).map(view => view.owner)).toEqual([project, wiki]);
  store.setState({ groups: [] });
});
