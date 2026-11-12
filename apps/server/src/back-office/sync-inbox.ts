import { openSqlite, type SqliteHandle } from "../runtime-db.js";
import { BackOfficeRecordSchema, type BackOfficeRecord } from "./schema.js";

/** An empty filename opens a private, disk-backed SQLite temporary database.
 * Staging pages never changes the live database's audit verification stamp. */
export class SyncInbox {
  private constructor(private readonly db: SqliteHandle) {}
  static async open() {
    const db = await openSqlite("");
    try {
      db.exec(
        "PRAGMA secure_delete=ON; CREATE TABLE incoming(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) WITHOUT ROWID",
      );
      return new SyncInbox(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  add(
    records: BackOfficeRecord[],
    translate: (record: BackOfficeRecord) => void,
  ) {
    if (!records.length) return;
    this.db.exec("BEGIN");
    try {
      for (const row of records) {
        translate(row);
        this.db.run(
          "INSERT INTO incoming VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data WHERE excluded.revision>=incoming.revision",
          [row.id, row.revision, JSON.stringify(row)],
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id: string) {
    const row = this.db.get("SELECT data FROM incoming WHERE id=?", [id]);
    return row
      ? BackOfficeRecordSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }
  *records(): Generator<BackOfficeRecord> {
    let after = "";
    for (;;) {
      const rows = this.db.all(
        "SELECT id,data FROM incoming WHERE id>? ORDER BY id LIMIT 256",
        [after],
      );
      for (const row of rows)
        yield BackOfficeRecordSchema.parse(JSON.parse(String(row.data)));
      if (rows.length < 256) return;
      after = String(rows[rows.length - 1].id);
    }
  }
  *missing(live: SqliteHandle, scope: string) {
    let after = "";
    for (;;) {
      const rows = live.all(
        "SELECT id FROM bo_records WHERE scope=? AND id>? ORDER BY id LIMIT 256",
        [scope, after],
      );
      if (!rows.length) return;
      const ids = rows.map((row) => String(row.id));
      const present = new Set(
        this.db
          .all(
            "SELECT id FROM incoming WHERE id IN (SELECT value FROM json_each(?))",
            [JSON.stringify(ids)],
          )
          .map((row) => row.id),
      );
      for (const id of ids) if (!present.has(id)) yield { id };
      after = ids[ids.length - 1];
    }
  }
  clear() {
    this.db.exec("DELETE FROM incoming");
  }
  close() {
    this.db.close();
  }
}
