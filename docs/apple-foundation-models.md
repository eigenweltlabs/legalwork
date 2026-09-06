# Apple Foundation Models provider experiment

LegalWork connects OpenCode directly to Apple's local `fm serve` HTTP endpoint.
The experiment is disabled by default. OpenCode still owns the agent loop,
permissions, tools and workspace configuration.

## Try the PR on the beta Mac

Requirements: macOS 27 or later, `/usr/bin/fm`, and Apple Intelligence available
and enabled. PCC also depends on Apple's account, region and usage limits.

Check out the PR, then run from the repository root:

```sh
pnpm install --frozen-lockfile
LEGALWORK_EXPERIMENTAL_APPLE_FM=1 pnpm dev
```

In a **local** workspace, open the provider connection picker and click
**Apple Intelligence (experimental)**. That one action:

1. Reuses the local service or starts it in Apple's Terminal app.
2. Waits for the service and checks for the PCC model.
3. Verifies a streamed tool call and a real tool-result round-trip.
4. Registers `apple-fm/pcc` through the existing OpenCode provider configuration.

There are no endpoint fields, model settings, keys or separate test buttons.
If checks fail, the provider is not registered and the screen offers **Connect**
to retry. Keep the Terminal service running while using the provider. Closing
it stops Apple's endpoint; reconnect to restart it.

Apple may require its own first-use setup or CLI terms acceptance. LegalWork
cannot accept those on the user's behalf. If the service cannot start, the
connection error points to the Terminal window for that setup. The app starts
only the documented command `/usr/bin/fm serve --host 127.0.0.1 --port 1976`;
it does not bypass Apple's availability, quota or entitlement checks.

The flag must equal `1`. The entry is hidden on older macOS, Windows, Linux,
web-only clients, remote workers, and Macs without the CLI. Restart the dev app
to change the flag. No release workflow is changed or dispatched by this PR.

## Automatic tool verification

The check makes two small streaming requests to `http://127.0.0.1:1976/v1`.
First the model must emit a structured `tool_calls` event with valid JSON
arguments. Only then does the test generate a random verification code and
supply it as a real `role: tool` result. The second response must return the
exact code. Text claiming that a tool ran is a failure. No user files, shell
commands or external tools are exposed. Requests can consume Apple model quota.

Passing this probe does not prove that every OpenCode tool schema or long
conversation works. On the beta Mac, also try reading a fresh file with an
unpredictable value and writing a second file. Confirm actual tool events and
on-disk results. Record `sw_vers` and `fm serve --help` when reporting failures.

## Beta status researched September 6, 2026

- Apple's [macOS 27 beta 8 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes)
  list a fix for excessive on-device tool calls with guided generation. They do
  not explicitly identify a fix for `fm serve` dropping structured tool calls.
- The [fm-proxy maintainer's August 18 audit](https://github.com/gregbarbosa/fm-proxy/commit/6880b537e37773266b657fa79b601354cabab266)
  reports missing tool calls in betas 5 and 6. This is a first-hand third-party
  report, not proof of behavior on beta 8. No verified beta 8 fix was found.
- The [CLI manual dated June 8, 2026](https://keith.github.io/xcode-man-pages/fm.1.html)
  documents `serve`, binding options and the `pcc` model ID.

This PR is for local development testing. It does not establish permission for
commercial CLI distribution; Apple's [PCC requirements](https://developer.apple.com/private-cloud-compute/)
and [staff response](https://developer.apple.com/forums/thread/842813) remain
relevant before release.

## Verification

```sh
node --test apps/desktop/electron/apple-foundation-models.test.mjs
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/desktop typecheck:electron
node apps/desktop/scripts/check-electron-bridge.mjs
```

Tests cover flag/version gating, loopback URLs, startup/readiness, reusing a
running server, discovery, fragmented SSE, rejection of prose and invented
results, and a real local HTTP round-trip against a fake model server.
The implementation machine runs macOS 15.6.1 without `fm`, so actual Apple
inference and full OpenCode execution remain unverified until tested on the beta Mac.
