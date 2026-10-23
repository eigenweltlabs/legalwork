# Assistant project duplication repair

Cloud catalog imports wrote a project's sync ID into its folder without
restoring its `project_links` row. The following catalog publish treated that
workspace as a new local project, generated another remote ID and overwrote
the original marker. Team sync then brought the original project back as a
second workspace. Repetition filled the project list and the guest disk.

## Change

- Restore imported project links through the authenticated existing-project
  API, preserving the ID, owner, member role and sharing scope. Import never
  sends a create or sharing update request.
- Recover interrupted imports whose binding committed before their workspace
  registration. Reuse an existing local copy of a catalog project. Preserve ownership of
  folders already registered locally; newly downloaded folders remain remote
  copies for normal sign-out cleanup.
- Defer legacy catalog entries without an original sync ID. A missing or
  inaccessible remote project fails closed instead of creating a replacement.

## Staging recovery

Both the current desktop and its cloud worker had 67 registrations by the
time syncing stopped. Each now retains the two real Assistant workspaces:
the desktop conversation workspace and the cloud conversation workspace.
The other 65 folders were archived, with configuration and SQLite backups.
Generated dependency copies in 24 duplicate guest folders were removed to
recover disk space. No original chat database was deleted or rewritten.

All 68 discarded remote projects were checked to contain no documents before
removal. The private catalog now contains two entries with their original
remote project IDs. The prior checkpoint and catalog were backed up; a new
clean checkpoint has been published. The desktop's original four sessions,
seven messages and 24 parts all remain present, as do the guest's two sessions.

The current worker received the corrected CLI in place. The staging controller
selects `legalwork-cloud-browser-v7` for newly created workers. Existing paused
workers for other staging accounts were not changed by this account's repair.
Runtime SHA-256:
`239c16443ada29599bae7dcdb5987165db4bdc873d45dc3b1d52006944803d2c`.

## Verification

- `pnpm --filter legalwork-server typecheck`: passed.
- `pnpm --filter legalwork-server exec bun test src/cloud-sync/cloud-sync.test.ts src/project-sync.test.ts src/eigenwelt-projects.test.ts`:
  70 passed, zero failed.
- The import regression tests fail against the previous implementation.
- `pnpm --filter legalwork-server test`: 1,695 passed, 17 skipped, six failed.
  An unchanged-HEAD comparison reproduces the same six failures: packaged
  imports, three skill-composition assertions affected by an invalid installed
  user skill, calendar skill execution and a scheduling time-zone assertion.
- The live guest restored an intentionally missing desktop-project binding
  with its original remote ID. Desktop and guest registrations, the catalog
  and the remote project list remain at two through subsequent sync rounds.
- Desktop status reports enabled, no sync error and zero pending projects.
  The controller's normal wake/readiness request returned HTTP 200.

Electron was restarted against staging. Operator backups and account-specific
repair scripts are private and are not part of this repository.
