# LegalWork design system

LegalWork uses a white, glass, and graphite interface. Quality comes from consistent proportions, readable hierarchy, crisp assets, and motion that explains a change. This system is implemented in the application components, with a separate live reference for reviewing their states.

## Review the live reference

From the repository root:

```sh
pnpm install
pnpm --filter @legalwork/app dev
```

Open `http://localhost:5173/design-system.html`. It needs no worker, account, API key, or desktop bridge. The gallery imports the production app stylesheet and components. Its sample interactions stay in local React state. The mini workspace is a component composition, not a running agent session.

For a fuller application review, open `http://localhost:5173/session-preview.html` on the same dev server. This isolated fixture renders the actual session, sidebar, and file panels with deterministic local sample data. Review the welcome entrance, type/send a sample message, select recent tasks, open the Files rail and folders, search Drive roots, open browser/preview panels, and collapse the sidebar. The fixture is explicitly simulated and needs no backend. It is also excluded from the production build.

For the actual settings shell, open `http://localhost:5173/settings-preview.html`. Use its Full page / Compact panel controls and navigate to Privacy to inspect real settings controls. Compact settings can also be opened at `settings-preview.html?compact&tab=preferences`. These fixtures use local sample state and never contact a provider.

The normal `pnpm dev` command still starts Electron. `pnpm dev -- --host 0.0.0.0 --port 4173` serves the app for supervised browser review from the monorepo root. That review mode disables hot reload; refresh deliberately after changes. `pnpm dev:ui` retains normal hot reload.

Build the reference separately:

```sh
pnpm --filter @legalwork/app exec vite build --config vite.design-system.config.ts
pnpm --filter @legalwork/app exec vite preview --config vite.design-system.config.ts
```

Open `http://localhost:4173/design-system.html` after preview starts. The output is `apps/app/dist-design-system/`. The normal desktop and web builds do not include the gallery entry. The gallery includes:

- Live semantic color swatches, type hierarchy, default/glass/inset surfaces.
- All button variants, sizes, icon actions, busy and disabled states. Hover, press, and keyboard focus are real interactions, not painted examples.
- Editable, invalid, and disabled fields; checkbox, switch, badges, and tabs.
- Actual folder and document assets at sidebar and presentation sizes.
- Menus, disabled menu actions, destructive actions, tooltips, and dialogs.
- A sample sidebar/chat/files composition and the actual chat welcome with illustrated suggestion cards and provider connection state.
- Replayable motion and a reduced-motion override that also reaches portaled overlays.

## Principles

1. **Keep the workspace quiet.** The canvas stays white. Sidebars use a slightly darker neutral. Text and selection use graphite. Status color is reserved for actual error, warning, and success meaning; it does not decorate navigation or distinguish ordinary file types.
2. **Make structure legible.** Use a spacing rhythm, a small type hierarchy, and fine borders. A content panel should not need a heavy shadow to be understood. Reserve elevation for floating layers; keep document reading surfaces opaque.
3. **Use glass selectively.** Glass belongs in chrome, icon tiles, composers, and transient surfaces where it adds a material cue. Strong glass remains legible over content, and CSS provides a solid fallback without backdrop filtering.
4. **Keep density deliberate.** Compact navigation can be dense without tiny labels, uneven row heights, or crowded actions. Truncate long file/session names inside a flexible column while preserving the icon and action hit areas.
5. **Make every interaction feel related.** Controls share corners, focus treatment, press feedback, and transition timing. Base UI owns keyboard behavior, dismissal, focus management, and popup positioning.
6. **Give motion a job.** A greeting can arrive gently; a menu can reveal its origin; a selected row can respond immediately. Avoid decorative loops, repeated entrances during streaming, and layout animation on large file lists.

## Ownership and source of truth

| Layer | Location | Owns |
| --- | --- | --- |
| Canonical tokens | `packages/ui/src/styles/tokens.css` | Color, typography families, spacing, control sizes, radii, elevation, motion, glass, asset materials |
| App token adapters | `apps/app/src/app/index.css` | Tailwind, shadcn/Base UI semantic variables, and legacy `--dls-*` aliases pointing at the canonical tokens |
| Shared material rules | `apps/app/src/styles/design-system.css` | Glass fallback, surface/field/control treatment, entrance classes, reduced motion, increased contrast |
| App primitives | `apps/app/src/components/ui/` | Buttons, fields, cards, menus, dialogs, sheets, tabs, sidebar primitives, and other Base UI wrappers actually used by the app |
| Product design patterns | `apps/app/src/react-app/design-system/` | Surface, SectionHeading, IconTile, PanelHeader, PanelEmptyState, folder/document/workspace assets, and extension patterns |
| Chat patterns | `apps/app/src/components/chat/` | Welcome, illustrated suggestions, composer, attachments, messages, and activity presentation |
| Application layouts | `apps/app/src/react-app/domains/` | Layout, data, selection, resizing, and behavior for each screen and sidebar |
| Live reference | `apps/app/design-system.html` and `src/react-app/design-system/preview.tsx` | Review-only compositions of production components |

