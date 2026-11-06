# Native OpenCode 2.1.4 browser

LegalWork uses the released native browser plugin and its full RPC v4 controller: all 45 operations, native element refs/generations, navigation, uploads/downloads, snapshots, screenshots, evaluation, console/network diagnostics, accessibility inspection, profiling, tracing, heap snapshots and Lighthouse analysis remain discoverable. The matching Electron driver is vendored from the private upstream GUI package because the published server plugin does not contain that driver. Its MIT license is included. This is a pinned integration, not an independently invented browser protocol.

## Ownership, profile and network

The main process attaches the actual saved native session before ordinary prompt/command admission. Every tab belongs to one server, project, chat and app window. Native replacement stops the old controller; background activity cannot automatically reclaim it. Selecting/reopening that chat explicitly may take control again. Other chats retain their own tabs. Native focus opens the browser beside its owning chat; background tools do not navigate the user's foreground pane. Existing task cards, dismissal/promotion, multiple windows and browser-panel layout remain supported.

The default partition remains `persist:legalwork-browser`, preserving the approved shared site login, cookies and local storage. This intentionally shares site identity across chats. It does not share tab-control authority or project file roots. A single shared-profile file URL guard identifies the owning WebContents rather than borrowing whichever chat registered last.

The shared profile uses the desktop's existing network and proxy. Native per-attachment tunnelling never overwrites that shared partition's proxy. A manually connected/cloud LegalWork server therefore does **not** imply cloud-server network geography or routing. Browser operations check the originating chat's effective sandbox/network policy before execution and while idle; protected network modes `approve` and `block` deny this desktop browser. Unavailable or uncertain authority fails closed. A future separate/private profile could use the upstream tunnel without changing the shared profile, but no private-profile selection UI is introduced by this migration.

## Local and manually connected servers

Local managed-engine credentials stay in main/server. For an existing manually selected LegalWork server, the trusted app registers its already-held user client token in main and receives an opaque, per-window connection ID. That registration is not accepted from website WebContents. Credentials are not written to browser restore state or returned to the model.

The server gateway permits only the exact saved session read, filtered native browser-control events and methods declared in the pinned `Browser.Definition`. It checks collaborator access, exact project membership, native project automation approval, ancestry, worker exclusions, network policy and actor ownership of the attachment connection ID. General engine RPC, credentials and administrative APIs remain blocked. Two client credentials cannot reuse each other's attachment.

LegalWork's additional operations use a small authenticated reverse channel between that server and desktop, restricted to `batch`, `downloads`, `upload`, `capture` and a completed owned `download`. Each opaque capability identifies one actual native tab/session/project. Queued cancelled mutations are removed; delivered cancellation is forwarded to desktop. Transport loss invalidates pending requests; attachments and mutation requests are ephemeral and are not replayed on reconnect. A delivered page action cannot be rolled back, so uncertain outcomes require page inspection.

## Capability-preserving extensions

Native operations are preferred. `legalwork_browser_open_url` creates a native tab; `legalwork_browser_connect({tabID})` connects an already-owned native tab (the earlier `tab_id` argument remains accepted). Both advertise a typed, direct `{tabID, browser_url, url, snapshot:{tab, content, truncated}}` result, without the UI transport's `result` envelope. Opening, listing matching password metadata and subsequent native operations can therefore compose without reopening a tab to inspect its return shape. Reconnecting refreshes refs just as `browser.snapshot` does. The optional CSS batch tool still returns its legacy paged snapshot with continuation offsets; its `node_id` and CSS selectors are not native refs.

Default native observations traverse the full accessibility tree, omit unnamed layout containers, and bound rendered output to the existing 500 lines / 100,000 characters. Explicit depth bounds the displayed tree. Nested application editors, including shadow-DOM textboxes, expose usable refs; normal field/read-only editor values appear in bounded observations, while protected password values remain omitted. Focused `browser.find` filters while traversing, so it can reach a target after the default observation's output budget. Condition waits may follow document generations across navigation; mutations retain their stale-generation checks. Code Mode has no timer global: use `browser.wait` with an observed condition.

The main-process attachment retains its existing browser pages when its owning renderer reloads a trusted LegalWork URL. This preserves unsaved inputs, page history and native refs rather than recreating tabs from saved URLs. Window destruction, navigation outside the trusted app, ownership replacement and network-policy revocation still close the attachment.

Fixed browser instructions teach focused Code Mode discovery with complete signatures, reuse of retrieved definitions, and sequential awaited native operations in one execute for already-observed, authorized steps. A normal sign-in can open/list metadata together, then fill username/password and submit together, followed by a condition wait and verification. Navigation, new fields, MFA/CAPTCHA and partial failure require observation before further mutations. This uses the released Code Mode and browser tools; it adds no execution limits or detached agent and changes no permission decisions.

The fixed browser instructions include directly callable Code Mode examples for
opening and observing a tab, reusing its ID, finding controls and interacting with
fresh refs. These common operations do not require a catalogue search. Additional
operations remain discoverable through targeted searches. This avoids requiring
the model to page through all 45 browser tools before starting ordinary research;
the instructions contain no live tab state or website-specific selectors.

`legalwork_browser_upload` copies complete file bytes under normal native read permission for each exact server/project path. Desktop receives bytes and filenames, not arbitrary server paths it is expected to open. Private temporary upload files are removed when their tab capability closes.

