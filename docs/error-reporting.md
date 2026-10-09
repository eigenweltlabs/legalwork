# Privacy-first error events

The strict diagnostic feeds local incident history and automatic PostHog `$exception` events. A separate full snapshot is available only for explicit manual sharing. Capture the original exception before converting it to a generic display message. `toast.error(message, { error, operation })` keeps handled failures shareable; `recordError(error, context)` handles engine/global/server signals. A bare error toast offers local details without inventing an automatic exception.

Automatic technical diagnostics contain only enum values, numbers, random incident IDs, validated versions/build IDs and locations in manifest-owned renderer assets or fixed application-owned Electron modules. Provider messages (including OpenRouter's nested `metadata.raw`) are inspected locally for known signatures. Raw errors, responses, stacks, console logs and support bundles never enter automatic analytics. Unknown 400s stay `invalid_request`; a 400 alone is not evidence of a tool-schema failure. No session/account/device ID, custom provider name, private endpoint or arbitrary model name enters the automatic diagnostic. Model names are reduced to public families.

## Consent and delivery

- With analytics enabled, errors enter the existing consented queue with `error_origin = automatic`.
- With either analytics setting, the user can preview, copy/save, or explicitly send one selected full report. Clicking Send is consent for that one event. Opening the dialog collects local diagnostics and, where available, retrieves the original exception from the authenticated LegalWork server; it does not upload anything to PostHog.
- Manual reports include the original message, full available stack and cause chain, SDK/provider response bodies and headers, request IDs, selected provider/model/endpoint context, React component stack and desktop support diagnostics/logs. They can contain file/folder names and user content echoed in messages or logs. The English/German dialog explicitly warns about this and redacts recognized credentials. It does not proactively read documents or attach conversation history; diagnostic data can nevertheless contain their content. Redaction is defense in depth, not a guarantee that arbitrary secrets cannot appear; the exact preview is the user's review step.
- `sendManualErrorEvent` constructs a `$exception` with real manual exception messages/frames and the full snapshot in `error_details`, `error_origin = manual`, a random event UUID and a separate anonymous identity. It uses the same configured PostHog project, host and `/batch/` transport as ordinary events, in a single-event request. It never reads or changes general analytics consent and never flushes other queued events. Manual uploads use a 30-second timeout without browser keepalive, because full reports can exceed the 64 KiB background-request quota.
- The dialog previews the exact event, excluding the publishable project token used in the request envelope. No free-text note is collected. A successful HTTP response shows “Error sent”; this is not a durable-storage receipt or a guarantee that downstream ingestion has completed. Failed delivery offers an explicit retry with the same UUID and payload, plus copy/save. There is no background queue for manually shared events.

Recent technical incidents are bounded to 50 and expire locally after 24 hours (purged while running or on the next launch); the native fatal-crash backlog is bounded to 30. Settings → Privacy → Recent errors shows the latest incident for each fingerprint, so repeated requests cannot crowd out an earlier crash, and can clear them. Fatal main/sidecar/renderer exits persist before relaying, and the next launch restores them without automatically uploading old incidents. The embedded server relays unexpected exits from its managed OpenCode engine; intentional shutdowns do not create crash reports. Automatic delivery retries transient failures at most three times and preserves event UUIDs; opting out purges that queue. No replay or autocaptured exception serializer is enabled.

Original renderer and server exceptions are bounded memory-only snapshots; the existing native logs remain on disk under the existing log rotation. Full server details are kept before generic response formatting and retrieved through `GET /error-reports/:incidentId`, requiring valid credentials identical to the failed request. Another token receives 404, including an owner token if it did not originate the incident. Responses use `Cache-Control: no-store`. The cache is per server instance, expires after 24 hours on access, and holds at most 50 entries. Native memory retains at most 30 original exceptions alongside its sanitized disk backlog. Clear removes renderer/native full snapshots and renderer loaders; it does not erase the server's or native support log's existing retention. Old persisted summaries cannot recover a missing original exception; unavailable details are explicitly marked rather than inventing stacks.

Full means all available diagnostic fields, not unbounded process memory: serialization has a 2,000,000-character budget per snapshot, 10,000 nodes and depth 20, with explicit truncation/accessor/cycle markers. Existing support logs retain their 2 MB per-file tail limit and rotation. User-defined getters and executable custom inspectors are not invoked; standard DOMException fields use their native accessors. Native JSON export accepts up to 32 MB and preserves the exact preview. Reports are frozen for that dialog, so retries retain the same UUID and details even if new logs arrive. A rejected upload remains failed with copy/save available; it does not quietly fall back to a smaller report.

## Proposed quieter notifications

Keep failed-action errors next to the affected chat/action with an optional **Share details** link. Reserve one toast per incident category per session for crashes or blocked app usage, deduplicate repeats, and suppress cancelled operations, successful retries and background polling errors. Retain all eligible incidents under Settings → Privacy → Recent errors, with an optional **Don't remind me again** control. Never automatically open the sharing modal. This is a proposal; this change does not add new notification prompts or alter the current notification policy.

There is no additional report receiver, Postgres table, migration or scheduler. Manually shared errors appear in the same PostHog Error Tracking project, filterable by `error_origin = manual`; `error_id` identifies the original local incident. Server retention follows the PostHog project's configuration, with no separate 30-day support-database promise. Network requests necessarily reach PostHog infrastructure; cookies are omitted, person profiles are disabled and `$geoip_disable` is set for error events.

## Private symbols

Set the GitHub Actions secret `POSTHOG_SOURCEMAP_API_KEY` (personal key with error-tracking write access) and the variable `POSTHOG_ALPHA_PROJECT_ID`. Stable releases use LegalWork project 209745. The official PostHog Rollup plugin injects chunk IDs and uploads symbols when configured. Missing credentials keep symbols in the ignored `apps/app/.error-symbols/<git-sha>/<surface>/` directory; they are never shipped in `dist` or `dist-word-addin`. Build IDs and safe minified asset locations remain available without upload. Use the existing 6144 MB Node heap limit for full builds.

## Verification

- `pnpm --filter @legalwork/app test` and `pnpm --filter @legalwork/app test:i18n`.
- `pnpm --filter @legalwork/app typecheck`; `pnpm --filter legalwork-server build`; `pnpm --filter legalwork-server exec bun test src/error-diagnostics.test.ts`.
- `node --test apps/desktop/electron/sandbox-preloads.test.mjs`.
- `NODE_OPTIONS=--max-old-space-size=6144 LEGALWORK_ELECTRON_BUILD=1 pnpm --filter @legalwork/app build`; `NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @legalwork/app build:word-addin`.
- For the actual dialog, run `VITE_LEGALWORK_POSTHOG_KEY=phc_local_ui_fixture PORT=5198 pnpm --filter @legalwork/app dev` and open `/tests/ui/error-report.html`. This fixture intercepts PostHog requests locally, with analytics off and provider 400, upload timeout, render crash and unavailable-PostHog controls. Delivery state exposes the exact payload and manual/automatic request counts. No requests go to production. [Screenshot](assets/error-report-preview.png).

## Electron fixture smoke verification

The same fixture runs inside the actual Electron main process with its sandboxed preload. Start the fixture server above, then run this from the repository root in a second terminal:

```sh
errorQaRoot="$(mktemp -d /tmp/legalwork-error-electron.XXXXXX)"
node --input-type=module - "$errorQaRoot" <<'JS'
import { createNativeIncidentStore } from './apps/desktop/electron/error-incidents.mjs';
createNativeIncidentStore(process.argv[2]).record('sidecar_exit', new Error('PRIVATE_DOCUMENT_CANARY'), {
  version: '0.0.0', platform: process.platform, exitCode: 7,
});
JS
LEGALWORK_DEV_MODE=1 \
LEGALWORK_ELECTRON_USERDATA="$errorQaRoot" \
LEGALWORK_DATA_DIR="$errorQaRoot/data" \
LEGALWORK_SERVER_CONFIG="$errorQaRoot/server.json" \
LEGALWORK_ENV_STORE="$errorQaRoot/env" \
LEGALWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY=1 \
LEGALWORK_WORD_ADDIN=0 \
LEGALWORK_ELECTRON_APP_NAME='LegalWork - Error QA' \
LEGALWORK_ELECTRON_APP_IDENTIFIER=com.eigenweltlabs.legalwork.error-qa \
LEGALWORK_ELECTRON_START_URL=http://localhost:5198/tests/ui/error-report.html \
pnpm --filter @legalwork/desktop electron
```

Check desktop bridge loads the fixed asset manifest through guarded IPC and restores the seeded native incident without sending it. Provider 400 → Share error → Send should show success; Delivery state should show one manual request and zero automatic requests. Check copy and save through the native clipboard/file dialog. Toggle PostHog unavailable and verify failed delivery plus retry with the same UUID. Clear recent errors, then check the bridge again: the native backlog should be empty. Crash renderer triggers a caught React render failure; its Share error button must still open the dialog outside the failed boundary.

Verified in the running macOS Electron development app: all checks above passed, including the actual saved JSON (no content canaries), 546 manifest assets and native backlog restoration/clearing. This exercises the real shell/preload with a local PostHog stub; it does not test a signed installer, live PostHog ingestion, or an operating-system renderer-process crash. [Electron screenshot](assets/error-report-electron.png).

These changes improve evidence for future failures; they do not establish the cause of previously observed provider 400s. Raw production user content was not read or imported into these tests.

## Full application verification (2026-10-08)

Ran normal `pnpm dev` with a disposable profile and the complete app at `/`, including onboarding, project creation, actual chat, Settings, sandboxed preload, embedded server and pinned OpenCode engine. No fixture start URL or request interception was used. The QA build targeted PostHog **Dev & Alpha (220666)** with its publishable project key; the production project was untouched. Analytics was switched off in onboarding. The disposable profile's recording privacy option was set to Never solely to capture the screenshots.

- Added a custom OpenRouter Chat Completions provider in the real provider dialog, using an intentionally invalid key and `anthropic/claude-opus-4.6`. An actual chat request returned HTTP 401. Opened the resulting error report and copied the sanitized event through the native clipboard. Clicking Send produced exactly one manual `$exception` for that incident in live PostHog.
- The real native save panel exposed a bug missed by fixture testing: revoking the download URL after one second cancelled the pending save. Replaced the desktop download with guarded IPC and a native save dialog. Held that dialog open, then saved and parsed the actual JSON file successfully. Regression coverage checks exact bytes, cancellation, rejected input and restrictive permissions for a new file.
- Killed only the QA app's running OpenCode child with `SIGKILL`. This exposed a missing relay in the actual embedded-server path. After fixing it, the crash persisted as `engine_crash` with exit code 137. Opened and sent the report while the engine remained stopped; live PostHog contains UUID `34b88f00-7f09-4399-8776-960370389fd6` as one manual engine exception.
- Repeated failing requests initially hid the original engine crash from the five most recent entries. Recent errors now retains the latest visible entry for each distinct fingerprint within the existing bounded local registry.
- Examined only the synthetic test events in PostHog. Their properties excluded the prompt canary, fake API key, custom provider name, raw provider message and local path. General analytics remained off; there was no automatic event for the selected provider incident.

Checks passed: app typechecking; Electron typechecking; 17 diagnostic/reporting tests; the complete desktop suite (199 passed, two platform skips); seven managed-engine/server-diagnostic tests; and the server build. The managed-engine regression launches a real child process and checks unexpected exit versus intentional shutdown.

This verifies the full development application and live alpha ingestion. It does not verify a signed installer, a successful model completion with valid credentials, an OS-level renderer crash, or the cause of historical provider 400s. The deliberately invalid key produced a 401. [Full application screenshot](assets/error-report-full-app.png).

### Copy, sizing and custom-provider context

Removed the analytics-setting sentence from the English and German dialog copy. Toasts now stay expanded instead of shrinking older cards, and actionable cards reserve two lines for their title, giving the pictured authentication and engine errors consistent dimensions without clipping longer messages. [Updated dialog in the full app](assets/error-report-short-copy.png).

The actual custom provider returned an empty `model.api.url` while its effective endpoint was in `provider.options.baseURL`. Run diagnostics now read that override and the selected SDK format before reducing them to safe enum values. A fresh real OpenRouter 401 was exported through the full app: its event identified `openrouter`, `chat_completions`, and `claude_opus`; prompt/key/name/URL/path canaries remained absent. Old local reports retain their original diagnostics. This identifies the failed route for triage; it does not prove why a credential was rejected.

After these changes, app typechecking and i18n checks passed, and `pnpm --filter @legalwork/app exec bun test tests/error-reports.test.ts tests/error-diagnostics.test.ts tests/sonner-toast-dismiss.test.ts` passed all 20 tests. The new regression checks both custom Chat and Responses routes with an empty model URL and private configuration canaries.

## Full manual diagnostics verification (2026-10-09)

Ran the normal full `pnpm dev` app again using the existing disposable QA profile, embedded server, real pinned OpenCode engine and custom OpenRouter provider. Analytics remained off. A synthetic chat request with the intentionally invalid QA key produced an actual 401. Settings → Privacy → Recent errors opened the full report with the path/user-content warning and exact event preview. Clicking Send showed success and live Dev & Alpha ingestion confirmed UUID `cb58fb8f-b4c2-405a-bb11-566182d337af`, `error_origin = manual`, the original `APIError` body (`User not found.`), exact Claude Opus model ID and 58,068 characters of desktop support diagnostics. The fake QA key was absent. This provider wire error did not supply a stack; none was invented. [Full report UI](assets/error-report-full-details.png).

The native Save panel opened but stayed disabled with empty directory views in this run, so a successful full-report UI export is **not** claimed. Automated native export tests verify exact bytes for reports larger than the former 128 KB limit, cancellation, validation and file permissions. Earlier native export verification above predates this full-report change.

Validation: full app suite 917 passed, then the final diagnostic/reporting suites 24 passed (including the added API-client lazy retrieval case); server diagnostic/detail suites 5 passed against a running authenticated HTTP server; desktop suite 200 passed, two platform skips. App/Electron typechecks, i18n (5,609 keys), server build and desktop renderer production build passed. No production data or credentials were used in QA. Analytics-on full sharing and frozen retries are covered by the consent tests; live alpha verification used analytics off.
