# OpenCode v2 historical evidence

Current behavior and verification live in the [migration architecture](opencode-v2-migration.md),
[acceptance status](opencode-v2-capability-status.md), and [rollback instructions](opencode-v2-migration.md).
The records below are immutable historical evidence, not acceptance of the current source.

## Archived checkpoints

- [opencode-v2-morning-review.md](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/opencode-v2-morning-review.md)
- [opencode-v2-regression-readiness.md](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/opencode-v2-regression-readiness.md)
- [opencode-v2-acceptance-plan.md](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/opencode-v2-acceptance-plan.md)
- [opencode-v2-isolated-vm-plan.md](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/opencode-v2-isolated-vm-plan.md)

## Superseded engine candidates

The build uses `2.1.4-legalwork.http-policy.3`. Keep its [combined patch](patches/opencode-2.1.4-mcp-http-policy-v3.patch),
[receipt](patches/opencode-2.1.4-mcp-http-policy-v3.receipt.json), and pinned recipe inputs in the source tree.
Historical paths recorded inside that unchanged receipt resolve at the archive revision below:

- [opencode-2.1.4-mcp-http-policy.patch](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/patches/opencode-2.1.4-mcp-http-policy.patch)
- [opencode-2.1.4-mcp-http-policy.receipt.json](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/patches/opencode-2.1.4-mcp-http-policy.receipt.json)
- [opencode-2.1.4-mcp-tool-readiness.patch](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/patches/opencode-2.1.4-mcp-tool-readiness.patch)
- [opencode-2.1.4-mcp-tool-readiness.receipt.json](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/docs/patches/opencode-2.1.4-mcp-tool-readiness.receipt.json)
- [packages/opencode-release/derivative-release.json](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/packages/opencode-release/derivative-release.json)
- [scripts/benchmarks/packaged-candidate.mjs](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/scripts/benchmarks/packaged-candidate.mjs)
- [scripts/benchmarks/packaged-candidate.test.mjs](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/scripts/benchmarks/packaged-candidate.test.mjs)
- [packages/opencode-release/build/README.md](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/packages/opencode-release/build/README.md)

## Benchmark tooling

The standalone Electron benchmark harness is maintained on [`codex/v2-benchmark-tooling`](https://github.com/eigenweltlabs/legalwork/tree/codex/v2-benchmark-tooling/scripts/benchmarks).
Its provider integration test and paid-run accounting safeguards move with it. The application’s built-in benchmark feature remains in this migration.
The [original harness](https://github.com/eigenweltlabs/legalwork/tree/23db1a2f142972297e023c6e598f62915f14ed76/scripts/benchmarks) and [budget records](https://github.com/eigenweltlabs/legalwork/blob/23db1a2f142972297e023c6e598f62915f14ed76/scripts/benchmarks/budget.md) remain available at the pre-cleanup revision.
