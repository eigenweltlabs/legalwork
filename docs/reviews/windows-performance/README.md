# Windows login, performance and ARM64 investigation

Test machine: VMPal 0.38, Windows 11 Pro 24H2 ARM64, 7 virtual CPUs, 16 GB RAM. The downloaded installer is `legalwork-win-x64-0.2.4.exe`; the installed executable has PE machine type `0x8664` (x64). Electron confirms `app.runningUnderARM64Translation === true`, although Node's `os.machine()` reports `x86_64` and `PROCESSOR_ARCHITECTURE` reports `AMD64` inside that process.

## Confirmed causes and changes

- The desktop's saved workspace list reintroduced local firm projects that the server had removed. Saved selection then routed account and engine requests to a nonexistent workspace. A successful server registry is now authoritative for local projects, including an empty registry. Remote connection entries remain available. Selection resolves to a registered ID, using the saved path when an ID migrated.
- Settings awaited session indexes from every workspace before publishing its connection and project list. Account settings now become usable once the registry is ready; session loading continues in the background, and stale refresh results are ignored. Automatic engine reloads still wait for session status to protect active work.
- Account save errors were swallowed, then hidden behind engine reload errors. Saving credentials must now succeed before reloading. Structured errors display their message instead of a raw JSON object.
- Sign-in, sign-out and model refresh could trigger redundant engine reloads. Their owners now perform one refresh; provider cache invalidation no longer enumerates active providers twice.
- Account settings and the model picker used different cache identities for the same provider endpoint. They now share the endpoint identity, and the authentication store consumes the provider refresh already completed by invalidation. This removes a second 6.6 MB provider response when opening the picker.
- File listing constructed locale-aware numeric collation on every comparison. Reusing one `Intl.Collator` preserves ordering while reducing CPU work in directories with many entries.
- Cold engine metadata reads and session listing exceeded their 10/12-second deadlines. These bootstrap reads now allow 90 seconds; health and transcript reads retain their shorter deadlines. Caller cancellation is preserved through the OpenCode transport instead of being overwritten or misreported as a timeout.
- The Windows control bridge could fail permanently for that launch when a reader briefly locked its discovery file. Atomic replacement now retries transient Windows locks for at most 750 ms, preserving the separate owner-only file and failing closed for persistent errors.
- Engine reload used a generic 10-second request deadline despite cold startup and cloud file hydration. Server reload and direct instance disposal now allow 90 seconds, followed by up to 30 seconds for health. Direct recovery remains available after transient failures. Missing workspaces and authorization failures do not trigger another disposal.
- Architecture detection missed Windows ARM64 emulation. When it did detect a mismatch, rendering depended on release-feed requests without a timeout. Detection now uses Electron's translation flag and renders a dismissible advisory alongside the app. Native download lookup is explicit and bounded, and never fabricates an installer URL.

## Windows observations

A controlled experiment added six seconds to session-index responses in the isolated development app, with one live project and a stale selected project. It is a dependency-isolation test, not a general startup benchmark.

| Observation | Released frontend | Patched frontend |
| --- | --- | --- |
| Settings project resolved | 6,594 ms, stale project | 707 ms, live project |
| URL after resolution | stale workspace ID | canonical live workspace ID |
| Cold session response | approximately 6 seconds | approximately 6 seconds, in background |

The accompanying [before](baseline.json) and [after](patched.json) JSON records contain the timing samples. The brief old home frame at 80 ms in the patched trace is not counted as resolved settings.

A clean 8-second idle sample consumed 0.200 CPU-seconds in Electron's main process and 0.047 CPU-seconds in its renderer. A separate 15-second CPU profile was predominantly idle, with periodic reload/session-group polling. This did not reproduce a runaway idle loop.

A five-route navigation sample still had renderer long tasks of 50 to 177 ms, and individual provider/MCP requests took approximately 1.6 to 2.1 seconds. Graphics used the VirtIO D3D11 renderer with hardware compositing. A 90-frame sample had a median interval of 15.9 ms and a 95th percentile of 32.9 ms. These measurements do not establish that all Windows performance issues are fixed.

## Extended speed review

The unmodified x64 and ARM64 PR installers from commit `d24f287cf` were extracted without installation and launched with separate synthetic workspaces, databases and user profiles. The user's installed app was left intact. [Raw measurements](packaged-measurements.json) include every attempt and the failed trial.

With initialized profiles, the median of completed runs was:

| Measurement | x64 under ARM translation (2 runs) | Native ARM64 (3 runs) |
| --- | --- | --- |
| Renderer controls available | 3,688 ms | 2,329 ms |
| Authenticated server registry available | 9,082 ms | 4,427 ms |
| Engine reload | 383 ms | 82 ms |
| Main-process CPU during the trial | 8.52 seconds | 4.34 seconds |

There were three attempts per architecture. One x64 run could not discover the control bridge after an `EPERM` atomic rename error; the app continued serving requests. The regression test reproduces a Windows reader lock, releases it, and verifies the new endpoint and token. The persistent-lock test still verifies failure and cleanup. Both passed on the VM with the packaged ARM64 Node runtime.

These are small, sequential samples on one VM, with warm OS caches and shared host load. Renderer control readiness does not mean all project data is loaded. Navigation waits include approximately 360 ms of control-surface choreography and must not be interpreted as raw click latency. The initial fresh-profile run did not wait for the requested navigation route, so its navigation timings are excluded from comparisons.

