# Regional Electron validation

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
