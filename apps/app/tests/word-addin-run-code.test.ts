import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runOfficeCode } from "../src/word-addin/office-run-code";

type FakeContext = { sync: () => Promise<void>; workbook: { name: string } };

function installFakeExcel() {
  const context: FakeContext = { sync: async () => undefined, workbook: { name: "Book1" } };
  (globalThis as Record<string, unknown>).window = {
    Excel: {
      run: async <T>(batch: (context: FakeContext) => Promise<T>) => batch(context),
    },
    Office: { marker: "office" },
  };
}

describe("runOfficeCode", () => {
  beforeEach(() => installFakeExcel());
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  test("runs the snippet with context and returns the serialized result", async () => {
    const outcome = (await runOfficeCode("excel", {
      code: "return { name: context.workbook.name, n: 41 + 1 };",
    })) as { result: { name: string; n: number } };
    expect(outcome.result).toEqual({ name: "Book1", n: 42 });
  });

  test("captures console output as logs", async () => {
    const outcome = (await runOfficeCode("excel", {
      code: "console.log('step', 1); console.warn({ a: true }); return null;",
    })) as { logs: string[] };
    expect(outcome.logs).toEqual(["[log] step 1", "[warn] {\"a\":true}"]);
  });

  test("shadows pane globals so snippets cannot reach them", async () => {
    const outcome = (await runOfficeCode("excel", {
      code: "return [typeof fetch, typeof localStorage, typeof XMLHttpRequest, typeof window, typeof document];",
    })) as { result: string[] };
    expect(outcome.result).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
  });

  test("functions in results serialize as placeholders instead of failing", async () => {
    const outcome = (await runOfficeCode("excel", {
      code: "return { ok: true, cb: () => 1 };",
    })) as { result: { ok: boolean; cb: string } };
    expect(outcome.result).toEqual({ ok: true, cb: "[function]" });
  });

  test("enriches Office.js-style errors with debugInfo", async () => {
    await expect(
      runOfficeCode("excel", {
        code: "const e = new Error('boom'); e.debugInfo = { statement: 'range.load' }; throw e;",
      }),
    ).rejects.toThrow(/boom.*debugInfo.*range\.load/s);
  });

  test("rejects empty code", async () => {
    await expect(runOfficeCode("excel", { code: "   " })).rejects.toThrow(/code is required/);
  });
});
