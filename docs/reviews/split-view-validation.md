# Split-view branch: complete validation rerun

2026-10-08 — `feat/split-view-autosave`, compared with `dev` at `2928745b`.
Reviewed all 43 existing PR commits and the final task-navigation, composer and
file-picker follow-up. This report supersedes earlier test counts; historical
interaction evidence remains in the linked review reports.

The [second adversarial follow-up](adversarial-followup-r2.md) subsequently fixed
file-menu ownership, dirty task-attachment navigation and folder-link renames.
App/server/desktop suites, app end-to-end checks, typechecks, builds and language
checks were rerun; their latest results are reflected below. The other checks
retain the results of the preceding full branch validation.

## Results

| Command / check | Result |
| --- | --- |
| `pnpm --filter @legalwork/app test` | **1,107 passed**, 0 failed, after the second adversarial follow-up |
| `OPENCODE_TEST_BINARY="$PWD/apps/desktop/resources/sidecars/opencode" pnpm --filter legalwork-server test` | **1,590 passed, 16 skipped**, 0 failed |
| `pnpm --filter @legalwork/desktop test` | **213 passed, 2 skipped**, 0 failed |
| From `apps/app`: `pnpm exec bun test scripts/*.test.ts` | **92 passed**, 0 failed |
| `pnpm --filter opencode-router test:unit` | **24 passed**, 0 failed; includes cross-platform path regressions |
| `pnpm --filter opencode-router test:cli` | Passed |
| `pnpm --filter legalwork-orchestrator test:router` and `test:files` | Both passed with temporary projects and daemons |
| App `test:e2e`, with `apps/desktop/resources/sidecars` added to PATH | Passed: i18n, local paths, engine/session lifecycle, session switching, filesystem and browser-entry checks |
| Desktop `test:preview-security` | Passed: interactive previews remain isolated, PDF viewer allowed |
| Desktop `test:browser-workflow` | Passed: browser batches, error handling, project-scoped downloads and collision protection |
| Desktop `test:browser-panel` | Passed: independent real native views and window ownership |
| Desktop `test:native` | Passed: speech addon, SQLite and PTY under Electron 43.7.5 |
| `pnpm exec node --test scripts/release/*.test.mjs` | **3 passed** |
| `apps/server/scripts/test-report-evidence.py` and `test-report-from-reviews.py` with bundled Python | **7 + 14 passed** |
| `pnpm --filter legalwork-server test:deadline-oracles` | **10 cases matched** both public reference calculators |
| `pnpm --filter @legalwork/app typecheck` | Passed after final changes |
| `pnpm --filter @legalwork/desktop typecheck:electron` | Passed |
| `pnpm --filter @legalwork/desktop check:electron` | Passed, 110 renderer bridge methods |
| `pnpm --filter @legalwork/app build` | Passed after final changes; existing bundle-size warnings |
| `pnpm --filter legalwork-server build` | Passed, including typecheck and packaged runtime schema bundles |
| App `test:i18n` and `pnpm exec node scripts/i18n-audit.mjs --ci` | Passed; **5,756 keys** in English and German |
| `pnpm --filter legalwork-ui-mcp test` and `pnpm --filter @legalwork/handsfree check:js` | Passed |
| `git diff --check` | Passed |

Tests requiring localhost sockets ran outside the restrictive tool sandbox.
The initial sandboxed app run could not bind its test servers; the successful
full reruns above include those tests. End-to-end tests initially lacked
`opencode` on PATH and then passed with the installed bundled executable.
The OAuth test initially timed out using the platform-suffixed sidecar. All four
OAuth cases and the subsequent complete server rerun used the working generic
sidecar explicitly. Unrelated generated calendar output from the build was
restored; user configuration and installed skills were not modified.

## Failures found and corrected during the rerun

All executed suites now pass. The initial rerun exposed three existing issues:

1. Three skill-composition cases and one calendar skill case read personal
   home-directory skills even though their XDG configuration was temporary.
   Each test's separate child process now mocks `os.homedir()` to its temporary
   root before loading production modules. The empty-stderr assertions remain
   strict; user skills and production skill discovery are unchanged. All four
   targeted cases and the complete server suite pass.
2. The ancillary extension-items test still expected removed cloud-plugin
   grouping. It now checks the current installed-skill contract, including
   discovery of nested skill files, resource paths and installed/active state.
   The extension builder is unchanged; all 92 script tests pass.
3. Router path checks used the host's path resolver while accepting a simulated
   Windows platform. They now use the requested platform's path operations,
   preserve both leading UNC separators, and distinguish parent traversal from
   valid names beginning with two dots. Regressions cover Windows drive and UNC
   aliases, case handling, sibling prefixes, traversal, other drives/shares and
   POSIX boundaries. All 24 router tests and the CLI smoke test pass.

The server's 16 existing conditional skips require real storage services, native
OCR/layout assets, or optional engine/database integration. The desktop suite
retains two conditional skips. No test was newly skipped to obtain these results.

The final fetch confirmed `origin/dev` is still `2928745b` and is already an
ancestor of this branch: no new merge or conflict resolution was necessary.

## UI evidence and limits

The final browser fixture checks used synthetic files without connected services:

- At 277 CSS pixels of composer toolbar width, Reasoning effort and Run task
  share the second row; at 639 pixels all controls share one row.
- The tab's Files action opens an app dialog containing Project Files and
  Memory Drive. A local file opens in the requesting pane without an automatic
  split. Bulk selection opens both chosen files in that same pane. A connected
  file chosen from the other pane opens there with its storage source retained.
- Task navigation regressions exercise the production tab store for stale
  project links, server ownership, remote route IDs, legacy focus and reopening.
  This specific task-navigation flow was not driven end-to-end in the user's
  running Electron app.

Screenshots and reproduction details: [Files and window UX](files-window-ux.md),
[workspace refinement](workspace-refinement.md),
[adversarial follow-up](adversarial-followup.md), and
[original document autosave/handoff verification](side-by-side-documents.md).

The local LibreOffice/Poppler DOCX interop gate was not rerun because the required
LibreOffice and `pdftotext` executables are absent. Windows/Linux packaging and
their launch checks are delegated to the PR's CI matrix. Live model/voice,
external account/storage publishing, signed OS computer-use permissions and
real exFAT/network-share behavior were not exercised in this pass.

Before this update, all eight GitHub checks on `6f716a1c` were successful (DCO,
DOCX, i18n, Linux/macOS tests and three packaging platforms). Those results
belong to that previous commit; a fresh push triggers new checks for this update.
