import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { buildWordAddinManifest } from "./word-addin.js";
import { buildWordAddinShellHtml, WORD_ADDIN_SHELL_VERSION } from "./word-addin-shell.js";

test("the private manifest sends its credential only in a fragment, with no credential in the public manifest", () => {
  const connectionToken = "a".repeat(64);
  const xml = buildWordAddinManifest({ baseUrl: "https://localhost:47443", connectionToken });
  const source = xml.match(/<SourceLocation DefaultValue="([^"]+)"/u)?.[1];
  if (!source) throw new Error("Manifest task pane source missing");
  const url = new URL(source);
  expect(url.pathname).toBe(`/word-addin/shell-v${WORD_ADDIN_SHELL_VERSION}.html`);
  expect(url.search).toBe("");
  expect(new URLSearchParams(url.hash.slice(1)).get("office_launch")).toBe(connectionToken);
  expect(buildWordAddinManifest({ baseUrl: url.origin })).not.toContain("office_launch");
});

test("the shell saves the installed credential before navigating and keeps it out of HTTP requests", async () => {
  const connectionToken = "a".repeat(64);
  const storage = new Map<string, string>();
  const navigation: string[] = [], history: string[] = [], requests: string[] = [];
  const script = buildWordAddinShellHtml().match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  if (!script) throw new Error("Shell script missing");
  runInNewContext(script, {
    URLSearchParams,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    location: { hash: `#office_launch=${connectionToken}`, pathname: `/word-addin/shell-v${WORD_ADDIN_SHELL_VERSION}.html`, search: "", replace: (url: string) => navigation.push(url) },
    history: { replaceState: (_state: unknown, _title: string, url: string) => history.push(url) },
    document: { getElementById: () => ({ addEventListener() {} }) },
    fetch: async (url: string) => {
      expect(storage.get("legalwork.office.launch")).toBe(connectionToken);
      requests.push(url);
      return { ok: true, json: async () => ({ shellVersion: WORD_ADDIN_SHELL_VERSION }) };
    },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
  });
  for (let attempt = 0; attempt < 10 && !navigation.length; attempt++) await new Promise(resolve => setImmediate(resolve));
  expect(requests).toEqual(["bootstrap"]);
  expect(navigation).toEqual(["app.html"]);
  expect(history).toEqual([`/word-addin/shell-v${WORD_ADDIN_SHELL_VERSION}.html`]);
});
