# Mail commits and Linear traceability

Branch: `feat/local-mail-client`. Project: [Email In LegalWork](https://linear.app/eigenweltlabs/project/email-in-legalwork-d1634afe1032/overview).

Every mail commit must include its relevant `EIG-...` ticket ID in the subject and a Linear issue link in the body. Keep changes scoped to a ticket where practical; name both tickets when a shared foundation or integration genuinely spans them. Code delivery does not close a ticket until its acceptance criteria have passed review and verification.

On 9 September 2026 the 39 existing, unpushed mail commits were relabeled. All commit trees, authors and timestamps were preserved; the final code tree is identical. Inherited upstream commits were not relabeled. The original history is preserved in local ref `refs/backups/legalwork-mail-before-linear-titles-20260909`. The branch is now published in [draft PR #130](https://github.com/eigenweltlabs/legalwork/pull/130). It was subsequently rebased onto dev at `336270d65`, preserving all 87 mail commit subjects and the final file tree. The current column below uses the rebased IDs; the former dev merge is part of the new base. The pre-rebase history is preserved locally at `refs/backups/legalwork-mail-before-dev-rebase-20260909`.

| Linear tickets | Current commit | Previous commit | Change |
| --- | --- | --- | --- |
| [EIG-122](https://linear.app/eigenweltlabs/issue/EIG-122) | `71e569b1e` | `27d39f758` | docs(mail): evaluate engine and prove synthetic replica checkpoints |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `ff1103592` | `0c3da5356` | feat(mail): validate provider setup and document OAuth readiness |
| [EIG-121](https://linear.app/eigenweltlabs/issue/EIG-121) | `506f26c29` | `6fb2322b2` | test(mail): add deterministic MIME corpus and checkpoint fault harness |
| [EIG-122](https://linear.app/eigenweltlabs/issue/EIG-122) | `b6be90e9a` | `e3735f94e` | fix(mail): reject invalid spike continuations before checkpoint commit |
| [EIG-122](https://linear.app/eigenweltlabs/issue/EIG-122), [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `1bfc925bb` | `d23af9628` | docs(mail): validate encrypted SQLite bindings across local runtimes |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `e54527a6f` | `1ea8c4543` | docs(mail): prepare isolated provider registration workflow |
| [EIG-119](https://linear.app/eigenweltlabs/issue/EIG-119) | `3e948e26a` | `16e129a6e` | feat(mail): define identity and durable completeness contract |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `27d85cd4c` | `649f552b6` | fix(mail): create Azure registration through supported Graph endpoint |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `c12bc7e6e` | `ab77ddca8` | build(mail): pin encrypted SQLite native dependency |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `1e11cf83e` | `09110db3d` | feat(mail): add fail-closed encrypted database adapter |
| [EIG-124](https://linear.app/eigenweltlabs/issue/EIG-124) | `b94ddfb01` | `294005e1e` | feat(mail): add versioned owned mailbox schema and repository |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `832efb140` | `20e3464bc` | feat(mail): supervise private Node worker transport |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `e113ebe8c` | `f272e7c2f` | test(mail): cover key publication and activation races |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `19202e739` | `be3146a75` | feat(mail): run owner-scoped encrypted storage worker |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `538c34aaf` | `9f26892c6` | feat(mail): wrap local database key with OS credential storage |
| [EIG-125](https://linear.app/eigenweltlabs/issue/EIG-125) | `d26045a63` | `5f9762b36` | feat(mail): stream verified content into encrypted SQLite chunks |
| [EIG-125](https://linear.app/eigenweltlabs/issue/EIG-125) | `e24e19331` | `5855bd039` | fix(mail): require published bytes for content completeness |
| [EIG-124](https://linear.app/eigenweltlabs/issue/EIG-124) | `139e3c9c5` | `b3b43e08d` | feat(mail): add bounded consistency diagnostics and recovery guidance |
| [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | `9d099fe33` | `b8aeb1009` | test(mail): verify encrypted worker from packaged ASAR |
| [EIG-124](https://linear.app/eigenweltlabs/issue/EIG-124), [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | `e1bc56054` | `d82a3cff8` | feat(mail): add fast startup schema guard |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `8ee377fe2` | `4f294a9f0` | feat(mail): bind encrypted worker to local desktop host API |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `e61b0d0b4` | `bfea52604` | docs(mail): record verified provider setup progress |
| [EIG-127](https://linear.app/eigenweltlabs/issue/EIG-127) | `1f1238868` | `3fd61c11c` | feat(mail): journal sync pages and fenced download jobs |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `efb6be2a8` | `e6a1ea456` | feat(mail): add private PKCE OAuth transport foundation |
| [EIG-127](https://linear.app/eigenweltlabs/issue/EIG-127) | `0da673673` | `dd63e0792` | test(mail): align consistency guard and legacy fixtures with schema v3 |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `469eb67ed` | `c658681d6` | feat(mail): add bounded OAuth refresh transport and rotation contract |
| [EIG-127](https://linear.app/eigenweltlabs/issue/EIG-127) | `2e0cdd72b` | `7fcfbc482` | feat(mail): atomically enqueue fenced raw-message followups |
| [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | base `336270d65` | `cdc0f9678` | Merge current dev packaging fixes into mail integration |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `e56a3dfd5` | `b4f9b280a` | feat(mail): discover stable provider identity and verify pilot tenant |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120), [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | `7a9148c6e` | `25749b054` | docs(mail): record Google client setup and reviewed packaging state |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `a0e329839` | `208b8edca` | feat(mail): persist bound account credentials with rotation CAS |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123), [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `78bd6da58` | `57726306c` | feat(mail): connect verified accounts through encrypted credential controller |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `e89b8168a` | `2f40194b3` | feat(mail): fence reconnects before disconnect cleanup |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `059f2aa2f` | `4fb59facd` | feat(mail): load private development provider registrations safely |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `f77bcef34` | `24ce2eccd` | fix(mail): fence concurrent reconnects on every disconnect |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `892479d3f` | `d30cd4b6b` | feat(mail): integrate private connection worker lifecycle |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `5b0d2cab5` | `7b964d947` | Reject non-string connection states in worker responses |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `bf61f98d9` | `bc5a4bd3b` | test(mail): fence pending provider results on worker shutdown |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `1b0dfdf02` | `a8b13d475` | feat(mail): expose reviewed connection lifecycle through local host API |


Later commits retain their ticket IDs in `git log`; this table records the initial history migration. The table itself is maintained under EIG-123.
