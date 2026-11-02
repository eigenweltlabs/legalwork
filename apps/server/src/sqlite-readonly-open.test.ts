import { expect, test } from "bun:test";
import { openReadonlySqlite } from "./sqlite-readonly-open.js";

const truncate = () => Object.assign(new Error("mapped WAL index"), { code: "SQLITE_IOERR_TRUNCATE" });

test("Windows closes the failed read mapping before reopening and returns only the successful reader", async () => {
  const events: string[] = [], failure = truncate(); let attempt = 0;
  const reader = await openReadonlySqlite(async () => {
    const id = ++attempt; events.push(`open:${id}`);
    return { all(sql: string) { expect(sql).toBe("SELECT name FROM sqlite_master LIMIT 1"); events.push(`read:${id}`); if (id === 1) throw failure; return []; }, close() { events.push(`close:${id}`); } };
  }, "win32");
  expect(events).toEqual(["open:1", "read:1", "close:1", "open:2", "read:2"]);
  reader.close(); expect(events.at(-1)).toBe("close:2");
});

test("the Node extended SQLite truncate code is retried, including a lazy constructor failure", async () => {
  let opens = 0;
  const failure = Object.assign(new Error("mapped WAL index"), { code: "ERR_SQLITE_ERROR", errcode: 1546 });
  const expected = { all: () => [], close: () => {} };
  expect(await openReadonlySqlite(async () => { if (++opens === 1) throw failure; return expected; }, "win32")).toBe(expected);
  expect(opens).toBe(2);
});

test("a persistent Windows mapping error remains a failure after the bounded handoff wait", async () => {
  let opens = 0, closes = 0; const failure = truncate(), started = performance.now();
  await expect(openReadonlySqlite(async () => { opens++; return { all() { throw failure; }, close() { closes++; } }; }, "win32")).rejects.toBe(failure);
  expect(opens).toBeGreaterThan(1); expect(closes).toBe(opens);
  expect(performance.now() - started).toBeGreaterThanOrEqual(3_000);
}, 5_000);

for (const code of ["SQLITE_IOERR_READ", "SQLITE_CORRUPT", "SQLITE_READONLY", "EACCES"]) {
  test(`Windows does not retry ${code}`, async () => {
    const failure = Object.assign(new Error(code), { code }); let opens = 0, closes = 0;
    await expect(openReadonlySqlite(async () => { opens++; return { all() { throw failure; }, close() { closes++; } }; }, "win32")).rejects.toBe(failure);
    expect(opens).toBe(1); expect(closes).toBe(1);
  });
}

test("failed connection cleanup prevents a retry", async () => {
  const cleanup = new Error("close failed"); let opens = 0;
  await expect(openReadonlySqlite(async () => { opens++; return { all() { throw truncate(); }, close() { throw cleanup; } }; }, "win32")).rejects.toBe(cleanup);
  expect(opens).toBe(1);
});

const platforms: NodeJS.Platform[] = ["darwin", "linux"];
for (const platform of platforms) {
  test(`${platform} keeps the existing open behavior without a probe or retry`, async () => {
    let opens = 0, reads = 0;
    const reader = { all: () => { reads++; throw truncate(); }, close: () => {} };
    expect(await openReadonlySqlite(async () => { opens++; return reader; }, platform)).toBe(reader);
    expect(opens).toBe(1); expect(reads).toBe(0);
  });
}
