import { afterEach, expect, spyOn, test } from "bun:test";
import { dropboxAdapter } from "./dropbox.js";
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
test("Dropbox resolves a shared native folder ID in each member's namespace and enforces the configured root", async () => {
  let namespace = "owner-root";
  let moved = false;
  let denied = false;
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (...[input, init]: Parameters<typeof fetch>) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("get_current_account")) return Response.json({ root_info: { root_namespace_id: namespace } });
    expect(new Headers(init?.headers).get("Dropbox-API-Path-Root")).toContain(namespace);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (denied) return new Response(null, { status: 403 });
    return Response.json({ ".tag": "folder", id: "id:shared-folder", name: "Renamed", path_display: moved ? "/Other/Renamed" : body.path === "id:shared-folder" ? "/Firm/Renamed" : "/Firm/Original" });
  }, globalThis.fetch));
  restore = () => mock.mockRestore();
  const owner = await dropboxAdapter({ kind: "oauth", provider: "dropbox", root: "/Firm" }, async () => "owner-token");
  const reference = await owner.folderReference!("Original");
  expect(reference.id).toBe("id:shared-folder");
  namespace = "member-root";
  const member = await dropboxAdapter({ kind: "oauth", provider: "dropbox", root: "/Firm" }, async () => "member-token");
  expect(await member.resolveFolder!(reference)).toBe("Renamed");
  moved = true;
  await expect(member.resolveFolder!(reference)).rejects.toMatchObject({ status: 403 });
  denied = true;
  await expect(member.resolveFolder!(reference)).rejects.toMatchObject({ status: 403 });
});
test("a Dropbox account-root reference cannot silently resolve to another account", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ root_info: { root_namespace_id: "member-root" } }), globalThis.fetch));
  restore = () => mock.mockRestore();
  const member = await dropboxAdapter({ kind: "oauth", provider: "dropbox", root: "" }, async () => "member-token");
  await expect(member.resolveFolder!({ path: "", name: "Dropbox", namespace: "owner-root" })).rejects.toMatchObject({ code: "storage_namespace_changed" });
});
