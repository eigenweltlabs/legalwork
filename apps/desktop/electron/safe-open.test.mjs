import assert from "node:assert/strict";
import test from "node:test";

import { classifyExternalUrl, classifyFileOpen, createSafeOpen } from "./safe-open.mjs";

test("web and mail links open without asking", () => {
  for (const url of ["https://example.com/", "http://127.0.0.1:8787/health", "mailto:kanzlei@example.com?subject=Akte"]) {
    assert.deepEqual(classifyExternalUrl(url), { action: "open" }, url);
  }
});

test("app links ask first", () => {
  assert.deepEqual(classifyExternalUrl("ms-word:ofe|u|C:/akte.docx"), { action: "confirm", scheme: "ms-word:" });
  assert.deepEqual(classifyExternalUrl("zoommtg://zoom.us/join?confno=1"), { action: "confirm", scheme: "zoommtg:" });
  assert.deepEqual(classifyExternalUrl("tel:+4930123456"), { action: "confirm", scheme: "tel:" });
});

test("local and scripted schemes are refused outright", () => {
  assert.equal(classifyExternalUrl("file:///Users/anwalt/run.command").action, "refuse");
  assert.equal(classifyExternalUrl("javascript:alert(1)").action, "refuse");
  assert.equal(classifyExternalUrl("data:text/html,<h1>hi").action, "refuse");
  assert.equal(classifyExternalUrl("smb://server/share").action, "confirm");
});

test("malformed input is refused", () => {
  assert.equal(classifyExternalUrl("").action, "refuse");
  assert.equal(classifyExternalUrl(null).action, "refuse");
  assert.equal(classifyExternalUrl("   ").action, "refuse");
  assert.equal(classifyExternalUrl("not a url").action, "refuse");
  assert.deepEqual(classifyExternalUrl("https://example.com/\0.exe"), { action: "refuse", reason: "null byte" });
});

test("documents open, programs are only revealed, unknown types are revealed", () => {
  for (const file of ["/w/Vertrag.pdf", "/w/Schriftsatz.docx", "/w/Tabelle.xlsx", "/w/foto.HEIC", "/w/notiz.md"]) {
    assert.deepEqual(classifyFileOpen(file), { action: "open" }, file);
  }
  for (const file of ["/w/run.command", "/w/Tool.app", "/w/setup.exe", "/w/script.sh", "/w/macro.docm", "/w/link.webloc", "/w/noext"]) {
    assert.equal(classifyFileOpen(file).action, "reveal", file);
  }
  assert.deepEqual(classifyFileOpen("/w/zeichnung.dwg"), { action: "reveal", reason: ".dwg" });
  assert.deepEqual(classifyFileOpen("/w/payload.exe\0.pdf"), { action: "reveal", reason: "null byte" });
});

function fakeShell() {
  const calls = [];
  return {
    calls,
    openExternal: async (url) => calls.push(["openExternal", url]),
    openPath: async (target) => {
      calls.push(["openPath", target]);
      return "";
    },
    showItemInFolder: (target) => calls.push(["showItemInFolder", target]),
  };
}

test("openExternal asks only for app links and respects the answer", async () => {
  const shell = fakeShell();
  const asked = [];
  const safeOpen = createSafeOpen({
    shell,
    confirm: async (options) => {
      asked.push(options.message);
      return options.detail.includes("zoommtg");
    },
    log: () => {},
  });

  assert.equal(await safeOpen.openExternal("https://example.com/"), true);
  assert.equal(asked.length, 0);
  assert.equal(await safeOpen.openExternal("zoommtg://zoom.us/join"), true);
  assert.equal(await safeOpen.openExternal("ms-word:ofe|u|C:/a.docx"), false);
  assert.equal(await safeOpen.openExternal("file:///Users/anwalt/run.command"), false);

  assert.deepEqual(shell.calls, [
    ["openExternal", "https://example.com/"],
    ["openExternal", "zoommtg://zoom.us/join"],
  ]);
  assert.equal(asked.length, 2);
});

test("openPath never launches a program, and reveals it instead", async () => {
  const shell = fakeShell();
  const safeOpen = createSafeOpen({ shell, confirm: async () => true, log: () => {} });

  await safeOpen.openPath("/w/Vertrag.pdf");
  await safeOpen.openPath("/w/run.command");
  await safeOpen.openPath("/w/Tool.app");

  assert.deepEqual(shell.calls, [
    ["openPath", "/w/Vertrag.pdf"],
    ["showItemInFolder", "/w/run.command"],
    ["showItemInFolder", "/w/Tool.app"],
  ]);
});

test("unknown file types are revealed without offering to launch them", async () => {
  const shell = fakeShell();
  const safeOpen = createSafeOpen({ shell, confirm: async () => { assert.fail("Unknown files must not offer a launch confirmation"); }, log: () => {} });

  await safeOpen.openPath("/w/zeichnung.dwg");
  assert.deepEqual(shell.calls, [["showItemInFolder", "/w/zeichnung.dwg"]]);
});
