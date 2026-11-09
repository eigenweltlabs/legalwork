import { expect, test } from "bun:test";
import { safeRelative } from "./files.js";
import { sandboxPaths } from "./paths.js";
const mounts = [
  { source: "/Users/test/Project One", target: "/workspace" },
  { source: "/Users/test/Library", target: "/authorized/0" },
  { source: "/Users/test/Project One/.opencode/skills/docx", target: "/skills/0" },
];
test("maps quoted attachment and skill paths using the longest authorized root", () => {
  expect(sandboxPaths(`python3 '/Users/test/Project One/.opencode/skills/docx/tool.py' --input "/Users/test/Project One/.legalwork/attachments/id/input.docx"`, mounts))
    .toBe(`python3 '/skills/0/tool.py' --input "/workspace/.legalwork/attachments/id/input.docx"`);
  expect(sandboxPaths("/Users/test/Project One", mounts)).toBe("/workspace");
  expect(sandboxPaths('path="/Users/test/Library/reference.pdf"', mounts)).toBe('path="/authorized/0/reference.pdf"');
});
test("does not map siblings, unknown roots or already translated paths", () => {
  for (const path of ["/Users/test/Project One Other/input.docx", "/Users/another/file", "/workspace/input.docx"])
    expect(sandboxPaths(path, mounts)).toBe(path);
});

test("portable paths reject traversal, Windows aliases, devices and alternate streams", () => {
  for (const path of ["../secret", "a/../../b", "/root", "a\\b", "a:secret", "CON", "x/nul.txt", "x.", "a /b", "a\u0000b", "a//b"]) expect(safeRelative(path)).toBe(false);
  expect(safeRelative("Müller/contract v2.docx")).toBe(true);
});

test("Windows drive, UNC and mixed separators use guest paths without changing other command escapes", () => {
  const windows = [
    { source: String.raw`C:\Users\Test\Project One`, target: "/workspace" },
    { source: String.raw`C:\Users\Test\Project One\files`, target: "/workspace/files" },
    { source: String.raw`\\server\share\Documents`, target: "/authorized/0" },
  ];
  expect(sandboxPaths(String.raw`c:\users\test\project one\files\Case A\Sources`, windows, { directory: true })).toBe("/workspace/files/Case A/Sources");
  expect(sandboxPaths(String.raw`cat "C:\Users\Test\Project One\files\Case A\contract.txt" "//SERVER/share/Documents/input.pdf"; printf '\n'`, windows))
    .toBe(String.raw`cat "/workspace/files/Case A/contract.txt" "/authorized/0/input.pdf"; printf '\n'`);
  expect(sandboxPaths(String.raw`\\server\share\Documents`, windows, { directory: true })).toBe("/authorized/0");
  expect(sandboxPaths(String.raw`C:\Users\Test\Project One Other\secret.txt`, windows, { directory: true })).toBe(String.raw`C:\Users\Test\Project One Other\secret.txt`);
  expect(sandboxPaths(String.raw`\\server\share\Documents Other\secret.txt`, windows, { directory: true })).toBe(String.raw`\\server\share\Documents Other\secret.txt`);
});
