# Native Back Office

The implementation starts from LegalWork dev f646f475. Its platform counterpart is `codex/back-office-native` in model-api, based on main b704f9c. Deploy the platform migration and API before enabling a firm's Back Office policy. Broad integration testing belongs to the combined branch pass.

## UI and licensing

The native renderer consumes MIT-licensed `twenty-ui` 2.54.0 at an exact version. Installation respects the repository's release-age policy. Its actual buttons, input controls, select menus, popovers, calendar picker, chips, avatars, tabs, lists and dialogs are used. Root CSS declares the Twenty layer after Tailwind's base layer. A scoped ThemeProvider keeps Twenty's typography and portal styling inside the module.

The published MIT library does not contain Twenty's application record table. That application source is AGPL and is excluded following the user's MIT-only decision. The local grid and application workflows use the installed components and the live Twenty preview as their visual reference. Create uses a record panel, simple text fields edit in place, and field creation uses settings pages. The MIT notice ships in desktop resources/licenses as well as the source notices.

## Data and APIs

The versioned shared definition is `packages/types/src/back-office.ts`. Its platform copy must stay aligned. SQLite stores model definitions, stable record IDs, per-record revisions, views, an audit trail and a team outbox in the existing runtime database. Required core IDs, types, cardinality and visibility are protected. Custom objects and fields can extend the model. Archive and restore preserve identity.

Default model version 2 adds the client Actaport source ID to the first preview template. Upgrades merge additive definitions by stable ID and preserve labels and extensions. Destructive conversions remain blocked. Shared definitions are updated online and arrive before dependent records. A model preview validates existing values and reports affected record counts before applying populated-object changes.

Projects and matters have a many-to-many relationship. `projectLinks` is internal storage. It is absent from user-facing object navigation, model settings and CSV import. Project Home and the matter panel provide the relationship controls. Client context combines direct matter clients with parties explicitly marked Client, excluding billing recipients. Project renames and project metadata sync do not write the junction.

The renderer and native agent tools consume the same validated Back Office routes. The current-project context tool resolves matters and clients using the calling project's identity. Record, model, view and relationship changes use revision checks and current permissions. Agent-originated writes are attributed in the audit trail.

## Team sync

`backOffice.sync` is an enforced opt-in organization policy. Model administration, directory editing and billing access are independent. Project permissions remain independent of matter access. A reviewed publishing preview preserves IDs and warns about same-name records. Projects must already be shared before their local IDs can be translated into shared project IDs.

Offline writes retain stable operation IDs. The first rejection blocks dependent operations. Comparisons show team values and proposed fields; users can reapply those fields against a checked current revision or explicitly discard the queued record chain. Unspecified fields survive updates from older clients. Authorization rejection clears the managed replica and retains proposals for resolution. Transport failure retains the offline replica. Policy pokes trigger revalidation after policy refresh.

Publishing creates identities before optional relationships, with required relationships ordered by their dependencies. Cyclic required relationships need to be made optional before publishing; the operation is rejected without partial staging. The initial full-snapshot platform transport is limited to 10,000 stored records and needs pagination before that limit is increased.

The server's build bundles `back-office/schema.ts` into its runtime dist, keeping packaged Electron independent of workspace TypeScript sources. The renderer's components are bundled by Vite. Packaging checks use Node's 8 GB heap allowance for the existing large renderer build.

## Validation

Only new feature tests are run: `bun test apps/server/src/back-office/back-office.test.ts` in LegalWork and `vitest run src/lib/back-office/permissions.test.ts` in platform. Type checks, server and renderer builds, help generation and manual native UI comparisons supplement those tests. No broad repository test suite or platform integration suite is part of this change.
