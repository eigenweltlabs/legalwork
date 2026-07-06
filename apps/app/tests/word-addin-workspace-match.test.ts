import { describe, expect, test } from "bun:test";

import { matchWorkspaceForDocument } from "../src/word-addin/workspace-match";

const workspaces = [
  { id: "acme", path: "/Users/jo/Matters/Acme" },
  { id: "acme-nda", path: "/Users/jo/Matters/Acme/NDA" },
  { id: "beta", path: "/Users/jo/Matters/Beta" },
  { id: "remote", path: "" },
];

describe("matchWorkspaceForDocument", () => {
  test("matches a document inside a workspace folder", () => {
    const m = matchWorkspaceForDocument("/Users/jo/Matters/Beta/deal.docx", workspaces);
    expect(m?.id).toBe("beta");
  });

  test("picks the deepest (most specific) nested workspace", () => {
    const m = matchWorkspaceForDocument("/Users/jo/Matters/Acme/NDA/nda-v3.docx", workspaces);
    expect(m?.id).toBe("acme-nda");
  });

  test("falls back to the parent workspace when not in the nested one", () => {
    const m = matchWorkspaceForDocument("/Users/jo/Matters/Acme/term-sheet.xlsx", workspaces);
    expect(m?.id).toBe("acme");
  });

  test("is case-insensitive (mac/windows filesystems)", () => {
    const m = matchWorkspaceForDocument("/users/JO/matters/beta/Deal.docx", workspaces);
    expect(m?.id).toBe("beta");
  });

  test("returns null for a document outside every workspace", () => {
    expect(matchWorkspaceForDocument("/Users/jo/Desktop/scratch.docx", workspaces)).toBeNull();
  });

  test("does not match on a partial folder-name prefix", () => {
    // "/Users/jo/Matters/AcmeCorp" must NOT match the "Acme" workspace.
    expect(matchWorkspaceForDocument("/Users/jo/Matters/AcmeCorp/x.docx", workspaces)).toBeNull();
  });

  test("returns null for unsaved / cloud / empty inputs", () => {
    expect(matchWorkspaceForDocument(null, workspaces)).toBeNull();
    expect(matchWorkspaceForDocument("", workspaces)).toBeNull();
    expect(matchWorkspaceForDocument("https://contoso.sharepoint.com/x.docx", workspaces)).toBeNull();
  });

  test("ignores workspaces without a local path", () => {
    const m = matchWorkspaceForDocument("/somewhere/else.docx", [{ id: "remote", path: "" }]);
    expect(m).toBeNull();
  });
});
