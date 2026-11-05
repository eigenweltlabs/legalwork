# Browser issues inherited from v1

On 26 October 2026 the user chose to track these bugs separately from engine
migration completion. Migration acceptance still requires no regression from v1.
Neither issue authorizes removing a browser capability, lowering screenshot
limits, changing permissions or claiming full background-capture reliability.

## Background screenshots can stall

**Status:** inherited, unresolved; separate browser work.

Exact unchanged pre-migration browser modules on the same Electron 43.8.3 runtime
reproduce hidden-preview/capture failures on Linux and Windows. Visible captures
pass the corresponding pixel controls. A Windows hidden preview can succeed
initially while a later hidden full-page capture does not settle during the
diagnostic observation. An overlapping capture can also produce incorrect pixels.
These observations establish a reproducible problem, not an infinite-hang claim.

The physical capture queue remains serialized. Stop can settle the caller while
an already dispatched Chromium capture still owns its lease until the native
promise settles. A later capture on that page can wait; normal page close remains
the recovery path. No forced window visibility, alternate compositor flags or
permission bypass was adopted. Native OpenCode separately requires a visible tab
and desktop window for its screenshot action.

**Future acceptance:** actual Electron and packaged-app background preview,
full-page capture, cancellation and close/reopen controls; verify pixels, owner
isolation and exact capture settlement without overlapping physical captures.

## Full-page capture can lose the right edge

**Status:** inherited, unresolved; separate browser work.

A page with an occupied classic scrollbar gutter can temporarily expand from
417 to 432 CSS pixels while Chromium captures it. The original full-page clip
stays 417 pixels wide, so content at the right edge is lost. Read-only geometry
observations and Chromium's screenshot implementation identify the cause:
`captureBeyondViewport` hides scrollbars while rendering. Exact v1 modules
reproduce it; an explicitly stable-gutter fixture preserves the edge but does
not establish correctness on ordinary pages.

The owned-stylesheet prototype was rejected: author cascade rules can defeat it,
and safe cleanup/navigation behavior is not fully established. Two further
supported-CDP controls on Mac reproduce the problem without product changes:
omitting the clip still loses the edge; disabling beyond-viewport capture
preserves the visible edge but leaves the page's bottom blank. No workaround
was adopted.

**Future acceptance:** ordinary default-gutter pages with exact full-page pixels
and geometry; RTL, horizontal overflow, zoom, authored important rules,
navigation and cancellation/cleanup controls. Preserve authored page state.

## Migration-specific Mac race is fixed

This is separate from the two inherited issues. The first automatic thumbnail
could start before the tab's existing initial-load promise settled, preventing
later visible captures from acquiring the physical capture queue. The fix waits
for that promise and rechecks the exact current tab. New controls fail against
the old code; the full desktop suite passes. Both fast and delayed dev-server
reproductions and the original normal final7 packaged Mac scenario pass. The
normal package uses no diagnostic observer, special page CSS or capture flags.

## Retained evidence

Private complete evidence remains under `~/.codex/benchmarks/` and the approved
private EU cloud evidence bucket; do not publish traces or credentials. Key local
indexes:

- `legalwork-linux-v2-preparation-20261025/owned-gutter-component-full-proof.receipt.json`
- `legalwork-linux-v2-preparation-20261025/final2-normal-native-browser-proof/`
- `legalwork-browser-fullpage-diagnosis-20261026/capture-beyond-discriminator/review.receipt.json`
- `legalwork-final7-dev-9c278-mac-http-policy3-20261026/root-normal-visible-browser-acceptance.receipt.json`

Primary references: [Chromium screenshot implementation](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/page_handler.cc),
[CDP Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot),
[Electron capturePage](https://www.electronjs.org/docs/latest/api/web-contents/#contentscapturepagerect-opts).
