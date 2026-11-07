import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSqlite } from "../runtime-db.js";
import { openBackOfficeAuditStorage } from "./audit-storage.js";
import { BackOfficeStore } from "./store.js";

const [directory, name, pause] = process.argv.slice(2);
if (!directory || !name)
  throw new Error("Expected a disposable fixture directory and writer name.");
const storage = await openBackOfficeAuditStorage(
  join(directory, "audit"),
  true,
);
if (pause === "pause") {
  const checkpoint = storage.checkpoint;
  let delayed = false;
  storage.checkpoint = (head) => {
    if (!delayed) {
      delayed = true;
      writeFileSync(join(directory, "checkpoint-gap"), "committed");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
    checkpoint(head);
  };
}
const store = new BackOfficeStore(
  await openSqlite(join(directory, "runtime.sqlite")),
  storage,
);
try {
  store.saveRecord(
    "local",
    { userId: "local", model: true, edit: true, finance: true },
    {
      objectId: "people",
      revision: 0,
      values: { name },
    },
  );
  store.checkIntegrity();
} finally {
  store.close();
}
