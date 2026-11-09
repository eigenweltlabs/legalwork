# Update access during startup

On a new branch from `dev`, show the existing desktop **Check for updates** action throughout the startup/loading and migration screen, as well as on errors. Reuse the existing queued update-check request and Updates dialog, keeping its native updater and restart safeguards. Keep the dialog open if startup finishes while it is being used. Preserve the existing error log-export action.

Update the troubleshooting guide and generated help. At the end verify startup, migration and error visibility, opening/closing the Updates dialog while the engine is unavailable, and keeping that dialog usable when startup finishes. Run the relevant existing startup/updater checks, app types and documentation checks; no backend or release changes are needed.

Implemented by moving the existing desktop updater action/dialog out of the error-only block and retaining the mounted dialog until it is closed. Browser preview of the actual components, using a mock native updater bridge and an unavailable engine, verified loading/migration/error visibility; check → available → download → ready-to-install; keeping the dialog open after startup becomes ready; removing the overlay on close; and hiding the native update button in web mode. No installer was downloaded or run. Screenshots and the temporary fixture are saved under `output/legalwork-startup-update-button-20261109` outside this worktree.

Verification: 18 existing tests across `engine-startup`, `migration-progress`, `update-preferences` and `word-addin-startup` pass with the prepared Bun 1.4.4. App typecheck and generated-help checks pass. No new unit/integration test suite was added for this UI change.
