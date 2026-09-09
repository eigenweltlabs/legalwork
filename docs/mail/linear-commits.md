# Mail commits and Linear traceability

Branch: `feat/local-mail-client`. Project: [Email In LegalWork](https://linear.app/eigenweltlabs/project/email-in-legalwork-d1634afe1032/overview).

Every mail commit must include its relevant `EIG-...` ticket ID in the subject and a Linear issue link in the body. Keep changes scoped to a ticket where practical; name both tickets when a shared foundation or integration genuinely spans them. Code delivery does not close a ticket until its acceptance criteria have passed review and verification.

On 9 September 2026 the 39 existing, unpushed mail commits were relabeled. All commit trees, authors and timestamps were preserved; the final code tree is identical. Inherited upstream commits were not relabeled. The original history is preserved in local ref `refs/backups/legalwork-mail-before-linear-titles-20260909`. Hashes recorded before this change are superseded by the mapping below. These commits are local until the branch is pushed.

| Linear tickets | Current commit | Previous commit | Change |
| --- | --- | --- | --- |
| [EIG-122](https://linear.app/eigenweltlabs/issue/EIG-122) | `3d8b2f7fd` | `27d39f758` | docs(mail): evaluate engine and prove synthetic replica checkpoints |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `a432cf22e` | `0c3da5356` | feat(mail): validate provider setup and document OAuth readiness |
| [EIG-121](https://linear.app/eigenweltlabs/issue/EIG-121) | `e3af82c51` | `6fb2322b2` | test(mail): add deterministic MIME corpus and checkpoint fault harness |
| [EIG-122](https://linear.app/eigenweltlabs/issue/EIG-122) | `29dd93ccb` | `e3735f94e` | fix(mail): reject invalid spike continuations before checkpoint commit |
| [EIG-122](https://linear.app/eigenweltlabs/issue/EIG-122), [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `65561ed82` | `d23af9628` | docs(mail): validate encrypted SQLite bindings across local runtimes |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `40c8b06f0` | `1ea8c4543` | docs(mail): prepare isolated provider registration workflow |
| [EIG-119](https://linear.app/eigenweltlabs/issue/EIG-119) | `23fc0605b` | `16e129a6e` | feat(mail): define identity and durable completeness contract |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `63b412026` | `649f552b6` | fix(mail): create Azure registration through supported Graph endpoint |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `b91321a93` | `ab77ddca8` | build(mail): pin encrypted SQLite native dependency |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `61d159ca6` | `09110db3d` | feat(mail): add fail-closed encrypted database adapter |
| [EIG-124](https://linear.app/eigenweltlabs/issue/EIG-124) | `cbd98800f` | `294005e1e` | feat(mail): add versioned owned mailbox schema and repository |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `ff6c72159` | `20e3464bc` | feat(mail): supervise private Node worker transport |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `fd7bb7c8c` | `f272e7c2f` | test(mail): cover key publication and activation races |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `b2ac0b946` | `be3146a75` | feat(mail): run owner-scoped encrypted storage worker |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `d51e6d85d` | `9f26892c6` | feat(mail): wrap local database key with OS credential storage |
| [EIG-125](https://linear.app/eigenweltlabs/issue/EIG-125) | `9e2b20548` | `5f9762b36` | feat(mail): stream verified content into encrypted SQLite chunks |
| [EIG-125](https://linear.app/eigenweltlabs/issue/EIG-125) | `1f307c9e8` | `5855bd039` | fix(mail): require published bytes for content completeness |
| [EIG-124](https://linear.app/eigenweltlabs/issue/EIG-124) | `477187bde` | `b3b43e08d` | feat(mail): add bounded consistency diagnostics and recovery guidance |
| [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | `d15eac9e7` | `b8aeb1009` | test(mail): verify encrypted worker from packaged ASAR |
| [EIG-124](https://linear.app/eigenweltlabs/issue/EIG-124), [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | `fb669319f` | `d82a3cff8` | feat(mail): add fast startup schema guard |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `faa7f4963` | `4f294a9f0` | feat(mail): bind encrypted worker to local desktop host API |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `efb187d12` | `bfea52604` | docs(mail): record verified provider setup progress |
| [EIG-127](https://linear.app/eigenweltlabs/issue/EIG-127) | `74f31127d` | `3fd61c11c` | feat(mail): journal sync pages and fenced download jobs |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `315a9f7dc` | `e6a1ea456` | feat(mail): add private PKCE OAuth transport foundation |
| [EIG-127](https://linear.app/eigenweltlabs/issue/EIG-127) | `45eefb1e1` | `dd63e0792` | test(mail): align consistency guard and legacy fixtures with schema v3 |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `9358f7140` | `c658681d6` | feat(mail): add bounded OAuth refresh transport and rotation contract |
| [EIG-127](https://linear.app/eigenweltlabs/issue/EIG-127) | `5733a86f3` | `7fcfbc482` | feat(mail): atomically enqueue fenced raw-message followups |
| [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | `ff59beac9` | `cdc0f9678` | Merge current dev packaging fixes into mail integration |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `6474cbff2` | `b4f9b280a` | feat(mail): discover stable provider identity and verify pilot tenant |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120), [EIG-152](https://linear.app/eigenweltlabs/issue/EIG-152) | `60da30621` | `25749b054` | docs(mail): record Google client setup and reviewed packaging state |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `348a89afe` | `208b8edca` | feat(mail): persist bound account credentials with rotation CAS |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123), [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `7a896ea08` | `57726306c` | feat(mail): connect verified accounts through encrypted credential controller |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `c053ca8e5` | `2f40194b3` | feat(mail): fence reconnects before disconnect cleanup |
| [EIG-120](https://linear.app/eigenweltlabs/issue/EIG-120) | `981be56c6` | `4fb59facd` | feat(mail): load private development provider registrations safely |
| [EIG-126](https://linear.app/eigenweltlabs/issue/EIG-126) | `97a50eeec` | `24ce2eccd` | fix(mail): fence concurrent reconnects on every disconnect |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `613a53e37` | `d30cd4b6b` | feat(mail): integrate private connection worker lifecycle |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `bc900aac0` | `7b964d947` | Reject non-string connection states in worker responses |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `8d8db3f3f` | `bc5a4bd3b` | test(mail): fence pending provider results on worker shutdown |
| [EIG-123](https://linear.app/eigenweltlabs/issue/EIG-123) | `36e27652f` | `a8b13d475` | feat(mail): expose reviewed connection lifecycle through local host API |


Later commits retain their ticket IDs in `git log`; this table records the initial history migration. The table itself is maintained under EIG-123.
