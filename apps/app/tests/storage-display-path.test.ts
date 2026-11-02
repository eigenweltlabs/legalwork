import { expect, test } from "bun:test";
import { storageDisplayPath } from "../src/app/lib/storage-display-path";

const path = "~lw~c2hhcmVk~Shared drives/~lw~ZHJpdmU~Eigenweltlabs/~lw~Y29tcGFueQ~Company Management/~lw~Zm9sZGVy~Rechnungen";

test("native cloud identity paths display folder names without opaque IDs", () => {
  for (const provider of ["google-drive", "onedrive", "onedrive-personal", "sharepoint-files"]) {
    expect(storageDisplayPath({ provider }, path)).toBe("Shared drives/Eigenweltlabs/Company Management/Rechnungen");
  }
  expect(path).toContain("~lw~Zm9sZGVy~Rechnungen");
});

test("ordinary paths and literal identity-like filenames on other providers stay intact", () => {
  expect(storageDisplayPath({ provider: "google-drive" }, "Company/Invoices 2026")).toBe("Company/Invoices 2026");
  for (const provider of ["dropbox", "box", undefined]) expect(storageDisplayPath({ provider }, path)).toBe(path);
  expect(storageDisplayPath({ provider: "google-drive" }, "")).toBe("");
});

test("names containing tildes or HTML remain text and malformed identity prefixes are preserved", () => {
  expect(storageDisplayPath({ provider: "google-drive" }, "~lw~YWJj~Invoices~2026/<draft>.txt")).toBe("Invoices~2026/<draft>.txt");
  expect(storageDisplayPath({ provider: "google-drive" }, "~lw~~Invoice/~lw~bad!id~Folder")).toBe("~lw~~Invoice/~lw~bad!id~Folder");
});
