# PR 193 final review

Reviewed the workflow, native tools, report helpers, persisted-plan handling, review widgets, Word scroll geometry and project-file changes without visual review. The review found two release blockers and three report-delivery weaknesses, all corrected in this revision.

## Findings and corrections

- **Packaging:** the report-data helper lived in the OpenCode plugin directory. TypeScript emitted a separate JavaScript file with a bare `zod` import, so the desktop packaging guard failed on Linux and Windows. Move the helper and its tests into `src/reviews`; the actual plugin bundles the dependency. The guard remains enabled.
- **Incorrect class coverage:** the latest trial used custom review titles. Count bindings looked up display names, returned zero for all six classes and overwrote the model's otherwise correct class counts in the Word report. Resolve the installed set through the columns' native library provenance, reject unmatched classes, and deduplicate document counts across split reviews. A genuinely absent class still has zero documents.
- **Interrupted preparation:** packet parts shared mutable filenames across preparations. New parts are addressed by pinned review identity and content digest; unchanged parts may be reused, while changed evidence metadata cannot overwrite an earlier part. The descriptor is written last.
- **Output containment:** the Word builder now resolves the supporting directory and every supporting file against the project boundary, rejecting symlinks that would write outside it or overwrite an input.
- **Blank report:** the builder rejects an empty executive summary instead of turning the native preparation stub into a completed deliverable. A substantive draft may still have no material findings and retain all open questions.

The demo Word template also mislabeled the broad unresolved-document count as “Documents with incomplete execution”. Updated the local template packages and installed skill to “Documents with outstanding review questions”, preserving their formatting. The reviewable report instructions now distinguish this count from accepted signature observations and uncertain execution. The styled template remains a local demo asset rather than a repository binary.

## Saved-results replay

Replayed the six saved reviews from the 1 October 1,000-file trial against the existing running dev server. No new model inference or source classification was run. The original report was preserved; existing prose was used only to verify conversion in a separate report.

- 220 distinct legal records: 60 customer agreements, 45 DPAs, 35 MSAs, 35 employment agreements, 25 corporate agreements and 20 shareholder resolutions.
- All 1,760 cells retained, including 356 open decisions across 195 documents.
- Native preparation: approximately 0.194 seconds. Deterministic conversion: approximately 0.097 seconds, 11 findings, 13 verified quotations, no unfilled tokens.
- Measured class counts and the total scope survive conversion; draft edits cannot replace them.

The 195 documents include open questions about dates, consents, ownership and other issues as well as execution. They cannot truthfully be presented as 195 unsigned or defectively executed documents. Literal quote verification does not validate every narrative assertion or legal conclusion; the saved prose contains conclusions about notarisation, unanimity and enforceability that still require counsel's review. This technical replay does not certify that prose as legally correct.

## Validation

- `pnpm --filter legalwork-server test`: 1,288 passed, 15 skipped, zero failed.
- `pnpm --filter @legalwork/app test`: 734 passed, zero failed.
- `pnpm --filter @legalwork/app typecheck`: passed.
- `pnpm --filter legalwork-server build`: passed, including TypeScript checks and standalone plugin bundling.
- Python report-builder checks: 13 passed; source-evidence checks: seven passed, using the bundled Python runtime with bytecode disabled.
- Packaged-plugin import guard applied to the compiled plugin directory: passed.
- `git diff --check`: passed.

Regression checks cover custom titles, library provenance, split-class deduplication, unmapped classes, immutable parts, same-revision evidence changes, empty prose and both directory/file symlink escapes. Existing scale tests retain 5,000 rows and 40,000 cells in bounded report parts and expand 800-source citation groups without model-generated ID lists.

Full 5,000-agreement inference, the existing 64 MiB saved-review read limit and full-snapshot persistence remain unvalidated scale risks. Report pagination is an actual editor check required by the workflow; this replay does not establish a page count. No screenshots or visual review were performed.
