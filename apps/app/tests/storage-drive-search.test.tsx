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
function seed(cache: QueryClient, id: string, page: StorageFilenameSearchPage) {
  cache.setQueryData(["storage-filename-search", "workspace", id, "contract", 0], {
    pages: [page],
    pageParams: [undefined],
  });
}
function renderSearch(cache: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <StorageDriveSearch
        client={client}
        workspaceId="workspace"
        roots={roots}
        query="contract"
        refreshKey={0}
        onOpenFile={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("Memory Drive filename search", () => {
  test("distinguishes identical filenames in multiple connections and shows their paths", () => {
    const cache = new QueryClient();
    for (const root of roots)
      seed(cache, root.id, {
        scanned: 1,
        entries: [{ name: "contract.docx", path: "nested/contract.docx", kind: "file", size: 20, modifiedAt: null }],
      });
    const html = renderSearch(cache);
    expect(html).toContain('aria-label="Secure Cloud"');
    expect(html).toContain('aria-label="Office Share"');
    expect(html).toContain('title="Secure Cloud / nested/contract.docx"');
    expect(html).toContain('title="Office Share / nested/contract.docx"');
    cache.clear();
  });
  test("does not call an unfinished empty page no matches", () => {
    const cache = new QueryClient();
    for (const root of roots) seed(cache, root.id, { scanned: 1000, entries: [], nextCursor: "continue" });
    const html = renderSearch(cache);
    expect(html).toContain("files checked");
    expect(html).not.toContain("No matching files");
    expect(html).not.toContain("No files match");
    cache.clear();
  });
  test("keeps the search field available without a LegalMemory connection", async () => {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cache.setQueryData(["storage-roots", "workspace"], { roots });
    await cache.prefetchQuery({
      queryKey: ["legalmemory-tree-roots", "workspace"],
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
