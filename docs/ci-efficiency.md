# CI and execution efficiency

## Pipeline changes

- Unit tests and real-engine integration run independently after their own prerequisites. The existing two required `legalwork-tests` names aggregate all selected checks, including failures and cancellations. These metadata gates use Linux runners so they do not wait for a second Mac slot after native testing finishes.
- Guest and native QEMU bundles use exact source, host-image and architecture cache keys. Hits verify all file hashes and the runtime manifest, then still execute the selected isolation tests. The dedicated `dev` warmer builds without installing the application workspace. The trusted `dev` warmer seeds the shared default-branch cache; branch and PR saves remain isolated by [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).
- A single alpha workflow produces one fresh, signed production engine for macOS and both Windows architectures. The [concurrency group](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) retains one active alpha and the newest pending alpha. The Windows-only manual diagnostic remains available.
- Release and alpha renderer and Office assets build once on Linux in parallel with the native runtime and engine producers. CI package acceptance also shares one portable build across its native matrix. Native jobs verify the source commit, version, Vite environment and every portable output before building their server and platform resources. Signing, native-module tests and packaged-startup tests remain platform-specific.
- pnpm store keys are shared by OS, architecture and lockfile across workflows. UI-MCP syntax/packing checks need no installation; DOCX checks install only the app dependency graph. Filtered installs cannot seed an incomplete shared cache. Complete-store saves happen immediately after installation within the run’s cache scope. Native engine consumers download an OS family rather than twelve archives; the full distribution remains available for universal publication.
- Fresh engine compilation uses two independent staging workers. Failures stop new work and wait for in-flight builds. Production provenance, twelve-target coverage and required signatures remain enforced.
- Test, engine-target, desktop build, notarization-archive, notary submission and stapling spans are retained with workflow artifacts. Notary submission includes Apple's upload and processing time; it is not an upload-only measurement.

## Execution changes

The app, server and automatically discovered real-engine suites use [Bun 1.4.4 file workers](https://bun.com/docs/test/parallel), with two workers in CI. Each file retains its own globals, environment, profile and module mocks; tests within a file remain serial. Set `LEGALWORK_TEST_WORKERS=1`, `2` or `4` for comparison. No additional job or shard startup is needed. Documentation generation is checked once by the coordinator; direct Bun invocations retain the preload check.

Three deliberate wall-clock waits now use controlled clocks: todo-panel garbage collection and two native HTTP timeout cases. HTTP requests and responses still use actual sockets, and a negative control restoring the former ten-second timeout must fail. The sign-in regression keeps its real 10.25-second wait because that flow combines transport, query retries and timers; the fixture's idle timeout is 30 seconds in both benchmark inputs.

The recovery fixture activates its independent project contexts concurrently, and records boot, setup and teardown durations. It keeps separate fixture engines, databases and profiles across lifecycle cases. No cross-test engine sharing or global mock-disabling is introduced. Native package fixtures give their temporary roots to a parent coordinator, which deletes them only after the Bun test process exits. This matches process-owned database/file-handle lifetimes on Windows; cleanup errors still fail the job, with no retries or ignored assertions.

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
