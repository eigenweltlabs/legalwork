# Privacy-first error events

The same strict diagnostic feeds local incident history and normal PostHog `$exception` events. Capture the original exception before converting it to a generic display message. `toast.error(message, { error, operation })` keeps handled failures shareable; `recordError(error, context)` handles engine/global/server signals. A bare error toast offers local details without inventing an automatic exception.

Technical diagnostics contain only enum values, numbers, random incident IDs, validated versions/build IDs and locations in manifest-owned renderer assets or fixed application-owned Electron modules. Provider messages (including OpenRouter's nested `metadata.raw`) are inspected locally for known signatures, then discarded. They can echo prompts or `flagged_input`, so never upload the raw error, response, stack, console log or support bundle. Unknown 400s stay `invalid_request`; a 400 alone is not evidence of a tool-schema failure. No session/account/device ID, custom provider name, private endpoint or arbitrary model name enters the diagnostic. Model names are reduced to public families.

## Consent and delivery

- With analytics enabled, errors enter the existing consented queue with `error_origin = automatic`.
- With analytics disabled or onboarding consent still pending, errors stay local. The user can preview, copy/save, or explicitly send one selected error. Clicking Send is consent for that one event.
- `sendManualErrorEvent` constructs a sanitized `$exception` with `error_origin = manual`, a random event UUID and a separate anonymous identity. It uses the same configured PostHog project, host and `/batch/` transport as ordinary events, in a single-event request. It never reads or changes general analytics consent and never flushes other queued events.
- The dialog previews the exact event, excluding the publishable project token used in the request envelope. No free-text note is collected. A successful HTTP response shows “Error sent”; this is not a durable-storage receipt or a guarantee that downstream ingestion has completed. Failed delivery offers an explicit retry with the same UUID and payload, plus copy/save. There is no background queue for manually shared events.

Recent technical incidents are bounded to 50 and expire locally after 24 hours (purged while running or on the next launch); the native fatal-crash backlog is bounded to 30. Settings → Privacy → Recent errors can clear them. Fatal main/sidecar/renderer exits persist before relaying, and the next launch restores them without automatically uploading old incidents. Automatic delivery retries transient failures at most three times and preserves event UUIDs; opting out purges that queue. No replay or autocaptured exception serializer is enabled.

There is no additional report receiver, Postgres table, migration or scheduler. Manually shared errors appear in the same PostHog Error Tracking project, filterable by `error_origin = manual`; `error_id` identifies the original local incident. Server retention follows the PostHog project's configuration, with no separate 30-day support-database promise. Network requests necessarily reach PostHog infrastructure; cookies are omitted, person profiles are disabled and `$geoip_disable` is set for error events.

## Private symbols

Set the GitHub Actions secret `POSTHOG_SOURCEMAP_API_KEY` (personal key with error-tracking write access) and the variable `POSTHOG_ALPHA_PROJECT_ID`. Stable releases use LegalWork project 209745. The official PostHog Rollup plugin injects chunk IDs and uploads symbols when configured. Missing credentials keep symbols in the ignored `apps/app/.error-symbols/<git-sha>/<surface>/` directory; they are never shipped in `dist` or `dist-word-addin`. Build IDs and safe minified asset locations remain available without upload. Use the existing 6144 MB Node heap limit for full builds.

## Verification

- `pnpm --filter @legalwork/app test` and `pnpm --filter @legalwork/app test:i18n`.
- `pnpm --filter @legalwork/app typecheck`; `pnpm --filter legalwork-server build`; `pnpm --filter legalwork-server exec bun test src/error-diagnostics.test.ts`.
- `node --test apps/desktop/electron/sandbox-preloads.test.mjs`.
- `NODE_OPTIONS=--max-old-space-size=6144 LEGALWORK_ELECTRON_BUILD=1 pnpm --filter @legalwork/app build`; `NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @legalwork/app build:word-addin`.
- For the actual dialog, run `VITE_LEGALWORK_POSTHOG_KEY=phc_local_ui_fixture PORT=5198 pnpm --filter @legalwork/app dev` and open `/tests/ui/error-report.html`. This fixture intercepts PostHog requests locally, with analytics off and provider 400, upload timeout, render crash and unavailable-PostHog controls. Delivery state exposes the exact payload and manual/automatic request counts. No requests go to production. [Screenshot](assets/error-report-preview.png).

These changes improve evidence for future failures; they do not establish the cause of previously observed provider 400s. Raw production user content was not read or imported into these tests.
