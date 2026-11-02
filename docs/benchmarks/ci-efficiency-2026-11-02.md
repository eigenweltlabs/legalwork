# CI efficiency benchmark — 2 November 2026

Implementation: [`a30fcde9`](https://github.com/eigenweltlabs/legalwork/commit/a30fcde99a647bbc2e7d69978ec6eaf1fcba6796), compared with `6152345ff9e97e1dab3e48a513e1c029eaa6f239`. One sequential pass per case, plus one explicitly labelled failure-driven server-baseline confirmation. No statistical confidence interval is implied.

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

- Full local app/server correctness, app type checking, native recovery lifecycle tests, and portable renderer/Office build passed.
- Restoring the old ten-second transport deadline makes both accelerated HTTP regression cases fail.
- CI/build/release contracts: 118 passed, 11 Windows-only local skips. The hosted Linux release-tooling check executes all 11 Authenticode scenarios successfully.
- The DOCX filtered install was tested in a fresh checkout: 16 tests in three files passed. UI-MCP syntax and local package creation passed without an installation.
- `actionlint -shellcheck=` and `git diff --check` passed.

## Hosted acceptance

[Run 41440203190](https://github.com/eigenweltlabs/legalwork/actions/runs/41440203190) uses fresh production signing and all six native package targets without release publication. The first run exposed Windows fixture cleanup failures (`EBUSY`) after engines had stopped. The affected assertions pass; process-owned database/file handles prevent in-process directory deletion. The native package coordinator now removes its two private fixture roots after the complete test child exits, and cleanup errors remain failures. The four affected native tests pass locally with the parent owner. A focused Windows acceptance run validates this repair using the same independently pinned engine distribution; it is failure-driven validation rather than a second performance sample. Hosted outcomes and spans are recorded here when complete. A cold first run does not measure a shared runtime-cache hit; the trusted `dev` warmer must populate that cache after these changes land. Full application notarization is not part of this non-publishing acceptance run.

See [CI and execution efficiency](../ci-efficiency.md) for the changes and reproduction command. Raw local test logs and measurements are in `output/legalwork-ci-efficiency-benchmark-2026-11-02/` in the workspace; numerical results and preparation digests are retained alongside this report.
