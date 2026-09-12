# Mail interaction and density review (EIG-172)

The review uses the actual production React entry, shared sidebar and Lexical chat composer in an isolated Electron profile. Every account, message, attachment and workspace is synthetic. No normal app profile, provider, OS clipboard or model is used.

## Implemented choices

- Mailbox rows put sender and a small account/date context above the subject. Search uses the same hierarchy, followed by its matched snippet. Search returns one optional indexed sender address field from the already-materialized page of at most 25 indexed documents; no schema, count/scope changes, raw reads or per-result request.
- Checkboxes reveal on hover, keyboard focus, touch or selection; Select messages makes selection explicit. Command/Ctrl click and Shift click supplement the existing keyboard and context-menu workflows. The action bar says Message when acting on the open reader, and a count for explicit selection.
- The reader removes repeated account headers and reduces stacked spacing. The common action surface and shared sidebar stay in place.
- A pointer and keyboard accessible separator resizes the list (Arrow keys, double-click reset). Only its layout preference is stored locally. Narrow windows use the existing reader/back navigation.
- Load more appends 25 messages up to 250 visible rows. Older messages starts another bounded window; Back restores cached rows and scroll. Four windows are retained, so list history holds at most 1000 message summaries; checkbox selections are pruned with that history. Provider pagination buffers have their own existing per-account bounds. Newest messages resets this history. The open reader remains stable through paging. Sync changes while browsing deeply announce new mail instead of replacing the list.
- Mail settings put connected accounts first, with notification and advanced controls in accessible disclosure groups. Loading and failed requests have distinct states; a failed list offers Retry instead of claiming it is empty.
- The actual chat composer renders validated source tokens as Source email chips. Serialized drafts and plain-text clipboard content retain the exact scoped URL. Source click/Enter/Space returns to the hash-checked original; arrow/delete/backspace remain atomic. Attachment upload and JSON provenance remain explicit and unchanged.

A bounded window was preferable to adding virtualization that would remove keyboard/context-menu targets from the DOM. Synthetic 250-row measurement: about 2860 list DOM elements, 59px rows, and about 1.8s for nine sequential append interactions including API and fixture polling. The follow-up including a synthetic arrival poll, bulk selection and cached-window return took 2.9s; the reader and scroll stayed stable. This is a reproducible local measurement, not cross-platform certification. Arbitrary swipe-to-delete and drag-to-move are deferred: explicit actions have clear scope and undo, while accidental gestures would add mutation risk without solving an observed reading problem.

## Focused checks

- `pnpm --dir apps/app exec bun test tests/mail-keyboard-workflow.test.ts tests/mail-context-render.test.ts tests/mail-list-window.test.ts tests/mail-chat.test.ts tests/mail-accounts-settings.test.ts`
- `pnpm --dir apps/app exec bun test tests/mail-journey-render.test.ts`
- `pnpm --dir apps/app exec tsc --noEmit -p tests/tsconfig.mail-journeys.json`
- `pnpm --dir apps/server exec bun test src/mail/storage/search.test.ts`

The journey fixture now writes screenshots to its temporary directory by default; `MAIL_JOURNEY_EVIDENCE` explicitly selects retained evidence.

## Actual shared-shell fixture

In separate terminals from the repository root:

1. `LEGALWORK_VISUAL_PREVIEW=1 pnpm --dir apps/app exec vite --host 127.0.0.1 --port 5482`.
2. `pnpm --dir apps/app exec bun tests/fixtures/mail-design/server.ts`
3. `pnpm --dir apps/desktop exec electron ../app/tests/fixtures/mail-design/preview.cjs`
4. Run `pnpm --dir apps/app exec node tests/fixtures/mail-design/review.mjs`, then `pnpm --dir apps/app exec node tests/fixtures/mail-design/composer-review.mjs` sequentially. Run `pnpm --dir apps/app exec node tests/fixtures/mail-design/matrix.mjs` for the size/state matrix. Do not run native focus tests or captures concurrently.

The fixture title is **LegalWork — Synthetic design fixture**. It stays hidden except for non-activating screenshot capture and a bounded native keyboard check. Loopback control 5484 belongs only to this fixture. Remote network requests are blocked. Evidence goes to the OS temporary `legalwork-eig172-evidence` directory. Do not point this harness at a real server or publish personal screenshots.

## Retained visual matrix

All images are synthetic captures of the actual shared shell. The 760px reader remains split; at 600px the list hides while reading and Inbox restores the list. Native capture and DOM visibility assertions verified both paths. A 600px follow-up verified the full HTML body (325px iframe) and outer scrolling to the attachment (676px scroll height / 542px viewport). The initial resize capture preceded the opaque frame repaint; settled evidence replaces it, and the fixture now allows 500ms for native repaint. Screenshot pixels are doubled on this Retina host.

| State | Evidence |
| --- | --- |
| Default mailbox / keyboard focus / bulk | [Mailbox](evidence/eig-172/after-mailbox.png), [focus](evidence/eig-172/after-keyboard-focus.png), [250-row bulk](evidence/eig-172/after-large-bulk.png) |
| Reader / conversation | [Reader](evidence/eig-172/after-reader.png), [conversation](evidence/eig-172/after-conversation.png) |
| Reader sizes | [1100](evidence/eig-172/after-reader-1100.png), [900](evidence/eig-172/after-reader-900.png), [760](evidence/eig-172/after-reader-760.png), [600 reader](evidence/eig-172/after-reader-600.png), [600 back](evidence/eig-172/after-list-600.png), [600 scrolled](evidence/eig-172/after-reader-600-scrolled.png) |
| Inline search | [Search](evidence/eig-172/after-search.png), [1100](evidence/eig-172/after-search-1100.png), [bulk](evidence/eig-172/after-search-bulk.png) |
| Compose / attachment / actual chat composer | [Compose](evidence/eig-172/after-compose.png), [1100](evidence/eig-172/after-compose-1100.png), [chooser](evidence/eig-172/after-attachment-chooser.png), [Lexical source chip](evidence/eig-172/after-chat-composer.png) |
| Settings | [Accounts](evidence/eig-172/after-settings.png), [notifications](evidence/eig-172/after-settings-notifications.png) |
| Small / empty / loading / error | [Small](evidence/eig-172/after-small.png), [empty](evidence/eig-172/after-empty.png), [loading](evidence/eig-172/after-loading.png), [retry](evidence/eig-172/after-error.png) |

Before captures in the same directory show the previous reader, search, compose and attachment layout. The old chat capture also includes a fixture snapshot error that was corrected in the harness; it is not a production defect. The final chat fixture intentionally has no AI connection and never submits a model request.

The actual Lexical probe verifies serialized reopen, in-memory plain-text clipboard preservation, atomic arrow/Delete/Backspace behavior, and Enter/Space source navigation with the unsent draft retained. Checkbox geometry checks require a gap before sender text in focus and bulk states. The window fixture covers forward/back/append, deep new arrivals, bounded history and stable selection. Reviewer acceptance remains separate from these checks; this ticket does not claim native cross-platform qualification.
