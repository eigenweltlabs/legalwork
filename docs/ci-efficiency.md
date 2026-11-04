# CI and execution efficiency

## Pipeline changes

- Unit tests and real-engine integration run independently after their own prerequisites. The existing two required `legalwork-tests` names aggregate all selected checks, including failures and cancellations. These metadata gates use Linux runners so they do not wait for a second Mac slot after native testing finishes. Presentation-only changes skip engine jobs entirely instead of scheduling an empty Mac integration job.
- PR jobs prepare one guest image per CPU architecture. Four native-only consumers prepare and validate their own runtime after their guest architecture. Linux engine runtime preparation overlaps compilation, then the engine job downloads and validates that exact same-run archive. The Mac engine prepares its runtime in its existing job, avoiding an additional ARM Mac runner allocation. Mac/Linux engine jobs retain protected-engine assertions and reuse their server build. Linux x64 integration uses Ubuntu 24.04, matching the native producer and warmer rather than following the moving `ubuntu-latest` image. Manual package diagnostics retain the shared producer/archive path. Both required check names and the final result await both guests and all six native validations.
- PR Electron renderer assets build once on Linux. Mac unit jobs verify the exact source, version, build settings and file hashes before running the actual Electron assertions. Runtime-only validation installs the server dependency closure with native lifecycle scripts enabled; worker preparation and help generation resolve their declared dependencies from that closure.
- A failed Windows MSYS2 bootstrap gets one fresh-install retry, including the full system upgrade. Checksum-pinned QEMU packages and signature checks still run afterward; test failures are not retried.
- Guest and native QEMU bundles use exact source, host-image, Node version and architecture cache keys. Native build commands live in a separately hashed build action so scheduling or validation edits do not invalidate compiled QEMU bytes. Hits verify all file hashes and the runtime manifest, then still execute the selected isolation tests. The dedicated `dev` warmer builds without installing the application workspace. It runs nightly as well as on source changes, so host-image/toolchain key changes are warmed before daytime CI; it skips native artifact publication and keeps same-run guest artifacts for one day. The trusted `dev` warmer seeds the shared default-branch cache; branch and PR saves remain isolated by [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).
- A single alpha workflow produces one fresh, signed production engine for macOS and both Windows architectures. The [concurrency group](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) retains one active alpha and the newest pending alpha. The Windows-only manual diagnostic remains available.
- Release and alpha renderer and Office assets build once on Linux in parallel with the native runtime and engine producers. CI package acceptance also shares one portable build across its native matrix. Native jobs verify the source commit, version, Vite environment and every portable output before building their server and platform resources. Signing, native-module tests and packaged-startup tests remain platform-specific.
- Full-workspace pnpm store keys are shared by OS, architecture and lockfile across workflows. Filtered installs have a separate job-owned store and cache namespace including the filter, lifecycle mode, Node ABI, OS, architecture and lockfile; they save that filtered closure immediately after installation and cannot restore or populate the full-workspace/legacy Electron cache. The install action can disable store reuse for a fresh-install comparison. PR Windows ARM64 validation uses a fresh isolated store because hosted cache restoration plus installation was slower than a fresh install; other filtered consumers retain their scoped caches. UI-MCP syntax/packing checks need no installation; DOCX checks install only the app dependency graph. Filtered installs cannot seed an incomplete full-workspace cache. Complete-store saves happen immediately after installation within the run’s cache scope. Native engine consumers download an OS family rather than twelve archives; the full distribution remains available for universal publication.
- Fresh engine compilation uses two independent staging workers. Failures stop new work and wait for in-flight builds. Production provenance, twelve-target coverage and required signatures remain enforced.
- Test, engine-target, desktop build, notarization-archive, notary submission and stapling spans are retained with workflow artifacts. Notary submission includes Apple's upload and processing time; it is not an upload-only measurement.
- Linux release tarballs use gzip level 6 rather than electron-builder's default level 9. A manual nonpublishing alpha benchmark builds each Linux app once, then measures both archive levels on those exact bytes, verifying every file hash, link and mode and reporting the size difference. AppImage configuration is unchanged.
- Manual alpha `signing_test` runs can compare `serial-full-ui` (one engine worker and per-platform frontend builds) with `optimized` (two engine workers and verified shared frontend assets) on one commit and an identical `benchmark_version`. These controls require publishing to be disabled. The serial control still uses the improved source staging and one shared producer, so it measures those selected execution/scheduling differences rather than reproducing the entire historical pair of alpha workflows. Optional `linux_benchmark` adds x64 and ARM64 archive comparisons. Windows ARM alpha jobs use a fresh full-workspace dependency store after the paired hosted sample measured5m19s versus6m25s with store restoration; the serial control retains cache reuse. Other full-workspace consumers keep their caches. Failed startup checks retain redacted diagnostics without changing their assertions or deadlines.

## Execution changes

