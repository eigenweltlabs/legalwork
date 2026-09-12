# Permission-scoped agent mail access (EIG-149)

Connecting an account does not grant agent access. Mail Settings → Agent mail access grants one registered workspace one account, selected operations, and optionally one LegalMemory matter. The UI explicitly discloses model processing and requires a deliberate confirmation. Grants last 30 days through the UI (private API maximum 90 days). Revoke stops subsequent tool calls and pending proposals. Reconnect or a change in account custody invalidates the old grant. Imported archive accounts can receive offline search/read/attachment/export grants; they cannot receive provider mutation or draft/send permissions.

## Authority and trusted execution

The host-only `/mail/v1/agent-access` route creates grants; the existing Mail API remains host-token-only. The separate `/mail/agent/v1/invoke` route validates a random 256-bit capability against a hash in the encrypted mail database. Each persisted grant binds account, credential generation, canonical workspace directory, workspace ID, optional matter, permissions, expiry, and revision. Caller-supplied account/workspace IDs are rejected, not treated as authority. Every request checks the configured engine’s actual session and message IDs and exact canonical session directory. A registered parent directory does not grant a child-directory instance access.

The bundled plugin receives a private capability-directory path through the managed engine launch environment. Only the file for the engine-supplied instance directory is loaded. Bearers never appear in plugin results, MCP configuration/listing, runtime configuration JSON, or approval UI. The environment path is marked SECRET for existing diagnostic redaction. Bearers are necessarily present in a private OS-permission-protected provisioning file for the engine, separate from the encrypted database’s token hashes. Provisioning failure revokes the newly created grant. Revoked/expired files may remain; the server rejects them. Loss of the private file requires a fresh grant, never reconstruction from a database hash.

One managed OpenCode process currently serves several workspaces. The opaque HTTP capability and trusted bundled tool are the boundary. This does **not** isolate arbitrary shell/code/process owners from that process’s environment, private files, host token, or other configured tools. A directory convention is not a security sandbox. Remote/unmanaged engines receive no automatic capability provisioning. No claim is made that these mail grants constrain unrestricted local shell access.

## Data and matter scope

Search authorizes before counts, snippets, and results. Read/part/content requests authorize before data access and revalidate afterward. Matter scope uses fresh backend receipt ACLs and the exact local source version (raw, projection/body, and attachment identities/hashes), not a text matter tag or an old receipt sharing the same provider key. Connected-storage save receipts do not confer LegalMemory matter access. A changed, unfiled V2 must not be exposed under a filed V1 receipt.

`mail_scopes`, `mail_search`, `mail_read`, `mail_body`, `mail_parts`, `mail_content`, `mail_draft`, `mail_propose_send`, and `mail_propose_delete` expose bounded typed requests. Search uses `keywords`, `phrase`, or other existing filters. Part enumeration supports cursors. `mail_body` returns readable plain text with character offsets (default 4,000, maximum 12,000 per request), completeness and conversion notices. Continue matter-body pages with the returned sourceVersion so a changed source fails closed. It reads projections up to 2 MiB; larger/missing bodies return an explicit incomplete notice. No model-side base64 decoding is required for normal message reading. Content chunks are at most 24,576 bytes; raw originals require `export`, attachments require `attachments`, and bodies require `read`. There is no arbitrary SQL, provider credential, filesystem destination, redirect URL, attachment upload, or external-save argument. Email outputs are marked untrusted data. Message text never grants permissions, selects another account, or approves an action.

Returned mail enters the agent task transcript and may be sent to that task’s configured remote model, including attachment bytes explicitly requested through these tools. Local mail encryption does not make remote model processing local. Separate general-purpose agent tools and their own user permissions govern any later processing or external storage action. These mail tools neither authorize nor perform a remote upload on behalf of an email instruction.

## Drafts and deliberate approval

Agent drafts are plain text and use a currently permitted sender identity returned with a draft-capable scope. Agent-created drafts cannot insert arbitrary attachment references or HTML. Attachments can be read/exported within their explicit permission; adding attachments to a draft remains a human composer action. Existing MIME/outbox provider limits still apply. The worker saves the draft and its grant/source binding in one transaction with a fresh grant and matter-source fence. A grant cannot enumerate or edit another grant’s drafts.

Sending and moving to Trash are proposals, never automatic tool effects. Each encrypted proposal records immutable draft ID/version/content hash (including sender, recipients, Bcc, and attachment refs) or exact message locator/precondition/hash, grant revision, engine task/message provenance, and an expiry of at most 15 minutes. Mail Settings shows the exact message and a separate review checkbox and approval button. Generic `ApprovalService` auto mode is not consulted. Rejection requires no renewed source access. Approval rechecks the grant, account generation, matter ACL/source version, expiry, and unchanged draft/message. The worker’s outbox commit fence checks again after MIME preparation and records the approval’s action ID in the same transaction as immutable MIME and the submission journal. Repeated clicks cannot enqueue another send. Trash uses the existing provider precondition and mutation journal; permanent deletion is not exposed.

An approved send becomes the user’s durable outbox instruction. Subsequent agent-grant revocation does not retract an already approved provider submission; cancellation follows the ordinary outbox rules. Acceptance is not delivery, uncertainty is never automatically retried, and cancellation is only guaranteed before dispatch.

Restore revokes every grant and every pending proposal before opening the restored profile. Approved/rejected proposal evidence remains, while existing EIG-151 outbox/draft quarantine prevents replay. Reconnect cannot revive a revoked capability or convert old accepted/uncertain submission evidence into a fresh send.

## Focused validation and remaining gates

Use isolated synthetic fixtures only:

- `pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite storage/agent-grants`
- `pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite runtime/agent-approval`
- `pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite storage/agent-source`
- From `apps/server`: `pnpm exec bun test src/mail/agent-routes.test.ts src/mail/agent-plugin.test.ts`
- From `apps/app`: `pnpm exec bun test tests/mail-agent-render.test.ts`

The renderer probe uses an isolated Electron profile, not the running app. No real provider sends, real profile backup, or mailbox mutations are part of these checks. Live-provider certification, whole-app integration, and platform/security release gates remain the final EIG-173/174/154 work; this ticket does not claim them completed.
