# Markdown WYSIWYG editor

Selected **MDXEditor 4.2.3** (MIT), pinned in the app and loaded only when a Markdown tab opens.

| Candidate | Assessment |
| --- | --- |
| [MDXEditor](https://mdxeditor.dev/editor/docs/getting-started) | React integration; visual headings, lists/checklists, tables, links, images, code blocks, front matter, undo, and source/diff mode. Best fit for editing existing Markdown files with a conventional toolbar. [MIT license](https://github.com/mdx-editor/editor/blob/main/LICENSE). |
| [Milkdown Crepe](https://milkdown.dev/docs/api/crepe) | Strong MIT alternative with a polished block-oriented UI and ProseMirror foundation. Requires more integration work for the desired source/diff workflow. [Source/license](https://github.com/Milkdown/milkdown). |
| [BlockNote](https://www.blocknotejs.org/docs/foundations/supported-formats) | Attractive block editor, but Markdown import/export is explicitly lossy; its native JSON is the recommended durable format. Poor fit for existing `.md` artifacts. Core MPL-2.0; XL packages have separate terms. |

## Behavior

Markdown tabs open directly in the visual editor, including files selected with the plus menu or dropped into the viewer. The toolbar includes a source view for uncommon syntax, and a diff against the saved baseline. Existing front matter is preserved. Local images can be uploaded beside the document under `_assets/`; Markdown retains relative image paths.

Save / Cmd+S writes Markdown to the same workspace path. Download exports the current draft. Opening without editing does not normalize or save the original. After editing, MDXEditor serializes conventional Markdown, so bullet styles, table spacing, and other syntax can normalize. Unsupported syntax can be edited in source mode; this is not a promise of arbitrary MDX or extension round-trip fidelity.

Unsaved drafts participate in existing tab/panel/window close protection. Save requests retain their loaded file version; concurrent disk changes fail without overwriting the draft or disk. Edits made while a save is in flight remain dirty.

The sidebar exposes the live Markdown document plus `inapp_md_read`, `inapp_md_replace_text`, and `inapp_md_save`. Replacements require an exact unique match, use session/path checks, update the visual editor, and save through the same conflict check.

## License

The app remains MIT. MDXEditor and its dependency notices are included in `apps/app/public/third-party/office-editors/DEPENDENCY_LICENSES.txt`; the generator now accepts legacy `licenses` declarations. No paid editor packages or new copyleft editor source were introduced. Existing Office dependencies retain their prior notices and source distribution requirements.

## Validation

- Actual Electron renderer: open a fixture containing front matter, headings, bold text, tasks, a quote, table, link, and fenced code.
- Type in WYSIWYG; verify dirty state; Cmd+S; verify saved Markdown on disk.
- Live sidebar replacement; source view; save/reopen with the saved text and formatting present.
- Deliberate disk conflict: disk sentinel remains unchanged, draft remains visible, and native unsaved-close dialog appears.
- App typecheck/build; Markdown draft and existing close-protection tests; server typecheck/build and sidebar routing tests.

[Electron screenshot](./markdown-editor-electron.png)

Commands: `pnpm --filter @legalwork/app typecheck`, `pnpm --filter @legalwork/app build`, `pnpm --filter legalwork-server typecheck`, and `pnpm --filter legalwork-server build` passed. `pnpm --filter @legalwork/app exec bun test tests/markdown-draft.test.ts tests/docx-document-state.test.ts` passed 10 tests; `pnpm --filter legalwork-server exec bun test src/opencode-plugins/legalwork-extensions-preview.test.ts` passed 16 tests. Build output retains the existing large-chunk warnings.
