import { expect, test } from "bun:test";
import { ApiError } from "../errors.js";
import type { ConnectorRequestOptions, StreamingConnectorRequest } from "../connectors/request.js";
import { googleStorageAdapter } from "./cloud-drives.js";
import { googleFolder } from "./google-drive-tree.js";
import { nativeSegment } from "./native-drive.js";

async function fixture(options: { kind?: "file" | "folder"; revision?: string; etag?: string; changed?: boolean; destinationExists?: boolean; missingRevision?: boolean; wrongIdentity?: boolean; resourceKey?: string; myDrive?: boolean; nativeDocument?: boolean } = {}) {
  const root = { id: "shared-root", name: "Company", mimeType: googleFolder, parents: [], version: "1", driveId: options.myDrive ? undefined : "shared-drive" };
  const source = { ...root, id: "source", name: "Rechnungen", parents: [root.id], version: options.missingRevision ? undefined : "7", resourceKey: options.resourceKey, mimeType: options.nativeDocument ? "application/vnd.google-apps.document" : options.kind === "file" ? "application/pdf" : googleFolder };
  const calls: { url: URL; options: ConnectorRequestOptions }[] = [];
  const response = async (path: string, input: ConnectorRequestOptions = {}) => {
    const url = new URL(path, "https://www.googleapis.com"); calls.push({ url, options: input });
    if (input.method === "PATCH") {
      if (options.changed) throw new ApiError(409, "connector_file_changed", "The file changed before the operation.");
      return Response.json({ id: source.id });
    }
    if (url.pathname.startsWith("/drive/v2/")) return Response.json({ id: options.wrongIdentity ? "different-file" : source.id, version: options.revision ?? "7", etag: options.etag ?? '"provider-version-7"' });
    if (url.pathname.endsWith("/files")) return Response.json({ files: [source, ...(options.destinationExists ? [{ ...source, id: "taken", name: "Invoices" }] : [])] });
    return Response.json(url.pathname.endsWith("/source") ? source : root);
  };
  const request: StreamingConnectorRequest = Object.assign(async (path: string, input?: ConnectorRequestOptions) => (await response(path, input)).json(), {
    response, apiOrigin: "https://www.googleapis.com", assertWrite: async () => {},
  });
  const adapter = await googleStorageAdapter({ kind: "oauth", provider: "google-drive", root: root.id, accountId: "fixture" }, request);
  return { adapter, source, calls, rename: () => adapter.rename!(nativeSegment(source), "Invoices", options.kind ?? "folder"),
    trash: (version?: string) => options.kind === "file" ? adapter.deleteFile!(nativeSegment(source), { version }) : adapter.deleteFolder!(nativeSegment(source), true) };
}

