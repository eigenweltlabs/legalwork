/** Internal synchronous worker-only interface. Never expose SQL through public mail APIs. */
export type MailSqlValue = string | number | Uint8Array | null;
export type MailSqlRow = Record<string, unknown>;

export interface MailDatabase {
  exec(sql: string): void;
  run(sql: string, parameters?: readonly MailSqlValue[]): { changes: number };
  get(sql: string, parameters?: readonly MailSqlValue[]): MailSqlRow | undefined;
  all(sql: string, parameters?: readonly MailSqlValue[]): MailSqlRow[];
  /** Must reject asynchronous/thenable callbacks and roll back when the body throws. */
  transaction<T>(body: () => T): T;
  /** Internal maintenance only, while the service has stopped its worker. */
  rekey?(key: Uint8Array): void;
  close(): void;
}
