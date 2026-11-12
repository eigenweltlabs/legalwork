import { randomUUID } from "node:crypto";
import type { SqliteHandle } from "../runtime-db.js";
import { BackOfficeRecordSchema, type BackOfficeRecord } from "./schema.js";

/** TEMP rows belong to this SQLite connection. Readers only see the live
 * tables. A closed/crashed connection automatically discards partial pages. */
export class SyncInbox {
  private readonly transfer = randomUUID();
  constructor(private readonly db: SqliteHandle) {
    db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS bo_incoming(transfer TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(transfer,id)) WITHOUT ROWID",
    );
  }
  add(
    records: BackOfficeRecord[],
    translate: (record: BackOfficeRecord) => void,
  ) {
    for (const row of records) {
      translate(row);
      this.db.run(
        "INSERT INTO temp.bo_incoming VALUES(?,?,?,?) ON CONFLICT(transfer,id) DO UPDATE SET revision=excluded.revision,data=excluded.data WHERE excluded.revision>=bo_incoming.revision",
        [this.transfer, row.id, row.revision, JSON.stringify(row)],
      );
    }
  }
  get(id: string) {
    const row = this.db.get(
      "SELECT data FROM temp.bo_incoming WHERE transfer=? AND id=?",
      [this.transfer, id],
    );
    return row
      ? BackOfficeRecordSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }
  *records(): Generator<BackOfficeRecord> {
    let after = "";
    for (;;) {
      const rows = this.db.all(
        "SELECT id,data FROM temp.bo_incoming WHERE transfer=? AND id>? ORDER BY id LIMIT 256",
        [this.transfer, after],
      );
      for (const row of rows)
        yield BackOfficeRecordSchema.parse(JSON.parse(String(row.data)));
      if (rows.length < 256) return;
      after = String(rows[rows.length - 1].id);
    }
  }
  missing(scope: string) {
    return this.db.all(
      "SELECT id FROM bo_records r WHERE scope=? AND NOT EXISTS(SELECT 1 FROM temp.bo_incoming i WHERE i.transfer=? AND i.id=r.id)",
      [scope, this.transfer],
    );
  }
  clear() {
    this.db.run("DELETE FROM temp.bo_incoming WHERE transfer=?", [
      this.transfer,
    ]);
  }
}
