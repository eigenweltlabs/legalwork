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
