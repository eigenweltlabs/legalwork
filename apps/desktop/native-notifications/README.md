# Assistant sender avatars on macOS

Electron's `Notification.icon` becomes an image attachment on macOS. This bridge uses an incoming `INSendMessageIntent` so the selected assistant avatar is the sender image instead. The OS retains the app badge. The display name and avatar come from the current profile, never a hardcoded character.

`build-notifications.mjs` builds the Node-API module using the existing cmake-js and node-addon-api dependencies. Development and packaging run it automatically. Other platforms use Electron's icon support.

The main macOS app declares `INSendMessageIntent`. Sender avatars also require the Communication Notifications capability in the app's signature and a matching Apple provisioning profile. An accepted notification request alone does not prove avatar support: macOS may silently show the app icon when the capability is missing. The native bridge checks the running process's entitlement and explicitly falls back to an ordinary notification when it is absent.

For development, provision `com.eigenweltlabs.legalwork.dev` with Communication Notifications using an Apple Development certificate. Xcode must have a signed-in Developer account. The dev launcher finds a matching, unexpired profile and installed signing identity automatically. `LEGALWORK_MAC_PROVISIONING_PROFILE` may specify a profile explicitly. It signs only the generated dev app's main executable with the capability, preserving ordinary signatures on nested Electron helpers. Without a matching profile it uses ad-hoc signing and logs that notifications will retain the app icon.

For distribution, enable the capability for `com.eigenweltlabs.legalwork` and supply its matching distribution profile. Pass `-c.mac.entitlements=build/entitlements.mac.assistant.plist -c.mac.provisioningProfile=/absolute/path/to/profile.provisionprofile` to electron-builder. Default builds keep ordinary entitlements, avoiding an unlaunchable app when no profile grants the restricted capability. Helper processes keep the ordinary inherited entitlements.

The native delegate handles assistant notification clicks and forwards unrelated notifications to Electron's delegate. Delivery failure falls back to Electron, but a timeout does not, to avoid duplicates if macOS accepts the original request late.

Verify with:

- `node apps/desktop/scripts/build-notifications.mjs`
- `node --test apps/desktop/electron/communication-notifications.test.mjs apps/desktop/electron/desktop-notifications.test.mjs`
- `node --test apps/desktop/scripts/mac-notification-signing.test.mjs`
- A real assistant reply while the app is in the background. Verify the selected avatar, current name, click-through to its chat, and the notification toggle.
