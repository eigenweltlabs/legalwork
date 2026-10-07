# Privacy-first error reporting

The same strict diagnostic feeds local incident history, consented `$exception` analytics, and an explicitly shared support report. Capture the original exception before converting it to a generic display message. `toast.error(message, { error, operation })` keeps handled failures reportable; `recordError(error, context)` handles engine/global/server signals. A bare error toast still offers a local report, but does not invent automatic exception telemetry.

Technical diagnostics contain only enum values, numbers, random incident IDs, validated versions/build IDs and locations in manifest-owned renderer assets or fixed application-owned Electron modules. Provider messages (including OpenRouter's nested `metadata.raw`) are inspected locally for known signatures, then discarded. They can echo prompts or `flagged_input`, so never upload the raw error, response, stack, console log or support bundle. Unknown 400s stay `invalid_request`; a 400 alone is not evidence of a tool-schema failure. No session/account/device ID, custom provider name, private endpoint or arbitrary model name enters the report. Model names are reduced to public families.

Recent technical incidents are bounded to 50 and expire locally after 24 hours (purged while running or on the next launch); the native fatal-crash backlog is bounded to 30. Settings → Privacy → Recent errors can clear them. Fatal main/sidecar/renderer exits persist before relaying, and the next launch restores them without automatically uploading old incidents. Analytics-off users can preview, copy/save or explicitly send a report; sending never changes consent. Optional notes are user-entered support data and never enter analytics. The modal requires a matching receiver receipt before claiming success.

## Rollout

1. Deploy the companion [model-api error-report receiver](https://github.com/eigenweltlabs/model-api/pull/83) and migration `0037_error_reports.sql` before releasing this client. The fixed endpoint is `https://platform.eigenweltlabs.com/api/public/error-reports`; an older server returns a recoverable delivery failure, never false success.
2. Configure platform `POSTHOG_KEY`, `POSTHOG_ALPHA_KEY`, and `ERROR_REPORT_STAFF_USER_IDS`; deploy the independent five-minute scheduler job. Reports first commit to Postgres, with a 30-day expiry and a leased PostHog outbox. No support note is mirrored. Both receivers enforce the same strict v1 wire contract (`packages/types/src/error-report.ts`, mirrored in `model-api/packages/shared/src/error-report.ts`). Change protocol versions deliberately and keep old versions readable during future client rollouts.
3. Set the GitHub Actions secret `POSTHOG_SOURCEMAP_API_KEY` (personal key with error-tracking write access) and the variable `POSTHOG_ALPHA_PROJECT_ID`. Stable releases use LegalWork project 209745. The official PostHog Rollup plugin injects chunk IDs and uploads symbols when configured. Missing credentials keep symbols in the ignored `apps/app/.error-symbols/<git-sha>/<surface>/` directory; they are never shipped in `dist` or `dist-word-addin`. Build IDs and safe minified asset locations remain available without upload. Use the existing 6144 MB Node heap limit for full builds.

Find shared reports in PostHog Error Tracking with `report_origin = manual`; `report_id` links to the receipt and staff-only lookup endpoint. Automatic exceptions obey existing analytics consent and use no replay or autocaptured exception serializer. Their queue retries transient failures at most three times and preserves event UUIDs. Manual delivery is independent of that queue.

## Verification

- `pnpm --filter @legalwork/app test` and `pnpm --filter @legalwork/app test:i18n`.
- `pnpm --filter @legalwork/app typecheck`; `pnpm --filter legalwork-server build`; `pnpm --filter legalwork-server exec bun test src/error-diagnostics.test.ts`.
- `node --test apps/desktop/electron/sandbox-preloads.test.mjs`.
- `NODE_OPTIONS=--max-old-space-size=6144 LEGALWORK_ELECTRON_BUILD=1 pnpm --filter @legalwork/app build`; `pnpm --filter @legalwork/app build:word-addin`.
- For the actual dialog, run `PORT=5198 pnpm --filter @legalwork/app dev` and open `/tests/ui/error-report.html`. This fixture uses a local receiver stub and analytics off, with provider 400, upload timeout, render crash and unavailable-receiver controls. Delivery state exposes the exact submitted payload and request counts. No requests go to production. [Screenshot](assets/error-report-preview.png).

These changes improve evidence for future failures; they do not establish the cause of previously observed provider 400s. Raw production user content was not read or imported into these tests.
