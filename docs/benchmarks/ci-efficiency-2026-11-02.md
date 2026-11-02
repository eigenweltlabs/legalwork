# CI efficiency benchmark — 2 November 2026

Measured implementation: [`a30fcde9`](https://github.com/eigenweltlabs/legalwork/commit/a30fcde99a647bbc2e7d69978ec6eaf1fcba6796), compared with `6152345ff9e97e1dab3e48a513e1c029eaa6f239`. Subsequent commits on [`codex/ci-execution-efficiency`](https://github.com/eigenweltlabs/legalwork/tree/codex/ci-execution-efficiency) refine workflow selection, cache warming and native fixture ownership/readiness. They do not change application database behavior. One sequential performance pass per case, plus one explicitly labelled failure-driven server-baseline confirmation. No statistical confidence interval is implied.

## Local execution

Apple M4 Pro, 12 logical CPUs, 24 GiB RAM, macOS ARM64; Node 26.0.0, Bun 1.4.4 and Vitest 5.0.5. The same pinned engine binary, generated HTTP worker and frozen dependency graph were prepared for both inputs. Both sign-in fixtures use a 30-second idle timeout to accommodate their unchanged 10.25-second wait. Installation and compilation are outside these execution measurements.

| Suite | Serial baseline | Two workers (CI default) | Four workers | Active tests per passing case |
| --- | ---: | ---: | ---: | ---: |
| app | 69.07s | 20.72s (−70.0%) | 17.52s (−74.6%) | 2,095 |
| server | 192.41s | 113.14s (−41.2%) | 66.91s (−65.2%) | 3,191 |
| engine | 217.59s | 112.42s (−48.3%) | 75.38s (−65.4%) | 105 |

All candidate cases passed. The server cases retain 169 skips for fixtures selected separately or requiring external services; the real-engine cases retain the same eight skips and discover 53 files automatically. No test files were removed.

The original server baseline was 191.16s with 3,190 passes and one five-second timeout in the unmodified native-marker child-process fixture. That fixture passed separately in 503.8ms; the full baseline confirmation passed all 3,191 active tests in 192.41s. The table uses that labelled confirmation. The first-launch native-worker overhead is a possible explanation, not a confirmed root cause. The benchmark helper now probes both prepared Node workers before timing.

| Suite/configuration | Child CPU seconds | Maximum child RSS (MiB) |
| --- | ---: | ---: |
| app-baseline | 8.75 | 931.2 |
| app-candidate-2 | 16.95 | 789.1 |
| app-candidate-4 | 18.27 | 797.0 |
| server-baseline | 116.67 | 2221.2 |
| server-candidate-2 | 168.07 | 1843.0 |
| server-candidate-4 | 172.99 | 1343.4 |
| engine-baseline | 248.28 | 1169.0 |
| engine-candidate-2 | 267.06 | 1346.9 |
| engine-candidate-4 | 290.01 | 1280.0 |
| server-baseline-confirmation | 118.79 | 1873.9 |

Parallel isolation spends more CPU loading independent files while reducing elapsed time. The RSS field is the largest individual child, not aggregate simultaneous process-tree memory. Two workers remain the initial hosted default; four are validated locally and configurable for larger runners.

## Runner experiment

The same four portable files and 37 tests passed under Bun and Vitest; only the test-runner import and equivalent path resolution differ. Bun took **0.065s**, Vitest **1.821s**, including startup. Maximum child RSS was 48.4 MiB and 271.6 MiB respectively. This subset does not support a runner migration for speed; it does not predict either runner’s performance on the full suite. Vitest is not added to the production dependency graph.

## Validation

- Full local app/server correctness, app/server type checking, all 13 selected native package fixture files, and portable renderer/Office build passed.
- Restoring the old ten-second transport deadline makes both accelerated HTTP regression cases fail.
- CI/build/release contracts: 121 passed, 11 Windows-only local skips. The hosted Linux release-tooling check executes all 11 Authenticode scenarios successfully.
- The DOCX filtered install was tested in a fresh checkout: 16 tests in three files passed. UI-MCP syntax and local package creation passed without an installation.
- `actionlint -shellcheck=` and `git diff --check` passed.

## Hosted acceptance

[Run 41440203190](https://github.com/eigenweltlabs/legalwork/actions/runs/41440203190) requested a fresh production engine and all six native package targets without release publication. The fresh twelve-target producer passed, including required signatures and provenance. Compilation took **28m52s**, with a **31m53s** recorded producer job. There is no matched serial hosted sample, so this is an observed duration rather than a measured percentage improvement from two build workers.

All six native engine extraction checks and all six runtime builds with real isolation tests passed. Linux x64, Linux ARM64 and macOS ARM64 native packages passed on the first attempt. macOS Intel passed a failure-driven rerun after its first fixture activation race. Windows x64 and ARM64 failed native fixtures, so the full acceptance run remains red. These outcomes must not be represented as a successful six-platform release.

Windows follow-ups use the original producer's independently pinned manifest (`d78d39da018a7eea0602d52503fe414b03ed83c4d39342be7a2855c7035cbe43`) and verify the current build recipe and every archive. This reuse is development acceptance only; production still requires a fresh signed build. Failures exposed Node/Bun path aliases, cold plugin activation, process-owned file cleanup, and then SQLite/transport errors. The harness now canonicalizes owners in Bun, awaits activation, gives each file an independent process, and uses the fixture engine's existing stdin lease for shutdown. Cleanup errors still fail, and every selected file runs. No assertions or files were removed, no blanket retries were added, and database code was not changed. The final focused run, [41466724450](https://github.com/eigenweltlabs/legalwork/actions/runs/41466724450), **failed on both Windows architectures**. Each passed 12 of 13 selected native fixture files, with no cleanup errors. Both failed `native-saved-approval-migration.released.test.ts` with `SQLITE_IOERR_TRUNCATE` in the database snapshot after service shutdown. Whether the remaining failure is Bun-specific or application behavior is unresolved. Desktop packaging stops at this guard, so the branch is **not ready to merge**. Per-file spans and native job steps are retained in the adjacent JSON. These are failure-driven correctness checks, not additional performance samples.

Exact verified native runtime caches were measured once cold and once warm per Windows architecture in the focused checks. Both samples use `run_tests: false`; native package tests run downstream. Warm hits verify all file hashes, the manifest and the native runtime before use.

| Native runtime preparation | Cold | Verified warm | Reduction |
| --- | ---: | ---: | ---: |
| Windows x64 | 201s | 45s | 77.6% |
| Windows ARM64 | 366s | 85s | 76.8% |

The shared trusted `dev` cache still needs its first warmer run after these changes land. Branch-scoped cache hits above do not prove that default-branch cache is already populated.

The full compressed engine artifact was **1,294.8 MiB**. Per-consumer artifacts were **303.9 MiB** for macOS, **334.2 MiB** for Windows and **656.7 MiB** for Linux; the shared renderer/Office artifact was **46.9 MiB**. Native consumers retain full manifest verification while transferring only their OS family. The portable producer ran for **3m04s**, replacing duplicate renderer/Office work in six native consumers.

Hosted runner availability remains material: the first run's Intel package job waited **22m28s before its first recorded step**, and the ARM Mac package job waited **21m27s**. These gaps include queue/initialization and are not timed compilation. Windows ARM64 also spent **5m33s** materializing a completely reused pnpm store, despite zero downloaded packages. The final focused ARM64 run spent **11m33s** in dependency setup: **3m42s** restoring the exact 531 MiB store cache and **7m47s** running pnpm, again with zero downloaded packages; x64 dependency setup was **1m15s**. These remain follow-up opportunities; faster local tests do not imply an equivalent end-to-end deployment speedup.

Full application notarization and release publication were not run. Their upload/processing/stapling spans are instrumented for the next actual release. There is no measured before/after production deployment total in this experiment.

See [CI and execution efficiency](../ci-efficiency.md) for the changes and reproduction command. Raw local test logs and measurements are in `output/legalwork-ci-efficiency-benchmark-2026-11-02/` in the workspace; numerical results and preparation digests are retained alongside this report.
