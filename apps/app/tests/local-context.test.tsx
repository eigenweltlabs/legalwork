import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StealthMode } from "../src/react-app/shell/stealth-mode";
import { LocalProvider } from "../src/react-app/kernel/local-provider";

test("the recording privacy indicator keeps its settings provider across a renderer hot update", async () => {
  // A mounted provider can belong to an earlier ESM evaluation of the same file.
  const previousModule = "../src/react-app/kernel/local-provider.tsx?revision=previous";
  const previous: typeof import("../src/react-app/kernel/local-provider") = await import(previousModule);
  expect(previous.LocalProvider).not.toBe(LocalProvider);
  expect(renderToStaticMarkup(<previous.LocalProvider><StealthMode /></previous.LocalProvider>)).toBe("");
  expect(renderToStaticMarkup(<LocalProvider><StealthMode /></LocalProvider>)).toBe("");
});
