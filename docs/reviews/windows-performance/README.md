# Windows login, performance and ARM64 investigation

Test machine: VMPal 0.38, Windows 11 Pro 24H2 ARM64, 7 virtual CPUs, 16 GB RAM. The downloaded installer is `legalwork-win-x64-0.2.4.exe`; the installed executable has PE machine type `0x8664` (x64). Electron confirms `app.runningUnderARM64Translation === true`, although Node's `os.machine()` reports `x86_64` and `PROCESSOR_ARCHITECTURE` reports `AMD64` inside that process.

## Confirmed causes and changes

- The desktop's saved workspace list reintroduced local firm projects that the server had removed. Saved selection then routed account and engine requests to a nonexistent workspace. A successful server registry is now authoritative for local projects, including an empty registry. Remote connection entries remain available. Selection resolves to a registered ID, using the saved path when an ID migrated.
- Settings awaited session indexes from every workspace before publishing its connection and project list. Account settings now become usable once the registry is ready; session loading continues in the background, and stale refresh results are ignored. Automatic engine reloads still wait for session status to protect active work.
- Account save errors were swallowed, then hidden behind engine reload errors. Saving credentials must now succeed before reloading. Structured errors display their message instead of a raw JSON object.
- Sign-in, sign-out and model refresh could trigger redundant engine reloads. Their owners now perform one refresh; provider cache invalidation no longer enumerates active providers twice.
- Engine reload used a generic 10-second request deadline despite cold startup and cloud file hydration. Server reload and direct instance disposal now allow 90 seconds, followed by up to 30 seconds for health. Direct recovery remains available after transient failures. Missing workspaces and authorization failures do not trigger another disposal.
- Architecture detection missed Windows ARM64 emulation. When it did detect a mismatch, rendering depended on release-feed requests without a timeout. Detection now uses Electron's translation flag and renders a dismissible advisory alongside the app. Native download lookup is explicit and bounded, and never fabricates an installer URL.

## Windows observations

A controlled experiment added six seconds to session-index responses in the isolated development app, with one live project and a stale selected project. It is a dependency-isolation test, not a general startup benchmark.

| Observation | Released frontend | Patched frontend |
| --- | --- | --- |
| Settings project resolved | 6,594 ms, stale project | 707 ms, live project |
| URL after resolution | stale workspace ID | canonical live workspace ID |
| Cold session response | approximately 6 seconds | approximately 6 seconds, in background |

Screenshots: [before](baseline.png), [after](patched.png). The accompanying JSON records the timing samples. The brief old home frame at 80 ms in the patched trace is not counted as resolved settings.

A clean 8-second idle sample consumed 0.200 CPU-seconds in Electron's main process and 0.047 CPU-seconds in its renderer. A separate 15-second CPU profile was predominantly idle, with periodic reload/session-group polling. This did not reproduce a runaway idle loop.

A five-route navigation sample still had renderer long tasks of 50 to 177 ms, and individual provider/MCP requests took approximately 1.6 to 2.1 seconds. Graphics used the VirtIO D3D11 renderer with hardware compositing. A 90-frame sample had a median interval of 15.9 ms and a 95th percentile of 32.9 ms. These measurements do not establish that all Windows performance issues are fixed, or quantify the speedup of native ARM64 over emulation.

## Native Windows release support

Stable and alpha workflows now build on `windows-11-arm` with the `aarch64-pc-windows-msvc` target. The existing Node and OpenCode preparation paths select ARM64 binaries. PR packaging smoke tests also build and launch ARM64, check native modules, and verify the PE architecture of the packaged app, Node and engine.

Windows feeds are deliberately separate: `latest.yml` for x64, `latest-arm64.yml` for ARM64. NSIS selects the first executable in a manifest rather than filtering by architecture, so merging both into the old feed would break existing x64 clients. The publishing validator rejects mixed feeds. Signing stages and artifact names accept both architectures without collisions.

`sherpa-onnx-node` 1.13.3 has no Windows ARM64 npm addon. The build compiles its N-API adapter against checksum-pinned upstream ARM64 C libraries, using the same source version as the installed JavaScript wrapper. It preserves the upstream license and fails the build if the addon cannot load. Source: [sherpa-onnx v1.13.3](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.3), Apache-2.0. No upstream source is vendored in this PR.

A native installer will become available after this change is merged and a release is built and published. The currently published v0.2.4 has only x64 Windows assets. This PR offers a matching download when available; it does not silently migrate an installed app between architectures.

## Validation

- `pnpm --filter @legalwork/app test`: 865 passed.
- `pnpm --filter @legalwork/app typecheck`: passed.
- `pnpm --filter @legalwork/app test:i18n`: passed, both shipped languages complete.
- `LEGALWORK_ELECTRON_BUILD=1 pnpm --filter @legalwork/app build`: passed.
- `pnpm --filter legalwork-server build`: passed.
- `pnpm --filter @legalwork/desktop test`: 197 passed, one existing platform skip.
- `pnpm --filter @legalwork/desktop typecheck:electron`: passed.
- `pnpm --filter @legalwork/desktop check:electron`: passed, 110 renderer methods covered.
- `node --test scripts/release/*.test.mjs`: three passed, including architecture-separated Windows feeds and rejection before upload when an x64 feed contains an ARM64 installer.
- In the Windows dev app, architecture detection returned the correct mismatch in 11 ms through CDP. The explicit release check reported no ARM64 installer while account settings remained visible.

The native ARM64 packaging job is the authoritative check for the new compiler/toolchain path. Signed release publication is not exercised by a pull request.
