# Mail interaction and density review (EIG-172)

The review uses the actual production React entry, shared sidebar and Lexical chat composer in an isolated Electron profile. Every account, message, attachment and workspace is synthetic. No normal app profile, provider, OS clipboard or model is used.

## Implemented choices

- Mailbox rows put sender and a small account/date context above the subject. Search uses the same hierarchy, followed by its matched snippet. Search returns one optional sender field from the already-materialized page of at most 25 indexed documents; no schema, count/scope changes, raw reads or per-result request.
- Checkboxes reveal on hover, keyboard focus, touch or selection; Select messages makes selection explicit. Command/Ctrl click and Shift click supplement the existing keyboard and context-menu workflows. The action bar says Message when acting on the open reader, and a count for explicit selection.
- The reader removes repeated account headers and reduces stacked spacing. The common action surface and shared sidebar stay in place.
- A pointer and keyboard accessible separator resizes the list (Arrow keys, double-click reset). Only its layout preference is stored locally. Narrow windows use the existing reader/back navigation.
- Load more appends 25 messages up to 250 visible rows. Older messages starts another bounded window; Back restores cached rows and scroll. Four windows are retained, so list history holds at most 1000 message summaries. Newest messages resets this history. The open reader remains stable through paging. Sync changes while browsing deeply announce new mail instead of replacing the list.
- The actual chat composer renders validated source tokens as Source email chips. Serialized drafts and plain-text clipboard content retain the exact scoped URL. Source click/Enter returns to the hash-checked original; arrow/delete/backspace remain atomic. Attachment upload and JSON provenance remain explicit and unchanged.

A bounded window was preferable to adding virtualization that would remove keyboard/context-menu targets from the DOM. Synthetic 250-row measurement: about 2860 list DOM elements, 59px rows, and about 1.8s for nine sequential append interactions including API and fixture polling. This is a reproducible local measurement, not cross-platform certification. Arbitrary swipe-to-delete and drag-to-move are deferred: explicit actions have clear scope and undo, while accidental gestures would add mutation risk without solving an observed reading problem.

## Focused checks

- `pnpm --dir apps/app exec bun test tests/mail-keyboard-workflow.test.ts tests/mail-context-render.test.ts tests/mail-list-window.test.ts tests/mail-chat.test.ts`
- `pnpm --dir apps/app exec bun test tests/mail-journey-render.test.ts`
- `pnpm --dir apps/app exec tsc --noEmit -p tests/tsconfig.mail-journeys.json`
- `pnpm --dir apps/server exec bun test src/mail/storage/search.test.ts`

The journey fixture now writes screenshots to its temporary directory by default; `MAIL_JOURNEY_EVIDENCE` explicitly selects retained evidence.

## Actual shared-shell fixture

In separate terminals from the repository root:

1. `LEGALWORK_VISUAL_PREVIEW=1 pnpm --dir apps/app exec vite --host 127.0.0.1 --port 5482`.
2. `pnpm --dir apps/app exec bun tests/fixtures/mail-design/server.ts`
3. `pnpm --dir apps/desktop exec electron ../app/tests/fixtures/mail-design/preview.cjs`
4. Run `pnpm --dir apps/app exec node tests/fixtures/mail-design/review.mjs`, then `pnpm --dir apps/app exec node tests/fixtures/mail-design/composer-review.mjs` sequentially.

The fixture title is **LegalWork — Synthetic design fixture**. It stays hidden except for a bounded native keyboard check. Loopback control 5484 belongs only to this fixture. Remote network requests are blocked. Evidence goes to the OS temporary `legalwork-eig172-evidence` directory. Do not point this harness at a real server or publish personal screenshots.

Final screenshot matrix and reviewer acceptance are pending the final visual review; this checkpoint does not claim platform qualification.
