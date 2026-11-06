# Native Back Office

The implementation starts from LegalWork dev f646f475. Its platform counterpart is `codex/back-office-native` in model-api, based on main b704f9c. Deploy the platform migration and API before enabling a firm's Back Office policy. The combined branches have local integration coverage against disposable Postgres and two temporary desktop SQLite stores.

## UI and licensing

The native renderer consumes MIT-licensed `twenty-ui` 2.54.0 at an exact version. Installation respects the repository's release-age policy. Its actual buttons, input controls, select menus, popovers, calendar picker, chips, avatars, tabs, lists and dialogs are used. Root CSS declares the Twenty layer after Tailwind's base layer. A scoped ThemeProvider keeps Twenty's typography and portal styling inside the module.

The published MIT library does not contain Twenty's application record table. That application source is AGPL and is excluded following the user's MIT-only decision. The local grid and application workflows use the installed components and the live Twenty preview as their visual reference. Create uses a record panel, simple text fields edit in place, and field creation uses settings pages. The view selector uses Twenty’s compact create/edit flow for Table, Kanban, Calendar and List. Cards, list rows, menus, pickers and dialogs reuse MIT library primitives. Saved view IDs stay in the URL so switching does not reload the page and reopening restores the layout. The MIT notice ships in desktop resources/licenses as well as the source notices.

## Data and APIs

The versioned shared definition is `packages/types/src/back-office.ts`. Its platform copy must stay aligned. SQLite stores model definitions, stable record IDs, per-record revisions, views, an audit trail and a team outbox in the existing runtime database. Required core IDs, types, cardinality and visibility are protected. Custom objects and fields can extend the model. Archive and restore preserve identity.

Default model version 3 removes provider-specific IDs from the first preview templates. Existing import identities move to record metadata, outside the editable data model. CSV imports use an optional source-ID column and generic `source:` relationship references. Upgrades preserve firm labels and extensions. Destructive conversions remain blocked. Shared definitions are updated online and arrive before dependent records. A model preview validates existing values and reports affected record counts before applying populated-object changes.

Projects and matters have a many-to-many relationship. `projectLinks` is internal storage. It is absent from user-facing object navigation, model settings and CSV import. Project Home and the matter panel provide the relationship controls. Client context combines direct matter clients with parties explicitly marked Client, excluding billing recipients. Project renames and project metadata sync do not write the junction.

The renderer and native agent tools consume the same validated Back Office routes. The current-project context tool resolves matters and clients using the calling project's identity. Record, model, view and relationship changes use revision checks and current permissions. Agent-originated writes are attributed in the audit trail.

## Team sync

`backOffice.sync` is an enforced opt-in organization policy. Model administration, directory editing and billing access are independent. Project permissions remain independent of matter access. The UI and agent automatically select the firm directory when the enforced setting is active, otherwise local storage. The UI has no storage selector or everyday publishing action. The existing publishing API is retained for a one-time migration of existing local records, with a reviewed preview preserving IDs and warning about same-name records. Projects must already be shared before their local IDs can be translated into shared project IDs.

Publishing preserves the existing team model and adds compatible local extensions. Shared labels and fields survive publishing from a desktop with an older local model. Conflicting field types, relation targets, cardinality or visibility block publication for review.

Offline writes retain stable operation IDs. The first rejection blocks dependent operations. Comparisons show team values and proposed fields; users can reapply those fields against a checked current revision or explicitly discard the queued record chain. Unspecified fields survive updates from older clients. Authorization rejection clears the managed replica and retains proposals for resolution. Transport failure retains the offline replica. Policy pokes trigger revalidation after policy refresh.

Publishing creates identities before optional relationships, with required relationships ordered by their dependencies. Cyclic required relationships need to be made optional before publishing; the operation is rejected without partial staging. The initial full-snapshot platform transport is limited to 10,000 stored records and needs pagination before that limit is increased.

The server's build bundles `back-office/schema.ts` into its runtime dist, keeping packaged Electron independent of workspace TypeScript sources. The renderer's components are bundled by Vite. Packaging checks use Node's 8 GB heap allowance for the existing large renderer build.

## Validation

Feature tests use `bun test apps/server/src/back-office/back-office.test.ts` in LegalWork and `vitest run src/lib/back-office/permissions.test.ts` in platform. Type checks, server and renderer builds, help generation and manual native UI comparisons supplement those tests.

For cross-repository integration, run the platform's `vitest.integration.config.ts` with `TEST_DATABASE_URL` pointing to a disposable Postgres and `LEGALWORK_TEST_CHECKOUT` pointing to this checkout. Select `src/lib/__integration__/back-office.test.ts`, `src/db/__integration__/row-security.test.ts` and `src/db/__integration__/migration-upgrade.test.ts`. The native fixture runs the real sync client against the platform HTTP route handlers, including reviewed publishing, project ID translation, multi-batch synchronization, conflicts, model ordering, persistence and access revocation. Clerk identity lookups are substituted. The ordinary integration command skips the cross-repository case unless the checkout variable is supplied. No live platform deployment is involved.

Saved views include layout type, icon, Kanban grouping, calendar date field and day/week/month mode. Existing views default to Table. Native and platform writes merge omitted view properties with the existing definition so older clients preserve newer layout settings. Deletion is a synced archive flag and retains records. These JSON additions do not require another SQL migration.

Record movement uses renderer pointer events rather than OS-native HTML dragging. It cancels on pointer release/cancel, Escape, window blur, visibility loss and unmount. Keyboard users can change stage/date through the field editors. Native drag automation was stopped after an OS input issue; the replacement pointer gesture has type/build coverage but still needs a human interaction check.
