# Mail design rework (EIG-172)

The previous compact layout did not match the surrounding app settings. This pass replaces the Mail-specific disclosure stack and native form controls with the same section surfaces, joined rows, tabs, menus, selects, inputs and switches used elsewhere in Settings. The actual Privacy page and AI Providers pattern are the comparison references.

Connected accounts have separate name/address hierarchy and an explicit Add account flow. Reconnect and disconnect are in each account's options menu. Shared-mailbox setup is requested explicitly. Notifications use the standard settings row layout; sending, access, retention and portability use shared form controls. Permissions and destructive confirmations remain explicit.

Mail now uses one primary action header, a readable proportional message pane, a quiet reader surface and consistent sender/subject/preview hierarchy in mailbox and search rows. Routine synchronization does not add status strips, and mutations never open the activity panel automatically. Activity and undo remain explicitly available from the history icon. A bounded list preview reuses the current indexed body; raw/projection changes invalidate it transactionally until indexing finishes, with no raw-body reads per row or schema addition.

The isolated full-shell preview uses `tests/fixtures/mail-design/vite.config.ts` to resolve one React instance and load the production font from shared worktree dependencies. Its profile and synthetic API remain separate from the normal app. No provider, model or real account actions are used.

Validation on the shared synthetic production-shell instance:

- `pnpm --dir apps/server exec bun test src/mail/storage/read-preview.test.ts`: passed the encrypted source replacement/rebuild, Unicode bound and owner isolation regression.
- `pnpm --dir apps/app exec tsc --noEmit -p tests/tsconfig.mail-journeys.json`: passed.
- `settings-review.mjs`: actual shared Provider selection/cancel, account options, notification preview changes, all four tabs and account/workspace selection passed. Hidden mounted Select options are excluded, and selected trigger values are asserted. Access remains disabled without explicit authorization; no grant, credential or recovery operation is performed.
- `review.mjs`: 250 rows / 3,107 list DOM nodes; bounded window pagination, modifier range selection, checkbox spacing, deep arrival/scroll retention passed. The measured workflow took 4,655 ms in this fixture, including incremental page requests. Actual production chat composer received the compact source chip and returned to the source without sending a model request.
- `rework-matrix.mjs`: settled multi-message conversation, 1,100-pixel reader, 600-pixel reader/back, 1,800-pixel mailbox, inline search and compose passed. No activity panel opened automatically.

The no-launch scripts live in `apps/app/tests/fixtures/mail-design/`. They target only the isolated control/API ports 5484/5483. The fixture uses a separate profile, temporary Vite cache and a clearly labelled native window. The bounded `/visibility` control shows that window without activating it during actual reading checks and hides it afterward. A hidden-window diagnostic recorded a deferred child viewport resize despite a correct parent height; showing the same window completed the compositor resize. That fixture observation is not reported as a production rendering defect.

EIG-139 owns functional conversation qualification. Its visible 20-open, plain/HTML, idle preservation, explicit unread and one-shot initial content recovery checks passed in this instance; its final extended-thread pagination check is tracked separately by that owner. The affected standalone Settings/onboarding tests were adapted statically for shared controls and will run in the final remote app gate; no extra local Electron test process was launched.

Selected synthetic before/reference and final evidence is in [eig-172-rework](evidence/eig-172-rework/). The earlier `eig-172` images remain historical evidence of the superseded layout. This design pass does not certify live provider behavior or repeat platform qualification.