`packages/ui` also contains an older standalone React component library and preview. It continues to share the tokens, but changing one of those components does not automatically change the app. For app work, use `@/components/ui` and the product patterns above. Do not add another button or card implementation to resolve a local visual discrepancy.

## Token use

Use semantic utilities (`bg-background`, `text-muted-foreground`, `border-border`) in application components. Use `--lw-*` directly for a material or motion property that has no semantic utility. Keep values in the canonical token file, not in a page stylesheet.

| Family | Key tokens | Intended use |
| --- | --- | --- |
| Surface | `--lw-canvas`, `--lw-surface`, `--lw-sunken`, `--lw-sidebar` | Main workspace, reading/content surfaces, inset groups, navigation |
| Glass | `--lw-glass`, `--lw-glass-strong`, `--lw-glass-highlight`, `--lw-glass-blur` | Translucent chrome and overlays |
| Text | `--lw-text-primary`, `--lw-text-secondary`, `--lw-text-tertiary` | Main content, supporting content, low-emphasis metadata |
| Interaction | `--lw-primary`, `--lw-hover`, `--lw-active`, `--lw-selected`, `--lw-focus-ring` | Actions and their distinguishable states |
| Borders | `--lw-border-subtle`, `--lw-border`, `--lw-border-strong` | Dividers, normal controls, emphasized boundaries |
| Corners | `--lw-radius-sm` through `--lw-radius-3xl` | Small labels, compact rows, controls, panels, dialogs |
| Rhythm | `--lw-space-1` through `--lw-space-6`, `--lw-space-8` | Shared 4/8/12/16/20/24/32 px spacing rhythm |
| Controls | `--lw-control-sm`, `--lw-control-md`, `--lw-control-lg` | Compact, normal, and larger control heights |
| Motion | `--lw-duration-fast`, `--lw-duration-base`, `--lw-duration-slow`, `--lw-duration-enter` | Feedback, small changes, overlays, first entrance |
| Curves | `--lw-ease-standard`, `--lw-ease-out` | State changes and arrivals |

The neutral ramp is for assets and exceptional low-level styling. New screen code should not choose a raw gray based on its appearance in one screenshot. Existing dark-theme compatibility remains at the token layer; the default design direction is light.

## Component contracts

```tsx
import { Button } from "@/components/ui/button";
import { IconTile, SectionHeading, Surface } from "@/react-app/design-system/surface";
import { FolderIcon } from "@/react-app/design-system/folder-icon";

<Surface variant="glass" className="p-5">
  <SectionHeading
    title="Matter documents"
    description="Everything this workspace can use."
    action={<Button variant="outline" size="sm">Add files</Button>}
  />
  <IconTile className="mt-4"><FolderIcon open /></IconTile>
</Surface>
```

- `Surface`: `default`, `glass`, or `inset`. It owns material and shape; the caller owns padding and layout.
- `SectionHeading`: `page`, `section`, or `sidebar`. It owns semantic heading level and hierarchy; `description` and `action` are optional.
- `IconTile`: `sm`, `md`, or `lg`; `default`, `glass`, or `inset`. Use it to give feature/action icons a consistent container, not around every dense file-tree glyph.
- `PanelHeader` and `PanelEmptyState`: shared compact chrome and empty/loading/unavailable-state layout for file browsers and preview panes. Headers keep the title, metadata, and action areas aligned; empty states use the same icon tile and text measure.
- `Button`: existing `default`, `outline`, `secondary`, `ghost`, `destructive`, and `link` variants. Use a real `disabled` state and `aria-busy` for busy actions. Icon-only actions need an accessible name. A tooltip supplements that name.
- `FolderIcon`: layered neutral SVG with `open` state. `WorkspaceIcon` delegates to it. Each SVG has unique gradient IDs so multiple instances remain reliable.
- `DocumentIcon`: one folded-paper asset family with content glyphs for documents, sheets, slides, media, PDF, and code. Existing `ArtifactIcon` adapts artifact types to this component.
- Menus/dialogs/sheets: retain the Base UI wrappers. Use the trigger `render` API to compose the app button; avoid nested buttons. Keep destructive actions semantically distinct.

## Motion and accessibility

`MotionConfig reducedMotion="user"` is applied to the application provider tree. CSS also respects `prefers-reduced-motion`, covering existing CSS animations, transitions, and shared entrance classes. `.lw-enter` gives a short fade with an 8 px arrival; `.lw-fade-enter` changes opacity only. The chat welcome is keyed to the empty session so its entrance does not replay for every update. Never animate a virtualized list's geometry.

Reduced motion keeps the final visible content and control feedback without spatial animation. It must not leave an initially hidden component invisible. The gallery offers a simulation, but reviewers should also test the operating system/browser preference because CSS and Motion are separate rendering paths.

Keyboard focus must be visible on all interactive elements, including actions normally revealed on hover. Maintain accessible names for icon actions and descriptions for invalid fields. Selection, errors, and connection status need a label, icon, or shape in addition to color. High-contrast mode strengthens borders and makes glass solid. Check contrast against the surface under the text, including glass, and check both enabled and selected states.

