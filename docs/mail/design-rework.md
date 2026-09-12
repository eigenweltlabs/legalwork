# Mail design rework (EIG-172)

The previous compact layout did not match the surrounding app settings. This pass replaces the Mail-specific disclosure stack and native form controls with the same section surfaces, joined rows, tabs, menus, selects, inputs and switches used elsewhere in Settings. The actual Privacy page and AI Providers pattern are the comparison references.

Connected accounts have separate name/address hierarchy and an explicit Add account flow. Reconnect and disconnect are in each account's options menu. Shared-mailbox setup is requested explicitly. Notifications use the standard settings row layout; sending, access, retention and portability use shared form controls. Permissions and destructive confirmations remain explicit.

The isolated full-shell preview uses `tests/fixtures/mail-design/vite.config.ts` to resolve one React instance and load the production font from shared worktree dependencies. Its profile and synthetic API remain separate from the normal app. No provider, model or real account actions are used.

Current validation: focused journey TypeScript check passes. Earlier actual full-shell Settings captures show the new account and notification surfaces. The targeted onboarding test's native-select interaction was updated for the Base UI control and still requires its serialized validation slot. Final visual and functional acceptance is pending the combined conversation/design preview; no platform qualification is claimed here.
