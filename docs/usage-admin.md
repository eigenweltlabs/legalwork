# Usage requests and administration

LegalWork exposes model-api's member budgets in Settings → Eigenwelt account and directly above the task composer after an Eigenwelt budget error. Members request a temporary monthly increase, a recurring limit, or Pro. Organization admins see requests, assign purchased seats and spending limits, and initiate Stripe credit purchases from the same panel.

The app calls `GET/POST /workspace/:id/eigenwelt/usage`. These server routes require owner scope because the Eigenwelt account credential belongs to the device owner. The server refreshes that credential and calls the fixed platform `/api/usage-control` endpoint; the renderer never receives it. The platform verifies current membership, organization ownership and admin role on each action. Seat changes refresh cached desktop entitlements. The screen polls while visible so decisions and paid top-ups become visible without signing in again.

The UI uses existing Card/Button/Input primitives and Base UI dialogs, with the application's English/German dictionaries. Payments open in the system browser for Stripe confirmation. The new panel does not replace the existing sign-in, trial, member-invitation or organization-selection flows.

Deploy the matching model-api implementation and follow its `docs/member-budgets.md` rollout before enabling an organization. Unactivated organizations see an activation notice. The versioned wire types in `packages/types/src/usage-control.ts` mirror model-api's `packages/shared/src/usage-control.ts`; update both when changing the contract.

Verification from this repository root:

```sh
pnpm --filter @legalwork/app typecheck
pnpm --filter legalwork-server typecheck
pnpm --filter @legalwork/app test:i18n
pnpm --filter @legalwork/app exec bun test tests/usage-control-client.test.ts tests/eigenwelt-budget.test.ts
pnpm --filter legalwork-server exec bun test src/eigenwelt-usage.test.ts
```

Before release, use sandbox accounts in a built desktop app: exhaust a small test budget, open Usage & admin requests, submit a request, approve it from a separate admin session, fund the wallet through test Checkout if needed, and retry the task. Test a regular member and a remote collaborator to verify neither can perform owner/admin purchases. This implementation has not been deployed or exercised against live payment accounts.
