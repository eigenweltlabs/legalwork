# Apple Push for the Assistant

The server sends alert notifications through APNs. It remains running when iOS suspends or terminates the client. No background polling entitlement or silent push is needed.

## Provisioning

1. Enable Push Notifications for the iOS bundle ID in Apple Developer. The iOS target includes `aps-environment`; automatic signing refreshes the provisioning profile.
2. Create a **topic-specific APNs signing key**, restricted to the LegalWork bundle ID and the intended environment. Use a sandbox key for development and a separate production key for TestFlight/App Store builds.
3. Store the `.p8` outside source control with permissions `0600`. Place `apns.json` beside the server's `runtime.sqlite`, or set `LEGALWORK_APNS_CONFIG` to an absolute configuration path:

```json
{
  "teamId": "APPLE_TEAM_ID",
  "keyId": "APPLE_KEY_ID",
  "privateKeyPath": "/private/path/AuthKey.p8",
  "bundleId": "com.eigenweltlabs.legalwork.ios",
  "environment": "sandbox"
}
```

4. Restart the server. Authenticated `GET /assistant/push` reports configuration health without exposing credentials.
5. Open the signed iOS app, sign in, and enable Notifications. Its APNs token is registered on each launch, never treated as a permanent cached device identifier. Notification settings show registration state and provider errors.

Debug builds use `development` entitlement and sandbox registration; Release builds use production. The server deliberately rejects a mismatched environment. To serve both distributions concurrently, use separate server deployments/configuration. Do not copy the private key into the iOS bundle, Git, an issue, or a log.

## API and delivery

- `PUT /assistant/push/devices/:installationUUID` registers or refreshes an APNs token, category preferences, preview/sound choices, and the visible tab.
- `DELETE /assistant/push/devices/:installationUUID` revokes that registration.
- `POST /assistant/push/devices/:installationUUID/test` queues a server-side test, normally 45 seconds later, with a one-minute rate limit.
- Routes require existing server authentication. Registration ownership is derived from the authenticated token hash; never from a user ID supplied in the body. Revoked server credentials invalidate registrations.
- This currently follows the server's workspace-wide access model. A hosted multi-tenant release must validate Clerk credentials on the server and scope the event source/registration owner to the authenticated workspace. The Clerk UI gate alone is not server authorization.
- Only completed, terminal, idle Assistant replies and still-pending approval/question cards presented by the Assistant generate alerts. Project-chat transcripts are not pushed separately. Notification taps open the Assistant or Approvals.
- Foreground tab presence expires after 45 seconds without a heartbeat. Backgrounding updates it immediately. The iOS delegate also suppresses a stale foreground banner for the tab currently being read.
- SQLite stores device registrations and delivery receipts. Registration starts from the current time, so enabling notifications does not replay old history. Transient errors retry with bounded backoff for at most an hour. APNs invalid-token responses remove the registration. Inactive registrations expire after 30 days.
- Duplicate protection survives restarts. As with any external delivery, a crash after Apple accepts a request but before its receipt is persisted can retry it. A stable APNs collapse ID minimizes duplicate queued alerts.
- Sign-out waits for deregistration. Account/session invalidation also removes delivered notifications and unregisters with iOS. Turning off a category suppresses its pending delivery. Deadline reminders remain local calendar notifications.

## Verification

Run `pnpm --filter legalwork-server exec bun test src/push/push.test.ts` and the iOS notification unit/UI tests. Use Send test notification, leave the app, and wait at least 45 seconds. Check the provider receipt, then tap the alert to confirm navigation. A simulator injection (`simctl push`) checks rendering and taps only; it does not prove APNs transport. APNs acceptance does not prove that Focus settings or iOS displayed an alert, so confirm visible delivery on a physical device before release.
