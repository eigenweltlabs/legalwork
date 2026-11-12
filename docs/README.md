# LegalWork documentation

Start with the [user guide](user-guide/index.md) and [screen map](user-guide/screens.md) for product questions. They explain this app version's screens, controls and prerequisites. [The documentation audit](documentation-audit.md) identifies the source inspected and records coverage and validation limits.

Technical notes in this directory describe specific subsystems and design/verification work. They are not a user navigation guide. Files under `reviews/` and implementation plans are engineering material, not evidence that a feature has shipped.

## Bundled help

The canonical manual lives in `docs/user-guide/*.md`. The skill entrypoint and read-only label helper live in `apps/server/resources/core-opencode/skills/legalwork-help/`. `scripts/gen-core-skills.mjs` maps the manual into that skill's `references/` directory and embeds it in `apps/server/src/core-skills.ts` along with all other core resources. The full translation reference is generated into the ignored `apps/server/src/help-i18n.generated.ts` module, imported by the bundle and compiled into the app. An ignored `docs/user-guide/i18n.json` copy is also generated for local inspection. No additional documentation download or source checkout is needed at runtime.

At startup the server installs the core resources in its private shared library through `prepareManagedCoreLibrary`. It refreshes the library when the bundle hash changes and restores missing files. Shared workflows and their attachments are installed through `ensureBundledWorkflows`. Both the desktop app and the standalone server ship these resources.

## Updating and verifying

After changing a documented feature, update its topic, navigation and availability notes. After changing a locale table, regenerate the complete i18n snapshot:

```sh
pnpm docs:generate
pnpm docs:check
pnpm --filter legalwork-server exec bun test src/legalwork-help.test.ts src/workspace-init.test.ts src/opencode-plugins/legalwork-capabilities-knowledge.test.ts
```

The server build (including desktop development and standalone binaries) generates `core-skills.ts` before compilation. Git ignores the bundle and translation copies. Edit the original skill, guide or locale file and commit that source change. `pnpm docs:check` rebuilds missing or stale local copies and verifies the tracked `screens.json` inventory. Server tests and typechecking also prepare these files on a fresh checkout. The locale generator parses the actual exported tables and derives shipped languages from the runtime registry. Tests compare the generated data against the actual TypeScript module exports for every locale.

The screen generator reads JSX Route declarations and visible global/workspace settings declarations. Adding a route or setting without a guide mapping in `scripts/help-docs.mjs` fails generation. Update the topic and screen map, then assign the new surface to that guide. This guards navigation coverage, not the accuracy of every paragraph or every control inside a screen; inspect those when changing the feature. The inventory and manual describe the source build's routes and settings.

The help skill reads topic pages on demand and uses the bundled `lookup-label.mjs` to find labels. `references/` exists in the installed skill, mapped from the canonical manual; it is not duplicated into the skill's source directory. Use the generated workspace copy when exercising the helper.
