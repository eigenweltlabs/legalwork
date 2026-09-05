# DOCX editor hardening follow-up

This follows the [initial lawyer-workflow review](docx-editor-review.md). It closes the reproduced negotiation-thread failure and adds draft recovery, a focused workspace, local versions, deliberate export, and live-draft agent proposals. It does not certify Microsoft Word parity.

## Changes

| Problem | Implemented behavior |
| --- | --- |
| Overlapping review comments disappear | The pinned core now permits multiple comment marks and imports every active comment anchor. The React adapter keeps comment IDs separate from revision IDs. |
| Rejecting a change loses its discussion | A reply to a tracked change becomes an ordinary comment anchored to the containing paragraph. Comment replies remain real comment threads. Accept/reject controls handle the revision independently. |
| Navigation or reload loses a draft | IndexedDB checkpoints after one second of inactivity, every five seconds during continuous editing, on backgrounding and during unmount. Reopening offers recover/discard. Restored drafts remain unsaved and retain the original conflict baseline. |
| Recovery reappears after deliberate discard | Explicit tab/pane discard clears recovery; cancelling leaves it intact. Successful workspace saves clear recovery only if no new edits arrived. |
| Review cards have insufficient room | Focus document uses the full window without remounting the editor or changing the user's zoom. Save and Return to chat remain available. |
| No previous save to return to | Last five successful saves on the device can be downloaded, compared as text, or restored as an unsaved draft. Restoration never immediately overwrites the workspace file. |
| Clean export could alter the working redline | Clean-copy export accepts changes and removes comments in a detached DOCX. It scans the resulting Word XML and refuses export if unsupported review markup remains. The working draft is unchanged. |
| Empty comment model leaves old comments in the ZIP | Clean export also clears retained comments XML parts; tests verify the result has no comments after reopening. |
| Print/PDF hard to find | The wrapper exposes the native print preview directly. |
| Agent reads stale disk text | Existing control actions `document.read_draft` and `document.propose_change` operate on the open editor. Proposals require its instance ID and revision, use native tracked changes attributed to LegalWork AI, and remain unsaved for lawyer review. |

Recovery and version history are local to this device/browser profile, keyed by workspace and file. They are not a DMS audit log or cross-device sync. Checkpoints are best effort: abrupt termination before the latest serialization/storage transaction completes can lose the newest edits. Storage errors remain visible; workspace saving still works.

## Dependency patch maintenance

All three Eigenpal packages are pinned to 1.8.3. `pnpm-workspace.yaml` applies the checked-in core and React patches on installation. Both ESM and CommonJS builds are patched; neither patch changes the serializer's general fidelity contract.

The published package contains minified distributions, so the patch files look much larger than the functional changes:

1. Core comment schema: `excludes: ""` allows overlapping comments.
2. Core paragraph conversion: apply every active comment ID, rather than the first ID only.
3. React comment/revision association: stop rewriting a comment's `parentId` to an unrelated revision ID.
4. React tracked-change Reply: create an anchored paragraph comment immediately. This keeps review text in standard Word comments and preserves it when the tracked span is rejected.

Before updating Eigenpal, remove or rebase these patches and rerun the regression corpus and browser sequence. A reply's paragraph anchor is deliberately broader than the changed word. Deleting an entire commented paragraph can still remove its anchored comments; version history/recovery are not a guarantee of permanent negotiation records.

## Validation completed

- `node --experimental-strip-types --test apps/app/tests/docx-document-state.test.ts apps/app/tests/docx-roundtrip.test.ts`: **10 passed**. Tests cover conflict baselines, explicit discard, overlapping marks in the actual editor projection, reply preservation across conversion/rejection/save, clean export isolation, and refusal of unsupported header markup.
- `pnpm typecheck`: **passed**.
- `pnpm build:ui`: **passed**, with existing chunk-size/browser-externalization warnings.
- Existing `pnpm test:e2e`, with OpenCode **1.17.18** installed: **passed**. All five result objects report `ok: true`: 11 path checks, core API/session steps, session switching, filesystem checks, and browser-entry checks. This is the repository's existing suite, not a claim that the native Electron window was automated.
- Fixed browser-QA build: **passed**.

Browser interactions used the production editor component and synthetic fixture:

1. Added a reply to the original Counterparty 30 → 60 redline.
2. Saved and reopened: original comment and new reply were both visible.
3. Rejected the replacement, saved and reopened: payment returned to 30 days and the reply remained visible.
4. Added a comment-only reply, observed “Draft kept on this device,” reloaded, recovered the draft, and verified the unsaved reply remained present. Saving cleared the dirty state.
5. Opened focus mode and inspected local version history and text comparison.

The native confirmation in the first clean-export implementation blocked this cloud browser's CDP session. The final export and version-restore flows use inline confirmation instead. The final download click and PDF/print flow still require a fresh browser session; the exported bytes themselves are covered by the regression tests. The agent control actions typecheck but have not been exercised through a live agent session.

## Interoperability gate

The new `.github/workflows/ci-docx.yml` runs the regression tests and a LibreOffice content/pagination comparison on DOCX changes. It retains the original and round-tripped DOCX, both PDFs, extracted text and a JSON report for review. A differing page count or extracted text fails the gate.

The gate is **prepared but not yet validated on an office renderer**. The local environment has no LibreOffice installation. Normal package installation failed on filesystem permissions; a complete, isolated package extraction still aborted on startup with `com::sun::star::uno::DeploymentException`. The script reports the missing renderer explicitly. The CI run must succeed before claiming even this fixture's external-renderer round trip passes.

```bash
# From the repository root, after installing LibreOffice Writer and Poppler:
pnpm --filter @legalwork/app exec node scripts/docx-interop.mjs
# Supply additional non-confidential fixtures and a separate output directory:
pnpm --filter @legalwork/app exec node scripts/docx-interop.mjs /absolute/contract.docx /absolute/results
```

This is a baseline for a corpus, not certification. Before release, add real non-confidential agreements covering multilevel numbering, cross-references, section breaks, landscape schedules, long tables, headers/footers, notes and 50+ pages. Review rendering and saved files in Microsoft Word as well. Text comparison in the UI is explicitly limited to text; formatting comparison and a Word-style comparison document are still separate work.

## Publication

GitHub writes still return HTTP 403 `Resource not accessible by integration`. No remote branch or PR has been created. The local changes and prepared PR description must be published once repository write access is available.
