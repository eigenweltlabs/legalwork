import { afterEach, expect, spyOn, test } from "bun:test";
import { microsoftAdapter, microsoftProviders } from "./microsoft.js";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function graph(handler: (url: URL, init?: RequestInit) => Response) {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (...[input, init]: Parameters<typeof fetch>) => handler(new URL(input instanceof Request ? input.url : input), init), globalThis.fetch));
  restore = () => mock.mockRestore();
}
const root = { id: "root-id", name: "Documents", folder: {} };
test("Microsoft search stays inside the selected root and rejects foreign pagination", async () => {
  const requests: string[] = [];
  graph((url) => {
    requests.push(url.hostname);
    if (url.pathname === "/v1.0/me/drive") return Response.json({ id: "drive-id", webUrl: "https://onedrive.live.com" });
    if (url.pathname.endsWith("/root") || url.pathname.endsWith("/items/root-id")) return Response.json(root);
    if (url.pathname.includes("/search(")) return Response.json({ value: [
      { id: "inside", name: "matter.txt", file: {}, parentReference: { id: "root-id", driveId: "drive-id" } },
      { id: "outside", name: "matter.txt", file: {}, parentReference: { id: "root-id", driveId: "other-drive" } },
    ] });
    return Response.json({ value: [], "@odata.nextLink": "https://untrusted.example/steal?$skiptoken=x" });
  });
  const adapter = await microsoftAdapter({ kind: "oauth", provider: "onedrive", root: "" }, async () => "private-token");
  expect((await adapter.search!({ path: "", query: "matter", mode: "name" })).entries.map((entry) => entry.path)).toEqual(["matter.txt"]);
  await expect(adapter.list("")).rejects.toThrow("pagination");
  expect(new Set(requests)).toEqual(new Set(["graph.microsoft.com"]));
});
test("Microsoft uploads preserve annotation order and never send bearer tokens to transfer hosts", async () => {
  let uploaded = 0;
  graph((url, init) => {
    if (url.hostname === "my.microsoftpersonalcontent.com") {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      uploaded++;
      return Response.json({ id: "uploaded" }, { status: 201 });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
    if (url.pathname === "/v1.0/me/drive") return Response.json({ id: "drive-id", webUrl: "https://onedrive.live.com" });
    if (url.pathname.endsWith("/root") || url.pathname.endsWith("/items/root-id")) return Response.json(root);
    if (url.pathname.endsWith("/createUploadSession")) {
      expect(init?.body).toBe('{"item":{"@microsoft.graph.conflictBehavior":"fail","name":"matter.txt"}}');
      return Response.json({ uploadUrl: "https://my.microsoftpersonalcontent.com/upload" });
    }
    return new Response(null, { status: 404 });
  });
  const adapter = await microsoftAdapter({ kind: "oauth", provider: "onedrive", root: "" }, async () => "private-token");
  await adapter.write("matter.txt", Buffer.from("Synthetic test"), "text/plain", { createOnly: true });
  expect(uploaded).toBe(1);
});
test("read-only sign-ins request no write scope and SharePoint roots request site discovery", () => {
  for (const provider of microsoftProviders) {
    expect(provider.scopes(true).some((scope) => scope.includes("ReadWrite"))).toBe(false);
  }
  expect(microsoftProviders[0]!.scopes(false)).not.toContain("https://graph.microsoft.com/Sites.Read.All");
  expect(microsoftProviders[1]!.scopes(false)).toContain("https://graph.microsoft.com/Sites.Read.All");
});
