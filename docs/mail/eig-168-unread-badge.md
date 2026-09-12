# EIG-168 — unread app icon badge

The encrypted worker computes one unread Inbox count across connected accounts belonging to the local owner. Inbox folder roles select the scope; `EXISTS` membership checks avoid multiplying Gmail messages through labels. Gmail uses UNREAD membership, Graph/IMAP use stored read state. Disconnected/locked archives, tombstones, Gmail spam/trash and IMAP Junk/Trash special-use folders are excluded. Unknown read state does not count.

Desktop main polls this aggregate every two seconds independently of the renderer, selected component and window visibility. Only changed counts reach the OS. Existing stores (including the active rotated-store pointer) unlock through the normal OS-vault preflight on launch; first-use profiles remain lazy. EIG-167 restores eligible synchronization during unlock. A failed/locked worker clears Mail's contribution; a ready/reconnected worker restores it on the next tick. Stop and preference changes invalidate pending reads.

The shared badge owner composes named numeric contributors. No existing native badge writers were present. macOS uses the Dock badge; Windows uses a native 32px BGRA taskbar overlay on application windows, recreated for new windows and cleared at zero. Windows displays 99+ for larger counts, with the full count in its accessible description. Settings → Mail accounts has a shared Switch for the app badge. Its desktop profile preference is persisted separately from notifications and sounds.

## Focused verification (2026-09-12)

- `pnpm exec node apps/server/scripts/mail-acceptance.mjs --suite storage/unread-badge` — passed real encrypted SQLite + private worker tests on macOS arm64 / Node 24.11.0. Covers combined accounts, owner isolation, membership deduplication, spam/trash exclusion, read/unread changes, movement, tombstones, disconnect/reconnect, and encrypted worker reopen.
- `pnpm exec node --test apps/desktop/electron/app-badge.test.mjs` — four tests passed: contributor composition, Windows overlay contract/bitmap/clear, background refresh and stale-read shutdown handling, persisted preference restoration.
- `pnpm exec bun test apps/app/tests/mail-accounts-settings.test.ts` — Settings Switch loads and saves through the desktop bridge in an isolated Electron renderer; existing onboarding lifecycle assertions pass.
- `pnpm --dir apps/desktop exec electron electron/mail-badge-native-probe.cjs` — actual macOS arm64 / Electron 35.7.5 Dock set/get verified for 7, 123 and zero, plus another component's count surviving Mail clearing. The probe uses a temporary profile and never starts LegalWork runtime, opens accounts, accesses the vault, or changes OS HOME.
- Focused JS typecheck of `app-badge.mjs`, desktop bridge coverage check, syntax checks for modified main/runtime files, and `git diff --check` passed.

Actual Windows taskbar behavior and macOS x64 remain for the final platform qualification. The Windows unit test is not native Windows verification. No full app suite, packaging/build, live-provider certification or final design review was performed here; those remain at the final integration gate.
