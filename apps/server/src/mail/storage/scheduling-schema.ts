export const MAIL_SCHEDULING_SQL = `
CREATE TABLE mail_outbox_schedules (
  account_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL CHECK(scheduled_at >= 0),
  time_zone TEXT NOT NULL,
  PRIMARY KEY(account_id, action_id),
  FOREIGN KEY(account_id, action_id) REFERENCES mail_outbox(account_id, action_id) ON DELETE CASCADE
);
`;