The app, server and automatically discovered real-engine suites use [Bun 1.4.4 file workers](https://bun.com/docs/test/parallel). CI uses two workers for ordinary units and Mac engine files, and four for the automatically discovered Linux engine suite; native VM files remain serial. Each file retains its own globals, environment, profile and module mocks; tests within a file remain serial. Set `LEGALWORK_TEST_WORKERS=1`, `2` or `4` for comparison. No additional job or shard startup is needed. Local runs need Bun 1.4.4; `LEGALWORK_TEST_BUN_BIN` can select that executable when the shell has an older Bun. Documentation generation is checked once by the coordinator; direct Bun invocations retain the preload check.

Portable sandbox policy, path, approval and sizing tests run in the ordinary server suite. The six native targets run the explicit file list in `scripts/ci/sandbox-test-files.mjs`: VM execution and networking, the sandboxed Python calculation, and actual shell, Node transport, filesystem and link boundaries. Native files run serially against the packaged runtime and are excluded from automatic unit discovery; an explicit file argument still allows a targeted local run. Selection contracts check that every VM-gated fixture has an execution lane and exercise Bun's discovery exclusions with a failing negative control. The split retains the existing test assertions.

The released-engine startup/auth/shutdown smoke test and protected VM engine test each run in their dedicated workflow step, outside automatic engine discovery. Workflow resource integration runs in the full engine suite, with a conditional standalone step for runtime changes that do not select that suite. It is no longer invoked twice in the same job.

Linux unit runners reserve the three registered OAuth callback ports from ephemeral allocation, preserving existing reservations. Other test sockets can still use random ports without taking a callback port needed by the sign-in exhaustion checks. Managed-engine startup failures await child `close`, which follows stdio closure, so final stderr diagnostics remain available even when process exit arrives first; a held-pipe regression exercises that ordering.

Three deliberate wall-clock waits now use controlled clocks: todo-panel garbage collection and two native HTTP timeout cases. HTTP requests and responses still use actual sockets, and a negative control restoring the former ten-second timeout must fail. The sign-in regression keeps its real 10.25-second wait because that flow combines transport, query retries and timers; the fixture's idle timeout is 30 seconds in both benchmark inputs.

The recovery fixture activates its independent project contexts concurrently, and records boot, setup and teardown durations. Its readiness regression holds plugin activation until the native API reports pending, releases that barrier, then awaits readiness; it does not depend on a fixed startup sleep. It keeps separate fixture engines, databases and profiles across lifecycle cases. No cross-test engine sharing or global mock-disabling is introduced. Each native package test file runs in its own Bun process. Its temporary roots belong to a parent coordinator, which deletes them only after that process exits. Prerequisites are prepared once, and native fixtures run before heavier desktop preparation. This matches process-owned database/file-handle lifetimes on Windows; cleanup errors still fail the job, with no retries or ignored assertions. Plugin activation is awaited explicitly, and the direct temporary configuration fixture uses the engine's existing stdin lease for orderly shutdown. The coordinator records every file's outcome and continues after a failed file or cleanup so later assertions still execute.

Vitest 5.0.5 is compared with Bun on four portable files using identical assertion bodies (only the test-runner import changes). It is a diagnostic experiment, not an added production dependency or evidence about migrating the entire suite. The suite's Bun-specific servers, mocks and engine fixtures would require separate migration work.

## One-pass benchmark

Use separate checkouts of the baseline and candidate, install the frozen pnpm graph in each, generate docs, build the server and prepare the pinned Node worker before measuring. Both inputs must use Bun 1.4.4 and the same host. Apply the common sign-in fixture idle-timeout correction to the baseline. The engine binary must be independently verified and identical for both inputs.

```sh
LEGALWORK_BENCHMARK_ENGINE=/absolute/path/to/verified/opencode \
LEGALWORK_BENCHMARK_ENGINE_CACHE=/absolute/path/to/isolated/cache \
node scripts/ci/benchmark-efficiency.mjs \
  --baseline /absolute/path/to/baseline \
  --bun /absolute/path/to/bun-1.4.4 \
  --vitest-bin /absolute/path/to/vitest-5.0.5 \
  --output /absolute/path/to/results
```

Each baseline, two-worker and four-worker case runs once, sequentially. Results include wall time, child CPU, maximum child RSS, exit status and test counts. The RSS value is the largest individual child, not simultaneous process-tree memory. Dependency installation and engine compilation are excluded from these local execution measurements. A separate hosted workflow run validates the actual cross-platform orchestration and packaging; historical scheduling replays are estimates, not measured deployment speedups.

The coordinator probes both pinned Node binaries before measurement. Both inputs therefore launch their prepared native worker before a timed child-process fixture. Preserve failed samples and label any failure-driven confirmation separately.


### Nonpublishing deployment measurements (2026-11-04)

Same source3088e395 and fixed version0.3.7-alpha.0.g3088e39, one paired sample:

| Stage | Control | Optimized |
| --- | ---: | ---: |
| Fresh signed twelve-target engine compile | 31m59s | 27m31s |
| Mac Electron build | 11m21s | 2m29s |
| Windows x64 Electron build | 3m45s | 2m12s |
| Windows ARM Electron build | 8m54s | 5m49s |
| Windows ARM full dependency setup | 6m25s | 5m19s |
| Linux x64 release tarball | 17m24s | 2m45s |
| Linux ARM release tarball | 14m11s | 1m55s |

Linux level6 archives were0.82%/0.87% larger (x64/ARM), with identical verified file hashes, links and modes. Real packaged startup and AppImage checks passed on both architectures. Mac signed/notarized packaging took12m34s→13m18s; Windows x64 packaging took5m37s→7m53s, so these samples do not establish a packaging speedup for those stages. All native startup/signature checks passed.

Control41850196784 and optimized41859349170 retain their failed first attempts: PR-branch Windows signing was initially blocked and optimized Mac runtime allocation was abandoned. The user approved an exact temporary branch rule; attempt2 completed the previously blocked/provisioning jobs using original same-run production artifacts. That rule was removed afterward. Never describe those incremental attempts as fresh full-alpha wall times.

Manual `transport_diagnostic` runs only the Intel transport comparison, with identical17MiB payload assertions and30s deadlines under Bun and the shipped Node runtime; it also compares the original Bun file with the full native file collection. PR and push events cannot select this mode. Required gates still fail on a diagnostic failure. This mode changes neither production transport behavior nor normal test assertions.
