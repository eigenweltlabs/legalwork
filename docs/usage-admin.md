# Usage requests and administration

LegalWork shows two read-only usage rows in Settings → Eigenwelt account and focused recovery actions inline in chat after a provider quota error. Members open **Request more usage** directly to ask for a temporary monthly increase, a recurring limit, or Pro. Admins open focused dialogs to increase their personal limit, increase the team limit, enable extra usage, upgrade their seat, or add credits. Broader member management and request approval open the platform Billing page; there is no Usage & Limits panel in the desktop app. The old panel/wrapper, member-invitation editor and duplicate translation table have been deleted; the plan component only upgrades the signed-in member. The usage wire contract and owner-authorized API remain necessary for these focused actions and the two read-only account rows.

The app calls `GET/POST /workspace/:id/eigenwelt/usage`. These server routes require owner scope because the Eigenwelt account credential belongs to the device owner. The server refreshes that credential and calls the fixed platform `/api/usage-control` endpoint; the renderer never receives it. The platform verifies current membership, organization ownership and admin role on each action. Seat changes refresh cached desktop entitlements. The app refreshes usage after an action and reports whether work can continue. If the write succeeded but the usage read fails, the confirmation offers Refresh without repeating the mutation or payment.

The UI uses existing Card/Button/Input primitives and Base UI dialogs, with the application's English/German dictionaries. Saved-card top-ups are confirmed in the app; payment setup and bank verification open Stripe in the system browser. The focused dialogs use existing billing services and preserve the sign-in, trial, member-invitation and organization-selection flows.

Deploy the matching model-api implementation and follow its `docs/member-budgets.md` rollout before enabling an organization. Unactivated organizations see an activation notice. The versioned wire types in `packages/types/src/usage-control.ts` mirror model-api's `packages/shared/src/usage-control.ts`; update both when changing the contract.

Verification from this repository root:

```sh
pnpm --filter @legalwork/app typecheck
pnpm --filter legalwork-server typecheck
pnpm --filter @legalwork/app test:i18n
pnpm --filter @legalwork/app exec bun test tests/usage-control-client.test.ts tests/eigenwelt-budget.test.ts
pnpm --filter legalwork-server exec bun test src/eigenwelt-usage.test.ts
```

Before release, use sandbox accounts in a built desktop app: exhaust a small test budget, click Request more usage, submit a request, approve it from a separate admin session on the platform, fund the wallet through test Checkout if needed, and retry the task. Test a regular member and a remote collaborator to verify neither can perform owner/admin purchases. This implementation has not been deployed or exercised against live payment accounts.

## Sync and provider quotas

Sync includes every paid collaboration feature and no included AI allowance: €15/month billed yearly or €20 monthly, excluding VAT. The plan screen has Free, Sync and one AI card with Plus/Pro tabs. After confirmed Sync checkout, or when a Sync user signs in without their own provider connected, the desktop opens a provider dialog with ChatGPT first. Use my ChatGPT plan starts the existing OpenCode OAuth flow directly; API keys stay under other providers. The same dialog offers an AI plan upgrade. Platform checkout never opens this dialog and skips model selection for Sync. No new provider token store is introduced.

Permanent subscription/funding errors stop on the first engine retry, even for background sessions; temporary throttling continues to retry. Queued messages stay paused. The inline card offers Free users Plus/Pro, Sync users upgrades and top-ups, Plus users Pro/top-ups, and Pro users top-ups. Organization members request admin approval; admins use existing member-bound price previews and saved-card purchases. Credits fund LegalWork AI and cannot increase another provider's allowance. Model switching remains a deliberate user action.

The owner-authorized usage API continues to protect billing. A separate collaborator-authorized `POST /workspace/:id/sessions/:sessionId/usage-limit` annotates only the supplied assistant turn. The server verifies the turn belongs to the session and obtains the provider from the engine. It stores the reason in runtime.sqlite, then enriches message/snapshot reads so reopening the chat preserves the recovery UI. It does not grant usage or modify provider credentials.

OpenAI's [sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [UI guidelines](https://developers.openai.com/siwc/token-sharing-open-source/ui-ux-guidelines) keep ChatGPT subscription usage separate from application billing. Limit recovery offers LegalWork AI plans and credits for every provider. Eligibility for OpenAI sign-in still depends on the user's ChatGPT plan.

UI evidence and alpha verification are recorded in the paired pull requests. Dedicated Electron smoke tests show immediate limit recovery and its persistence when reopening a chat. Fixtures exercise the focused admin dialogs and confirmations without charging a card or changing a real account. Production rollout and an actual new user ChatGPT OAuth grant still require acceptance testing.

Top-ups fund the shared wallet automatically; they do not allocate credits to individual members or change spending caps. An admin can resume LegalWork AI once the payment is confirmed if extra usage is enabled and personal and organization spending caps still permit it. Otherwise, the admin must raise the relevant cap or enable extra usage. An external provider's quota requires selecting a LegalWork AI model before retrying.

For visual review, the development-only `session-preview.html` renders the real chat and limit card with sample data. Select `?limit=free|sync|plus|pro&role=admin|member&provider=<provider-id>` (one value per parameter), for example `session-preview.html?limit=sync&role=admin&provider=anthropic`. Provider IDs may be `openai`, `anthropic`, `google`, `openrouter`, `eigenwelt`, or a custom ID. Saved-card and upgrade dialogs show illustrative read-only previews; billing changes and payments are disabled. No account or provider is connected.
