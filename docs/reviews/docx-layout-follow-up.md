# DOCX layout follow-up

The stacked app now removes the extra Reviewer / version history / clean-copy / Print toolbar. Reviewer attribution retains the previously stored name (or supplied author), and automatic recovery, local save snapshots, dirty-state protection, and agent actions remain active. This supersedes the toolbar described in the earlier hardening review.

Expansion is a single icon in the existing document header. The entire panel expands, keeping Save and the restore icon available without remounting the editor. On macOS it starts below the 44px title bar, leaving the traffic-light controls unobstructed.

The page fits the panel width on opening or resizing. The native manual zoom controls remain usable; zooming beyond the available width provides horizontal scrolling. The unscaled minimum-width calculation from Eigenpal is replaced with the scaled page width. Below 900px, selecting an inline comment or change opens its native card over the document; wide views retain the separate review rail. Rulers and the floating outline button are omitted from this compact host.

Validation on the production components in the synthetic DOCX harness:

- 420px viewport: 372px page, 24px margins; document scroll width and body width both 420px.
- 620px panel: 572px page, 24px margins; no horizontal overflow at fit zoom.
- Expanded macOS-style view: top edge at 44px, no document controls in the title-bar area.
- Expand/restore retains the live editor. Manual zoom changes persist until a panel resize.
- Selecting a review mark opens the native comment card and reply control.
- `pnpm --filter @legalwork/app test`: 308 passed, 0 failed.
- `pnpm typecheck`, `pnpm build:ui`, and `git diff --check`: passed.

Screenshots use only the synthetic fixture: [narrow panel](docx-narrow-layout.png), [expanded macOS-style view](docx-expanded-mac-layout.png). The title-bar check uses the app's macOS CSS classes in the browser harness; native window controls are not rendered in that screenshot.

## Selected review cards

The stack merge omitted the voice branch's handler that kept a clicked native review card expanded. The host now remembers the clicked revision ID and restores that native card after rendering, resolving both halves of replacements and coalesced revisions against the current document.

Selected cards are positioned from the clicked text's rendered rectangle, independently of the sidebar's collision stack. They follow scrolling, resizing and page zoom, remain readable at 340px where space permits, stay inside the editor viewport, and move below/above the text when there is no room beside it. A card hides while its anchor is offscreen. Other cards are hidden during this focused selection so they cannot overlap it; native actions and replies remain available.

The interaction regression uses the production editor with the original synthetic fixture. It checks deletion and insertion clicks, delayed caret updates, dismissal, 620px and 420px panels, expansion, Accept and Reject, and save/reopen. Revision replies remain independent paragraph comments and survive rejection.

The positioning regression uses a three-page synthetic document with 13 revisions, including 12 adjacent table replacements on page two. It verifies the correct card, a vertical gap of at most 13px from the selected text, viewport containment, no overlap with the selected text, and readable card width. Cases cover scrolling offscreen and back, placement near the bottom edge, replying, accepting another revision, 420px/620px panels, expansion, and manual zoom.

Reproduce from the repository root with `PORT=5174 pnpm dev:ui`, then:

```sh
mkdir -p output/playwright
pnpm dlx @playwright/cli --session docx-card open http://localhost:5174/docx-review.html
pnpm dlx @playwright/cli --session docx-card run-code --filename=apps/app/scripts/docx-review-cards.js
pnpm dlx @playwright/cli --session docx-card close
pnpm dlx @playwright/cli --session docx-position open 'http://localhost:5174/docx-review.html?fixture=positions'
pnpm dlx @playwright/cli --session docx-position run-code --filename=apps/app/scripts/docx-review-position.js
pnpm dlx @playwright/cli --session docx-position close
```

Both browser checks passed, together with `pnpm typecheck`, `pnpm build:ui`, `git diff --check`, and `node --experimental-strip-types --test apps/app/tests/docx-document-state.test.ts apps/app/tests/docx-roundtrip.test.ts` (10 tests). The browser logs the existing fixture favicon 404, dependency externalization warning, and Eigenpal controlled-input warnings during review/reopen; these did not prevent the interaction and persistence checks. This uses sample data in the browser harness, not a client's document.

[Selected revision in a narrow panel](tracked-card-620.png) · [Selected revision in the expanded editor](tracked-card-expanded.png)

[Table revision in a narrow panel](table-card-620.png) · [Table revision in the expanded editor](table-card-expanded.png)
