# Cloud Assistant rebase — 2026-10-23

`codex/legalwork-cloud-sync` is rebased onto `codex/johannes-assistant` at
`3006f40f`, including `dev` at `4cd05894`.

The four original Assistant commits and five settings/icon changes are already
represented by the current local Assistant branch. Cloud-specific commits were
replayed without duplicating those older implementations. The original cloud
head is retained in `backup/legalwork-cloud-sync-before-johannes-rebase-20261023`.

Conflict resolutions retain current Assistant settings/autosave, project access,
durable delegation authority, isolated scheduled workers and complete worker
results. Cloud activation, execution fencing, channel history/live events,
BrowserUse tooling, private replication and connector sync remain on this branch.
The current Assistant header and normal Settings both expose cloud setup.

The HTTP integration test now checks cloud route authentication, disabled status
and refusal to activate without an Eigenwelt account. The scheduling test mocks
the computer's reported time zone, avoiding Bun/Intl cache interference from
other sync tests. Duplicate translation keys from the shared settings work were
removed while preserving the newer descriptions.

## Validation

- `pnpm install --frozen-lockfile --ignore-scripts --offline`: passed.
- `pnpm --dir apps/app typecheck`: passed.
- `pnpm --dir apps/server typecheck`: passed.
- `pnpm --dir apps/app build`: passed.
- `pnpm --dir apps/server build`: passed.
- `pnpm --dir apps/app test:i18n`: 7,183 keys in English and German, passed.
- `git diff --check`: passed.

From `apps/app`:

```sh
pnpm exec bun test tests/assistant*.test.ts tests/assistant*.test.tsx \
  tests/main-assistant-client.test.ts tests/scheduled-task-card.test.tsx \
  tests/scheduled-run-card.test.tsx
```

66 passed, 0 failed across 17 files.

From `apps/server`:

```sh
pnpm exec bun test src/assistant*.test.ts src/main-assistant*.test.ts \
  src/channel*.test.ts src/cloud-assistant-setup.test.ts src/cloud-plugins.test.ts \
  src/cloud-sync/cloud-sync.test.ts src/connectors/sync.test.ts \
  src/project-sync.test.ts src/project-file-sync.test.ts src/project-review-sync.test.ts \
  src/sync-batches.test.ts src/legalwork-runtime-config.test.ts \
  src/eigenwelt-intake.test.ts src/eigenwelt-projects.test.ts src/eigenwelt-refresh.test.ts \
  src/opencode-plugins/legalwork-assistant-tools.test.ts \
  src/opencode-plugins/legalwork-extensions-preview.test.ts \
  src/opencode-plugins/legalwork-scheduled-task-tools.test.ts \
  src/scheduled-tasks/access.test.ts src/scheduled-tasks/routes.test.ts \
  src/scheduled-tasks/scheduled-tasks.test.ts src/wiki/agent-access.test.ts
```

379 passed, 0 failed across 42 files. These checks use fixtures; no live cloud
deployment or mobile walkthrough was performed for this rebase.

Existing local build-file deletions and the generated calculator modification
were saved before rebasing and restored afterwards, outside the committed changes.
