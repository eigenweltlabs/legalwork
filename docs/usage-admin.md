# Usage requests and administration

LegalWork exposes model-api's member budgets in Settings → Eigenwelt account and inline in chat after a provider quota error. Members request a temporary monthly increase, a recurring limit, or Pro. Organization admins see requests, invite members or change their plans and spending limits, and initiate Stripe credit purchases from the same panel.

The app calls `GET/POST /workspace/:id/eigenwelt/usage`. These server routes require owner scope because the Eigenwelt account credential belongs to the device owner. The server refreshes that credential and calls the fixed platform `/api/usage-control` endpoint; the renderer never receives it. The platform verifies current membership, organization ownership and admin role on each action. Seat changes refresh cached desktop entitlements. The screen polls while visible so decisions and paid top-ups become visible without signing in again.

The UI uses existing Card/Button/Input primitives and Base UI dialogs, with the application's English/German dictionaries. Saved-card top-ups are confirmed in the app; payment setup and bank verification open Stripe in the system browser. The new panel does not replace the existing sign-in, trial, member-invitation or organization-selection flows.

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

## Sync and provider quotas

Sync includes every paid collaboration feature and no included AI allowance: €15/month billed yearly or €20 monthly, excluding VAT. The plan screen has Free, Sync and one AI card with Plus/Pro tabs. Choosing Sync opens a provider dialog with ChatGPT first; desktop checkout can return a preferred provider and continue into the existing OpenCode OAuth flow. No new provider token store is introduced.

Permanent subscription/funding errors stop on the first engine retry, even for background sessions; temporary throttling continues to retry. Queued messages stay paused. The inline card offers Free users Plus/Pro, Sync users upgrades and top-ups, Plus users Pro/top-ups, and Pro users top-ups. Organization members request admin approval; admins use existing member-bound price previews and saved-card purchases. Credits fund LegalWork AI and cannot increase another provider's allowance. Model switching remains a deliberate user action.

The owner-authorized usage API continues to protect billing. A separate collaborator-authorized `POST /workspace/:id/sessions/:sessionId/usage-limit` annotates only the supplied assistant turn. The server verifies the turn belongs to the session and obtains the provider from the engine. It stores the reason in runtime.sqlite, then enriches message/snapshot reads so reopening the chat preserves the recovery UI. It does not grant usage or modify provider credentials.

OpenAI's [sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [UI guidelines](https://developers.openai.com/siwc/token-sharing-open-source/ui-ux-guidelines) keep ChatGPT subscription usage separate from application billing. The card links to `https://chatgpt.com/settings/usage` for ChatGPT limits. Eligibility still depends on the user's ChatGPT plan.

Verified on 2026-09-30: 69 focused app tests, 30 focused server tests, app/server typechecks, and all 5,153 English/German translation keys. Dedicated Electron smoke tests show immediate limit recovery and its persistence when reopening a chat. Browser fixtures also verify the platform plan switcher/provider dialog on desktop and mobile. No production rollout or actual user ChatGPT OAuth grant has been performed.
