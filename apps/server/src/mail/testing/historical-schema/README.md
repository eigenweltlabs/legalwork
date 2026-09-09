# Historical encrypted-store fixtures

These SQL files capture the statements actually emitted by historical migrators. They do **not** install the current schema and remove tables or rewrite its version.

| Fixture | Historical source commit | Git source blob |
| --- | --- | --- |
| `v0-to-v5.sql` | `b4f3d33ba07f4a5507e1c6482a3d39a05b39faac` | schema.ts `6759e7ddc97dd48a2125a55a46add73337d17196` |
| `v5-to-v9.sql` | `82ad798dcdc0994f84f897239541528352dd35a5` | schema.ts `f5b947fbbb258ea47e6fdf9b8cac89ecbffabeac`; graph-state.ts `408ba4be4fae4a63b3e24112d87bf3ca6d51b15d` |

To reproduce from repository root with existing dependencies and these local Git objects:

```sh
node apps/server/src/mail/testing/historical-schema/regenerate.cjs
```

The extractor transpiles the historical TypeScript using installed TypeScript, captures emitted SQL with version 0 or 5 respectively, and substitutes the historical Graph SQL constant. The resulting SQL is checked in, so acceptance requires neither Git history nor regeneration. A v9 fixture applies v5 followed by the frozen v5→v9 migration.

The acceptance test creates fresh encrypted databases from these historical definitions, writes raw MIME and attachment bytes through the content store, and persists legacy draft references plus queued/uncertain v5 action records. Direct old action inserts are necessary because the current action repository correctly requires the current schema. Fixtures contain synthetic data only.
