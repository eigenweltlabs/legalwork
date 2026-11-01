export const MAIL_INVITATION_REPLIES_SQL = `CREATE TABLE mail_invitation_replies (
  owner_id TEXT NOT NULL, event_key TEXT NOT NULL, attempt_id TEXT NOT NULL,
  response TEXT NOT NULL CHECK(response IN ('accepted','tentative','declined')),
  state TEXT NOT NULL CHECK(state IN ('uncertain','confirmed','rejected')),
  updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id,event_key)
);`;