`legalwork_browser_capture` offers background capture and saves the complete image under normal native edit permission inside the originating project. File-path/symlink checks prevent saving into another project. It does not require exposing or focusing that tab. Background rendering has unresolved failures described below; the presence of this operation does not establish reliable background screenshots.

Local completed downloads save directly under the originating project's visible `Downloads` folder, including files above 5 MiB. For a manually connected server, desktop holds its own private download until `legalwork_browser_downloads` transfers the complete bytes to that actual project's `Downloads` folder under normal native edit permission. The filename includes the download identity to prevent overwriting another file. Desktop-only paths are withheld from server results. Successful repeated reads reuse the saved result; an uncertain/partial write is reported instead of repeated into another filename. These transfers buffer complete bytes/base64 in memory; there is no new application file-size cap, but available memory/disk still matters.

## Limits and verification

Current acceptance caveat (2026-10-26): the native controller/module import and
extension's explicit viewport flag are corrected. Native and extension captures now share
one physical-operation queue per tab, including element-scroll captures. Stop
returns immediately while the physical capture retains its lease until it
settles; queued work rechecks authority and is rejected on disposal. There is
no queue-size, content-size or additional task-duration cap. A stalled physical
capture can delay later captures or element actions on that tab; normal page
close is the recovery path, and other tabs remain usable. The reviewed source
passes 33 focused tests and 106 actual Electron component checks.

The normal final2 Linux app additionally passes 49 native Tool RPC checks on a
page explicitly reserving its scrollbar gutter, including repeated full and
viewport pixels, complete 6 MiB download, ownership and policy revocation. This
is qualified component evidence: ordinary default-gutter full-page captures
can still crop the right edge when Chromium temporarily hides scrollbars and
changes layout. Unchanged v1 modules reproduce that failure on the same
Electron/Chromium version. Hidden captures also remain unreliable; overlapping
v1 captures produced incorrect pixels. Rejected frame-subscriber/wake and
browser-host experiments are not adopted. An isolated owned-stylesheet
prototype passes 75 controlled checks, including expected negative cases,
author-change preservation and physical-capture cleanup. Author-important
rules defeat it, and BFCache, OS-overlay, RTL, horizontal overflow, zoom and SVG
behavior remain unproved. It is not adopted; no new screenshot refusal or cap
is introduced to conceal the inherited capture failure.

Mac final2 native browser readiness failed. Its owned synthetic task was
interrupted through the public API and active work became empty; visible Mac
and fresh paid-browser acceptance remain required. The first paid v2 browser
task remains a browser-capability failure despite correct legal findings and
PDF. Do not infer full browser or real-agent clearance from positive component
checks or the intended extension contract above.

| Contract | Native 2.1.4 behavior | LegalWork preservation |
|---|---|---|
| Native transferred file | 5 MiB | Complete upload/download/capture extensions; native limit remains truthful |
| Native snapshot/find | 100,000 characters; 500 accessibility lines; default structural depth 8; explicit depth 1–20 | Compact observations with semantic depth; full-tree find before limiting matches; unchanged output limits and existing paged snapshot extension |
| Native JSON operation output | 512,000 characters | Native error is reported; extension paging/full file storage covers the supported extended operations |
| Native screenshot | Visible-tab readiness guard of 3 seconds; at most 16 megapixels; default maxWidth 2,000, optional maxWidth at most 4,000 | Background full-image capture operation, with unresolved rendering failures above |
| Native retained console/network data | Bounded native diagnostic buffers (500 records); network text-body capture at most 20,000 characters | Upstream behavior retained, truncation/availability metadata preserved |
| Existing LegalWork batch | 20 steps; 64,000-character request; existing action/tool time budgets | Same baseline constraints; no new task deadline |
| Existing LegalWork snapshot pagination | 500 elements / 200 controls retained; paged text/control output | Same baseline constraints and explicit continuation |
| Mutation cancellation | Already-delivered browser actions may complete | No automatic replay; queued work removed; cancellation propagated |

`scripts/browser-native-regression.mjs` runs actual Electron/CDP against the isolated released CLI and a separate real LegalWork server process. It verifies all native operations are registered; navigation/snapshots/evaluation; shared cookies/storage; session ownership and replacement; legacy batch; complete 6 MiB uploads/downloads; background and visible screenshots; console/network; manual-server gateway and extension transfer; native project approval; viewer and second-client denial; review-worker exclusion; cancelled delivered mutation without replay; idle network-policy revocation. It uses no model inference, account credentials or global profile.

Focused service tests additionally cover exact native file permissions, cancellation without post-abort writes, foreign symlink rejection, complete provenance output, undelivered mutation removal and disconnect invalidation. These are engine/transport tests, not evidence of real-model browsing quality. Real websites, authenticated services, live Office behavior, packaged platform matrix and paid-model quality are separate acceptance runs.

`pnpm --filter @legalwork/desktop test:browser-observation` runs the shipping
controller against actual Electron/CDP in a hidden, unfocused window. It covers
forty layout wrappers, explicit semantic depth, fresh/stale refs, targets after
600 controls, bounded matching output and same-/cross-origin frames. It uses no
model calls and does not establish a paid-model speed improvement.

Sources: [native browser plugin/RPC](https://github.com/anomalyco/opencode/tree/v2.1.4/packages/plugin-browser), [upstream Electron driver](https://github.com/anomalyco/opencode/tree/v2.1.4/packages/gui-extensions/src/browser).

Saved website passwords use the existing vault and native agent tab through LegalWork's additional tools. See [browser password architecture and its first-version limits](browser-login-architecture.md).