## Sidebar audit and regression checklist

Sidebars are a family of surfaces, not just the left navigation. Review them at their minimum supported widths and with long real names.

| Surface | Main implementation | Review points |
| --- | --- | --- |
| Main navigation | `domains/session/sidebar/app-sidebar.tsx` and `components/ui/sidebar.tsx` | Workspace switch, new conversation, selected session, groups, tasks, archive, context menus, hover and keyboard-revealed actions |
| Local files | `domains/session/panel/workspace-files-panel.tsx` | Open/closed folders, nested rows, selected document, loading/empty/error states, long names, rename/delete controls |
| Memory files | `domains/session/panel/legalmemory-files-panel.tsx` | Drive navigation, virtualized tree, search, result rows, metadata, selection, disabled or unavailable connections |
| Right-side rail and workspace panels | `domains/session/chat/session-page.tsx` and `domains/session/panel/` | Rail tooltips, active panel, resize boundaries, collapsed state, empty panel, panel headers |
| Artifact and browser tabs | `components/panel-tabs.tsx` and `domains/session/artifacts/` | Document glyph, active tab, truncation, close focus/hover, reorder, loading/unavailable preview |
| Settings | `domains/settings/shell/settings-page.tsx` and `tabs.tsx` | Full and compact navigation, active section, back navigation, account/connection states, narrow content |
| Floating and mobile navigation | `components/ui/sheet.tsx`, `components/ui/sidebar.tsx` | Focus trap, Escape, backdrop, dismissal, narrow viewport, reduced motion |

Review the chat start, suggestion cards, attachment chips, composer focus, send/busy/disabled controls, messages, and thinking states alongside these panels. Do not let a more polished central chat expose an inconsistent surrounding shell.

## Extending and migrating

1. Find the actual component used by the target screen. The gallery and the ownership table identify the app's active paths.
2. Fix a repeated inconsistency in the shared primitive or pattern first. Keep screen-level behavior and data flow intact.
3. Replace raw colors and one-off material values with semantic tokens. Retain intentional semantic status color and third-party brand assets.
4. Prefer a component contract for repeated structure. Use a small local class for screen-specific layout; do not create a global selector that accidentally restyles unrelated controls.
5. Add a gallery specimen when introducing a reusable variant or state. Keep the gallery independent of authentication and server providers.
6. Verify type checking and production build, then review the changed screen and the relevant sidebar states in the real app. The gallery is a component reference, not a substitute for an end-to-end session.

Suggested validation commands:

```sh
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/app build
pnpm --filter @legalwork/app exec vite build --config vite.design-system.config.ts
```

For visual review, inspect the gallery at a desktop width, 1024 px, and a narrow mobile width. Test menus/dialogs with the keyboard, toggle reduced motion, and capture a short recording of entering a chat and opening each sidebar in the actual desktop app. Record which checks ran and any environment limitations in the pull request.


## Validation evidence for this revision

Browser review used the actual production components with the development fixtures, at a 1363 × 936 browser viewport. Provider responses, workspace data, and file reads were simulated. This validates rendering and local UI interaction; it does not certify Electron native views, OS file dialogs, live model streaming, or provider integrations.

Checked in the browser:

- Chat welcome and illustrated suggestion cards; selecting a suggestion fills the actual composer, enables Run task, and sends a simulated conversation turn.
- Main sidebar selection and folder layout; Files panel hierarchy and file metadata.
- Memory Drive expansion, filename search, empty search results, and opening a markdown result.
- Markdown document preview, tab selection, toolbar, and empty preview state.
- Full settings overview and compact Privacy settings. Visual findings prompted fixes to cramped document headers and compact settings control layout.
- Compact navigation menu opening and Escape dismissal; focus returns to its trigger after dismissal.
- Gallery welcome replay with reduced-motion simulation enabled; all final content remains visible.

Screenshots contain only the fixture's sample data:

| Screen | Evidence |
| --- | --- |
| Chat welcome | [chat-welcome.jpg](design-system/chat-welcome.jpg) |
| Conversation and files | [chat-files.jpg](design-system/chat-files.jpg) |
| Memory Drive and preview empty state | [memory-drive.jpg](design-system/memory-drive.jpg) |
| Document preview | [document-preview.jpg](design-system/document-preview.jpg) |
| Full settings | [settings.jpg](design-system/settings.jpg) |
| Compact settings | [settings-compact.jpg](design-system/settings-compact.jpg) |
| Compact navigation menu | [settings-menu.jpg](design-system/settings-menu.jpg) |

A native Electron pass should additionally exercise dragging/reordering, OS appearance and reduced-motion preferences, live streaming, voice controls, browser webviews, and native file actions.

Implementation references: [Motion accessibility](https://motion.dev/docs/react-accessibility), [Base UI accessibility](https://base-ui.com/react/overview/accessibility). The app reuses its installed Motion and Base UI versions.
