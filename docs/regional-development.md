# Regional Electron validation

## New-account onboarding

Run `pnpm dev:electron:onboarding` with the isolated neutral coordinator running
at `http://127.0.0.1:3006`. This opens **LegalWork Onboarding** on port
5187. Every launch creates a new profile under
`~/.legalwork/onboarding-validation/`, with no saved Eigenwelt account or region.

Create your first project, skip optional Office/recording setup, and choose
**Sign in**. In the browser, choose **Create an account**, create a new development
account and firm, then choose the infrastructure region **Europe** or
**United States**. Continue through the plan's Stripe **test-mode** checkout and
the model-selection step. Choose **Connect** to return to LegalWork, then start
a chat. The neutral coordinator provisions the chosen real regional validation
platform; it does not use the production bootstrap or alter production routing.

Use a different new account/firm for the second region, since a firm's region is
chosen once. A fresh Electron profile does not clear the browser's login; sign
out of the browser's test account before repeating signup with another account.
Clerk test addresses containing `+clerk_test` use verification code
`424242`. Stripe's test card is `4242 4242 4242 4242`, with a future expiry and any
three-digit CVC. Use synthetic names, addresses, documents and prompts.

The neutral coordinator has its own local database and development Clerk/Stripe
credentials. Regional provisioning secrets stay in a private environment file.
The regional platforms still enforce their assigned home for every account.

## Existing test firms

Run `pnpm dev:electron:regions` from the regional deployment worktree. This starts
**LegalWork Regions** on port 5186 with its own Electron profile and local data
under `~/.legalwork/regional-validation/`. It does not reuse the installed app's
accounts, workspaces or Office add-in registration.

Sign-in starts on the new EU platform using Clerk's development environment.
Choose **Infrastructure Validation EU** or **Infrastructure Validation US** with
the synthetic development account. The browser discovers the firm's assigned
region, and the desktop saves that platform with its account. The US choice
must finish on `us.platform.eigenweltlabs.com`; the EU choice must finish on
`eu.platform.eigenweltlabs.com`. Subsequent account, model, policy and storage
requests use the saved platform. Model inference geography remains a separate
setting. Sign out and sign in again to test the other firm.

The prepared synthetic login is
`regional-validation+clerk_test@eigenweltlabs.com`. Choose **Use another method**
and **Email code** if asked for its password; Clerk's test verification code is
`424242`. This applies only to this development account. Both firms have an
internally managed Pro plan and a €5 monthly validation allowance, with no
Stripe purchase needed. The browser may request sign-in once on each regional
host. If switching firms shows **We could not select this firm**, click
**Try again**; a first-load Clerk readiness issue was observed during validation.

Only synthetic documents and prompts belong in this validation environment.
These deployments use test billing and have selected integrations disabled.
Customer migration, live billing and production routing are separate rollout
steps; this launcher does not change them.

The launcher opts into `LEGALWORK_DEV_REGIONAL_ROUTING=1` together with
`LEGALWORK_DEV_MODE=1`. This permits callbacks from the two fixed regional
origins while bootstrapping from a regional platform. Custom installation
overrides remain isolated, and production bootstrap is not allowed in this
mode. Normal installations keep their existing endpoint rules.