Two targeted changes were measured separately, using the updated sources:

| Measurement | Before | After |
| --- | --- | --- |
| Provider downloads, settings followed by model picker | 2 | 1 |
| Extra provider request on picker open | 908 ms, 6.6 MB | avoided |
| Actual file-list handler, 2,000 files, x64 median of 6 | 110 ms | 48 ms |
| Actual file-list handler, 2,000 files, ARM64 median of 6 | 55 ms | 18 ms |

The [optimization records](speed-optimizations.json) preserve all samples. File-list measurements include filesystem metadata, sorting, JSON serialization and decoding, but exclude HTTP transport. Before/after handlers alternate against the same fixture and assert identical output. The provider check observes real renderer requests through CDP and verifies that the model dialog opens.

Fresh profiles still took 43 seconds on ARM64 and 65 seconds on x64 to answer the first session request. The ARM64 engine log has a 42.8-second gap between configuration loading and completed bootstrap; the subsequent reload initialized in approximately 74 ms. Upstream [configuration initialization](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/config/config.ts) installs plugin dependencies, and [plugin initialization](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/index.ts) waits for those installs. LegalWork loads external plugins, so this is consistent with first-use dependency setup. The trace does not isolate network time from installation or antivirus scanning. The longer read deadline prevents premature retries; it does not eliminate that setup cost. A 13-second response regression verifies that provider and session reads complete once, without retries. In the Windows dev UI, a provider response held for 13 seconds completed in 14,233 ms without a second request, and the model picker opened. See [the recorded result](cold-metadata.json).

### Reproducing the measurements

- Extract the two CI packages into `<root>/x64` and `<root>/arm64`. Run `node packaged-speed-review.cjs <root> 1` for separate fresh profiles, then `node packaged-speed-review.cjs <root> 3 <samples-directory>` for initialized profiles. The script starts and terminates only its own process trees. It creates synthetic files and does not print authentication tokens.
- Build the server before and after the sorter change. Put the compiled modules beside their dependencies as `files.js` and `files-speed-review.js`, then run `node file-route-speed.mjs <routes-directory> <synthetic-directory>` with each packaged Node runtime. The fixture must contain 2,000 synthetic files.
- With the isolated dev renderer on CDP port 9230 and synthetic workspace `ws_live`, run `node provider-cache-check.cjs before` and `after` against the respective builds. The adjacent `cdp.cjs` supplies the transport. This reloads the dev window and opens the model picker. `node provider-cold-window.cjs cold-window` additionally holds provider responses for 13 seconds to verify the longer deadline in the real renderer.

## Native Windows release support

Stable and alpha workflows now build on `windows-11-arm` with the `aarch64-pc-windows-msvc` target. The existing Node and OpenCode preparation paths select ARM64 binaries. PR packaging smoke tests also build and launch ARM64, check native modules, and verify the PE architecture of the packaged app, Node and engine.

Windows feeds are deliberately separate: `latest.yml` for x64, `latest-arm64.yml` for ARM64. NSIS selects the first executable in a manifest rather than filtering by architecture, so merging both into the old feed would break existing x64 clients. The publishing validator rejects mixed feeds. Signing stages and artifact names accept both architectures without collisions.

`sherpa-onnx-node` 1.13.3 has no Windows ARM64 npm addon. The build compiles its N-API adapter against checksum-pinned upstream ARM64 C libraries, using the same source version as the installed JavaScript wrapper. It preserves the upstream license and fails the build if the addon cannot load. Source: [sherpa-onnx v1.13.3](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.3), Apache-2.0. No upstream source is vendored in this PR.

A native installer will become available after this change is merged and a release is built and published. The currently published v0.2.4 has only x64 Windows assets. This PR offers a matching download when available; it does not silently migrate an installed app between architectures.

## Validation

- `pnpm --filter @legalwork/app test`: 867 passed.
- `pnpm --filter @legalwork/app typecheck`: passed.
- `pnpm --filter @legalwork/app test:i18n`: passed, both shipped languages complete.
- `LEGALWORK_ELECTRON_BUILD=1 pnpm --filter @legalwork/app build`: passed.
- `pnpm --filter legalwork-server build`: passed.
- `pnpm --filter @legalwork/desktop test`: 197 passed, two platform skips on macOS. The Windows control-bridge suite passed five tests with two POSIX-only skips in the VM.
- `pnpm --filter legalwork-server test:artifacts`: 28 passed, including natural numeric and accented filename ordering.
- `pnpm --filter @legalwork/desktop typecheck:electron`: passed.
- `pnpm --filter @legalwork/desktop check:electron`: passed, 110 renderer methods covered.
- `node --test scripts/release/*.test.mjs`: three passed, including architecture-separated Windows feeds and rejection before upload when an x64 feed contains an ARM64 installer.
- In the Windows dev app, architecture detection returned the correct mismatch in 7 ms through CDP. The explicit release check reported no ARM64 installer while account settings remained visible. See the [recorded result](architecture.json).
- The full Windows account UI flow passed with local OAuth fixtures and a 10.25-second reload: one sign-in reload, one sign-out reload, no error toasts.

The native ARM64 packaging job is the authoritative check for the new compiler/toolchain path. Signed release publication is not exercised by a pull request.