test("Google files and folders are conditionally trashed in My Drive and shared drives without a v3 ETag", async () => {
  for (const kind of ["file", "folder"] satisfies ("file" | "folder")[]) for (const myDrive of [false, true]) {
    const run = await fixture({ kind, myDrive });
    await run.trash();
    const metadata = run.calls.find(call => call.url.pathname === "/drive/v2/files/source" && !call.options.method);
    expect(metadata?.url.searchParams.get("fields")).toBe("id,etag,version");
    const writes = run.calls.filter(call => call.options.method);
    expect(writes).toHaveLength(1);
    expect(writes[0].options.method).toBe("PATCH");
    expect(writes[0].url.pathname).toBe("/drive/v2/files/source");
    expect(writes[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(writes[0].options.headers?.["If-Match"]).toBe('"provider-version-7"');
    expect(writes[0].options.body).toEqual({ labels: { trashed: true } });
  }
});

test("Google deletion verifies the caller's source revision before obtaining its conditional token", async () => {
  const stale = await fixture({ kind: "file" });
  await expect(stale.trash("sha256:6")).rejects.toMatchObject({ code: "storage_conflict" });
  expect(stale.calls.some(call => call.url.pathname.startsWith("/drive/v2/") || call.options.method)).toBe(false);
  const current = await fixture({ kind: "file" });
  await current.trash("sha256:7");
  expect(current.calls.find(call => call.options.method)?.options.headers?.["If-Match"]).toBe('"provider-version-7"');
});

test("changed revisions or invalid conditional metadata prevent Google file and folder deletion", async () => {
  const cases = [
    { options: { revision: "8" }, code: "storage_conflict" },
    { options: { missingRevision: true }, code: "storage_conditional_write_unsupported" },
    { options: { wrongIdentity: true }, code: "storage_invalid_response" },
    ...["", 'W/"weak"', "sha256:7"].map(etag => ({ options: { etag }, code: "storage_conditional_write_unsupported" })),
  ];
  for (const kind of ["file", "folder"] satisfies ("file" | "folder")[]) for (const entry of cases) {
    const run = await fixture({ ...entry.options, kind });
    await expect(run.trash()).rejects.toMatchObject({ code: entry.code });
    expect(run.calls.some(call => call.options.method)).toBe(false);
  }
});

test("a changed Google file or folder is not retried after a trash precondition failure", async () => {
  for (const kind of ["file", "folder"] satisfies ("file" | "folder")[]) {
    const run = await fixture({ kind, changed: true });
    await expect(run.trash()).rejects.toMatchObject({ code: "connector_file_changed" });
    expect(run.calls.filter(call => call.options.method === "PATCH")).toHaveLength(1);
  }
});

test("native Google documents use trash without export, and resource keys accompany both conditional requests", async () => {
  const run = await fixture({ kind: "file", nativeDocument: true, resourceKey: "fixture-resource-key" });
  await run.trash();
  const requests = run.calls.filter(call => call.url.pathname.startsWith("/drive/v2/"));
  expect(requests).toHaveLength(2);
  for (const call of requests) expect(call.options.headers?.["X-Goog-Drive-Resource-Keys"]).toBe("source/fixture-resource-key");
  expect(run.calls.some(call => call.url.pathname.endsWith("/export") || call.options.method === "DELETE")).toBe(false);
});

test("Google folder and file renames use the real provider ETag when v3 metadata has no header", async () => {
  for (const kind of ["folder", "file"] satisfies ("folder" | "file")[]) {
    const run = await fixture({ kind });
    await run.rename();
    const metadata = run.calls.find(call => call.url.pathname === "/drive/v2/files/source" && !call.options.method);
    expect(metadata?.url.searchParams.get("fields")).toBe("id,etag,version");
    expect(metadata?.url.searchParams.get("supportsAllDrives")).toBe("true");
    const writes = run.calls.filter(call => call.options.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0].url.pathname).toBe("/drive/v2/files/source");
    expect(writes[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(writes[0].options.headers?.["If-Match"]).toBe('"provider-version-7"');
    expect(writes[0].options.body).toEqual({ title: "Invoices" });
  }
});

test("a change between v3 resolution and conditional-token lookup prevents the rename", async () => {
  const run = await fixture({ revision: "8" });
  await expect(run.rename()).rejects.toMatchObject({ code: "storage_conflict" });
  expect(run.calls.some(call => call.options.method)).toBe(false);
});

test("missing revision or mismatched provider identity prevents mutation", async () => {
  for (const options of [{ missingRevision: true }, { wrongIdentity: true }]) {
    const run = await fixture(options);
    await expect(run.rename()).rejects.toMatchObject({ code: options.missingRevision ? "storage_conditional_write_unsupported" : "storage_invalid_response" });
    expect(run.calls.some(call => call.options.method)).toBe(false);
  }
});

test("resource keys accompany both conditional metadata and rename requests", async () => {
  const run = await fixture({ resourceKey: "fixture-resource-key" });
  await run.rename();
  const requests = run.calls.filter(call => call.url.pathname.startsWith("/drive/v2/"));
  expect(requests).toHaveLength(2);
  for (const call of requests) expect(call.options.headers?.["X-Goog-Drive-Resource-Keys"]).toBe("source/fixture-resource-key");
});

test("missing, weak or fabricated conditional tokens never permit a rename", async () => {
  for (const etag of ["", 'W/"weak"', "sha256:7"]) {
    const run = await fixture({ etag });
    await expect(run.rename()).rejects.toMatchObject({ code: "storage_conditional_write_unsupported" });
    expect(run.calls.some(call => call.options.method)).toBe(false);
  }
});

test("a provider precondition failure is surfaced once without retrying or overwriting", async () => {
  const run = await fixture({ changed: true });
  await expect(run.rename()).rejects.toMatchObject({ code: "connector_file_changed" });
  expect(run.calls.filter(call => call.options.method === "PATCH")).toHaveLength(1);
});

test("an existing destination is refused before token lookup or rename", async () => {
  const run = await fixture({ destinationExists: true });
  await expect(run.rename()).rejects.toMatchObject({ code: "storage_conflict" });
  expect(run.calls.some(call => call.url.pathname.startsWith("/drive/v2/"))).toBe(false);
  expect(run.calls.some(call => call.options.method)).toBe(false);
});
