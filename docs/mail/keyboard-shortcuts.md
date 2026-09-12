# Mail keyboard workflows (EIG-175)

Mail uses the existing toolbar, reader and composer actions. Shortcuts do not call providers or bypass the action queue, current permissions, loading state, or send validation. The keyboard toolbar button and `?` open platform-specific help; the same catalog supplies toolbar and context-menu hints.

Microsoft sources checked on 2026-09-12: [Outlook Windows/web](https://support.microsoft.com/en-us/accessibility/outlook/keyboard-shortcuts-for-outlook) and [Outlook for Mac](https://support.microsoft.com/en-us/accessibility/outlook/mac/keyboard-shortcuts-in-outlook-for-mac). Outlook editions differ; this is a compatible selection, not a claim of complete Outlook emulation.

| Action | Windows | Mac |
| --- | --- | --- |
| Compose | Ctrl+Shift+M; N or C | Cmd+Shift+M; N or C |
| Reply / reply all | Ctrl+R / Ctrl+Shift+R; R / Shift+R | Cmd+R / Cmd+Shift+R; R / Shift+R |
| Forward | Ctrl+F or Shift+F | Shift+F |
| Mail search | Ctrl+E, F3 or / | Cmd+Option+F or / |
| Read / unread | Ctrl+Q / Ctrl+U; Q / U | Ctrl+Q / Ctrl+U; Q / U |
| Flag / unflag | Insert or Shift+L | Insert or Shift+L |
| Archive | E | E or Ctrl+E |
| Move to Trash | Delete | Delete or Backspace |
| Save draft | Ctrl+S | Cmd+S |
| Review send | Ctrl+Enter | Cmd+Enter |
| Previous / next message | Ctrl+, / Ctrl+. | Ctrl+[ / Ctrl+] |
| Focus folders | Ctrl+Y | Ctrl+Y |

New Outlook uses Ctrl+N, while classic Windows also provides Ctrl+Shift+M. Mac uses Cmd+N and Cmd+J for new/forward, and Cmd+T / Cmd+Shift+T for read/unread. LegalWork preserves shared new-task, terminal, session-tab, command-palette and global-search shortcuts (Mod+N/J/T/K/Shift+F), so Mail supplies the alternatives above. It also preserves ordinary OS/window commands. Mac due-date flag shortcuts that overlap OS desktop switching are not registered.

Arrows browse the loaded list; Home/End reach its bounds. Enter focuses the reader. Shift+arrows select or shrink an anchored range, Space toggles a row, Mod+A selects this loaded page, and Escape clears selection or returns to the list. Inline search applies a complete selection intent once, aborting superseded metadata reads; commands remain unavailable until the current selection resolves. F6/Shift+F6 cycle folders, list and reader. Folder arrows/Home/End move focus, letters find a name, and Enter activates the focused folder. Closing a composer restores its originating focus when available.

Only focused Mail handles these keys. Editable fields and rich text retain typing, selection and formatting; dialogs and menus retain their own navigation. Send/save are deliberate composer-only exceptions. Repeated, composing and AltGraph events are ignored. Matching uses the delivered `KeyboardEvent.key`, so shortcuts follow the keyboard layout rather than imposing physical US key positions. Modified characters unavailable on a layout retain toolbar/menu access.

The send chord opens a recipient review with Cancel initially focused. Repeating it cannot confirm. The user must focus and activate Confirm send; the existing durable outbox then reports progress. Shift+Delete is not registered: permanent deletion stays behind the existing confirmation. No keyboard fixture contacts or mutates live mail.

Electron's native Reload/Force Reload accelerators have a focused-Mail handshake, because native menu roles can precede renderer key handlers. Explicit menu clicks still reload; accelerators outside Mail retain reload. The handshake checks navigation/window focus and has a 300 ms deadline before dispatch. Expiry/error suppresses this invocation instead of risking a late reply plus a reload. It installs no global OS shortcut. See [Electron menu shortcuts](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts).

The opaque HTML reader forwards only reply, forward, search, help and navigation keys through the existing nonce bridge. Sender code remains disabled; trusted input, source/origin/nonce, focused frame, selection/editability, current signal and a strict payload allowlist are checked. No send or mailbox mutation commands cross this bridge.

Focused evidence:

- `pnpm --dir apps/app exec bun test tests/mail-keyboard-workflow.test.ts`: actual MailRoute, synthetic HTTP, isolated Electron profile, both platform mappings, deferred search selection, bulk commands, native menu activation, native opaque-reader input, focus and send review.
- `pnpm --dir apps/desktop exec node --test electron/mail-menu-shortcuts.test.mjs`: expiry, delayed execution, navigation/focus changes and failures.
- Existing `tests/mail-desktop.test.ts` and the combined EIG-176 context-menu fixture remain relevant regression checks.

This is feature qualification. Packaged macOS arm64/x64 and Windows x64, OS-reserved combinations, non-US physical keyboards, accessibility tools, and the final interaction/design review remain the final platform passes; no full-app/platform suite was run here.
