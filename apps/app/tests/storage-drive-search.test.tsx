/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient, LegalworkServerError } from "../src/app/lib/legalwork-server";
import { LegalMemoryFilesPanel } from "../src/react-app/domains/session/panel/legalmemory-files-panel";
import { StorageDriveSearch } from "../src/react-app/domains/session/panel/storage-drive-search";
import type { StorageFilenameSearchPage, StorageRoot } from "@legalwork/types/file-storage";

const client = createLegalworkServerClient({ baseUrl: "http://localhost:1" });
const roots: StorageRoot[] = [
  { id: "s3", name: "Secure Cloud", kind: "s3", writable: true },
  { id: "smb", name: "Office Share", kind: "smb", writable: false },
];
function seed(cache: QueryClient, id: string, page: StorageFilenameSearchPage, baseUrl = client.baseUrl) {
  cache.setQueryData(["storage-filename-search", "workspace", id, "contract", 0, baseUrl], {
    pages: [page],
    pageParams: [undefined],
  });
}
function renderSearch(cache: QueryClient, searchRoots = roots) {
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <StorageDriveSearch
        client={client}
        workspaceId="workspace"
        roots={searchRoots}
        query="contract"
        refreshKey={0}
        onOpenFile={() => {}}
        onConnectStorage={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("Memory Drive filename search", () => {
  test("cloud search presents readable locations while keeping native identities in its source data", () => {
    const cache = new QueryClient();
    const root: StorageRoot = { id: "google", name: "Google Drive", kind: "oauth", provider: "google-drive", writable: true };
    const path = "~lw~Y29tcGFueQ~Company Management/~lw~ZmlsZQ~contract.docx";
    seed(cache, root.id, { scanned: 1, complete: true, entries: [{ path, name: "contract.docx", kind: "file", size: 20, modifiedAt: null }] });
    const html = renderSearch(cache, [root]);
    expect(html).toContain('title="Google Drive / Company Management/contract.docx"');
    expect(html).toContain(">Company Management/contract.docx</span>");
    expect(html).not.toContain("~lw~");
    expect(cache.getQueryData(["storage-filename-search", "workspace", root.id, "contract", 0, client.baseUrl])).toMatchObject({ pages: [{ entries: [{ path }] }] });
    cache.clear();
  });
  test("offers connector setup for sign-in errors and retains retry for other failures", async () => {
    for (const code of ["storage_signin_required", "storage_disconnected", "connector_reconnect_required", "storage_settings_conflict"]) {
      const cache = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
      await cache.prefetchQuery({
        queryKey: ["storage-filename-search", "workspace", "s3", "contract", 0, client.baseUrl],
        queryFn: () => { throw new LegalworkServerError(409, code, "Provider error details"); },
      });
      const html = renderSearch(cache);
      const needsSignIn = code !== "storage_settings_conflict";
      expect(html.includes("Open connectors")).toBe(needsSignIn);
      expect(html.includes("Sign in to view files")).toBe(needsSignIn);
      expect(html.includes("Try again")).toBe(!needsSignIn);
      expect(html.includes("Provider error details")).toBe(!needsSignIn);
      cache.clear();
    }
  });
  test("distinguishes identical filenames in multiple connections and shows their paths", () => {
    const cache = new QueryClient();
    for (const root of roots)
      seed(cache, root.id, {
        scanned: 1,
        complete: true,
        entries: [{ name: "contract.docx", path: "nested/contract.docx", kind: "file", size: 20, modifiedAt: null }],
      });
    const html = renderSearch(cache);
    expect(html).toContain('aria-label="Secure Cloud"');
    expect(html).toContain('aria-label="Office Share"');
    expect(html).toContain('title="Secure Cloud / nested/contract.docx"');
    expect(html).toContain('title="Office Share / nested/contract.docx"');
    cache.clear();
  });
  test("a different server with the same workspace ID cannot supply cached search results", () => {
    const cache = new QueryClient();
    seed(cache, "s3", { scanned: 1, complete: true, entries: [{ name: "other-project.docx", path: "other-project.docx", kind: "file", size: 20, modifiedAt: null }] }, "https://another-server.example.test");
    expect(renderSearch(cache)).not.toContain("other-project.docx");
    cache.clear();
  });
  test("does not call an unfinished empty page no matches", () => {
    const cache = new QueryClient();
    for (const root of roots)
      seed(cache, root.id, { scanned: 1000, entries: [], complete: false, nextCursor: "continue" });
    const html = renderSearch(cache);
    expect(html).toContain("files checked");
    expect(html).not.toContain("No matching files");
    expect(html).not.toContain("No files match");
    cache.clear();
  });
  test("incomplete provider results are reported instead of claiming no matching files", () => {
    const cache = new QueryClient();
    for (const root of roots) seed(cache, root.id, { scanned: 100, entries: [], complete: false, truncated: true });
    const html = renderSearch(cache);
    expect(html).toContain("The provider returned incomplete results");
    expect(html).not.toContain("No matching files");
    cache.clear();
  });
  test("keeps the search field available without a LegalMemory connection", async () => {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cache.setQueryData(["storage-roots", "workspace", client.baseUrl], { roots });
    await cache.prefetchQuery({
      queryKey: ["legalmemory-tree-roots", "workspace", client.baseUrl],
      queryFn: () => {
        throw new LegalworkServerError(409, "legalmemory_not_configured", "Connect LegalMemory");
      },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <LegalMemoryFilesPanel
          client={client}
          workspaceId="workspace"
          onOpenFile={() => {}}
          onOpenStorageFile={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('placeholder="Search filenames"');
    expect(html).toContain('aria-label="Search all Memory Drive filenames"');
    cache.clear();
  });
});
