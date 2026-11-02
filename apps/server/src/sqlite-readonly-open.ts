import { setTimeout } from "node:timers/promises";

type Reader = { all(sql: string): unknown; close(): void };

function mappedFileTruncate(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "SQLITE_IOERR_TRUNCATE"
    || error.code === "ERR_SQLITE_ERROR" && "errcode" in error && error.errcode === 1546);
}

/** Windows can release an exiting process's locks before unmapping its WAL index. */
export async function openReadonlySqlite<T extends Reader>(open: () => Promise<T>, platform: NodeJS.Platform = process.platform): Promise<T> {
  if (platform !== "win32") return open();
  const deadline = performance.now() + 3_000;
  while (true) {
    let reader: T | undefined;
    try {
      reader = await open();
      // Opening is lazy; acquire the shared-memory read mapping before handing off.
      reader.all("SELECT name FROM sqlite_master LIMIT 1");
      return reader;
    } catch (error) {
      reader?.close();
      const remaining = deadline - performance.now();
      if (!mappedFileTruncate(error) || remaining <= 0) throw error;
      await setTimeout(Math.min(25, remaining));
    }
  }
}
