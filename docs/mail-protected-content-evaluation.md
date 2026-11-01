# S/MIME and Microsoft protected-mail evaluation

MAIL-157, 1 November 2026, PR #130. Evaluation of the current schema-37 client and the work needed before cryptographic or Microsoft rights-management compatibility claims. The prototype is an explicit, headless evaluation. It does not add signing, verification, decryption, certificate import or MIP processing to the app.

## Decision

Keep byte-preserving storage/export and ordinary untrusted MIME reading. Do not describe readable signed text as verified mail, an encrypted local database as outbound encryption, or Microsoft Graph mail access as a content license. Use the provider or another authorized mail application for cryptographic verification, decryption and protected composition until the implementation and security gates below pass.

S/MIME and Microsoft Purview/IRM are separate mechanisms. They can share the existing Email UI and Integrations identity, but not an invented common key or authorization rule. A Microsoft sign-in or Mail write grant is neither possession of an S/MIME private key nor permission to extract/reuse MIP-protected content.

## Current capability matrix

“Stored/exported” below means technically possible when the provider supplied the original bytes and current local access permits it. It is not a certificate-trust decision or a Microsoft/firm policy authorization.

| Message form | Reading in the current client | Verification / unavailable keys | Local index | Original export |
| --- | --- | --- | --- | --- |
| Ordinary MIME | Normal sanitized body/attachments | No S/MIME operation | Available headers and decoded supported content | Original EML or manifest-preserving MBOX |
| Detached S/MIME, `multipart/signed` | Clear text is readable; signature is a stored attachment | No signature, chain, address, expiry or revocation verification. No private key is needed merely to read this clear text. | Clear text, including tampered or revoked-signer text, remains searchable as unverified source content | Exact signed original preserved |
| Opaque SignedData, `application/pkcs7-mime` | Outer headers/container only; embedded signed content is not decoded | A public signer certificate and trust evidence would suffice for future verification. This is not inherently recipient-key encryption. | Outer metadata; no embedded body/attachment text | Exact opaque original preserved |
| EnvelopedData, AES-CBC | Outer metadata and encrypted container only | No private-key lookup/decryption. Missing, wrong or locked keys cannot make it readable. | Outer metadata; no hidden plaintext | Exact ciphertext original preserved |
| AuthEnvelopedData, AES-GCM | Same current opaque-container limitation | Authenticated encryption is not by itself a verified sender signature | Outer metadata only | Exact ciphertext original preserved |
| Signed, then encrypted | Outer encrypted envelope only | Requires decryption, then inner signature/trust validation; neither exists in the app | No inner clear text | Exact original preserved |
| Microsoft RPMSG / protected wrapper | An available outer wrapper may be readable. It is not the protected message body. Graph keeps detected protected content incomplete. | No MIP SDK, license processing or policy enforcement. Label headers are untrusted metadata. | Available outer/wrapper text only; no decrypted protected body | Available original/container bytes only; policy compliance is not qualified |
| Provider denies original/body access | Metadata or an explicit incomplete/unavailable state; no fabricated body | Mail permissions and rights policy may differ. Repeated reads cannot create missing rights. | No unavailable body text | Missing original is reported as failed/incomplete, not a complete readable export |

| Outbound operation | Current app | Requirement before claiming support |
| --- | --- | --- |
| Compose ordinary mail | Existing composer/Outbox | Existing account, sender and send permissions |
| S/MIME sign or encrypt | Unavailable; importing `.p7s`, `.p7m` or a certificate attachment does not enable it | Reviewed signer key, recipient certificates, trust/algorithm policy and immutable final MIME |
| Preserve protection on reply/forward | Not automatic. Ordinary reply/forward is not a protected composition mode. | Preserve intended protection, recipients and rights explicitly; no silent plaintext fallback |
| Microsoft protected/labelled compose or re-protect | Unavailable | Native MIP/license/policy integration, appropriate existing-account consent and permitted operations |
| Verify a message with unavailable trust/revocation data | Unavailable | Explicit unknown/incomplete result, not “verified” and not a fabricated invalid-signature result |

The reader currently has no cryptographic trust result in its [metadata contract](../apps/server/src/mail/storage/mime-projection-store.ts). The [MIME projector](../apps/server/src/mail/mime/project.ts) decodes MIME, not CMS. The [Graph engine](../apps/server/src/mail/providers/graph-backfill.ts) marks detected PKCS7/RPMSG parts or inaccessible content as incomplete. Gmail/IMAP/archive byte/projection completeness must not be promoted into a cryptographic readability or policy claim.

## Reproducible prototype and evidence

Run with Node 22+ and OpenSSL 3 available on PATH, or set `LEGALWORK_MAIL_OPENSSL` to its executable path:

```sh
node apps/server/scripts/mail-acceptance.mjs --suite mime/protected-evaluation
node apps/server/scripts/mail-acceptance.mjs --suite providers/graph-backfill --test-name-pattern 'protected|encrypted|protection'
```

The [fixture builder](../apps/server/src/mail/testing/protected-fixture.mjs) creates a temporary synthetic firm root, intermediate CA and RSA-2048 leaf certificates. Leaves have email SANs, key usage and `emailProtection` EKU; a separate `serverAuth` leaf tests unsuitable purpose. It creates SHA-256 CMS signatures, CBC and GCM encrypted envelopes, a signed-then-encrypted message and a password-protected PKCS12 bundle. A separate signer is revoked through a generated CRL. No real firm material, provider account, OS certificate store, Keychain, system-key installation or external license service is used. Temporary files are removed after the suite. This is not a secure-erasure claim.

The eight raw cases are genuine detached signing, a separately revoked signer, deliberate clear-text tampering, opaque signing, CBC encryption, GCM authenticated encryption, signing followed by encryption, and one synthetic Microsoft wrapper. The last is explicitly **not** a valid licensed MIP package. It tests the MIME boundary only. Microsoft license acquisition, real policy behavior and actual RPMSG interoperability remain untested.

Ten explicit evaluation cases pass on macOS arm64, Node 24.11.0 and OpenSSL 3.6.5:

1. Detached and opaque signatures verify through the isolated firm chain and expected signer address; tampering, an absent trust anchor and a mismatched expected address fail reference verification.
2. Expiry, absent revocation evidence, a revoked leaf and unsuitable certificate purpose are distinct failures. The same CRL accepts the non-revoked sender, so revocation failure is not just a broken chain fixture.
3. Replacing the unsigned outer From header does not invalidate an otherwise valid CMS payload. A future reader must bind the claimed sender separately; a signature over the MIME entity does not automatically authenticate every outer header.
4. CBC and authenticated GCM messages decrypt exactly with the recipient key and fail with a wrong/missing key. Decrypting the signed/encrypted message exposes a separately verifiable signature.
5. The PKCS12 reference import requires its password. This is not an app certificate-import or hardware-key implementation.
6. The production projector exposes detached clear text without verifying it, and does not decode opaque/encrypted bodies. Invalid/revoked signatures do not magically disappear from ordinary MIME reading.
7. A wrapper's `MSIP_Labels` header becomes neither a license nor an authenticated label. The opaque RPMSG boundary bytes remain an attachment rather than a decrypted body.
8. Actual encrypted storage, lexical rebuild, EML export and re-import preserve every original hash. Search finds detached clear text, including the revoked signer and the tampered message, but not the hidden CMS payload.
9. The same checks pass through manifest-preserving MBOX export/re-import, without reserializing the signed MIME.
10. A message without original bytes produces an incomplete export with a failed count and no fabricated EML file.

The separate Graph run passes three existing/current boundary cases: inaccessible originals/reference attachments, an encrypted MIME envelope, and an accessible Microsoft wrapper whose protected content stays incomplete. These are synthetic transport responses, not a live Microsoft policy or decryption qualification.

The optional OpenSSL evaluation must be selected explicitly. It is excluded from default/native provider-release certification, avoiding a hidden OpenSSL dependency or a false release-support claim. No evaluation command sends mail or launches a GUI. The normal provider suite retains its existing independent coverage.

## Standards and Microsoft requirements

[RFC 8551](https://www.rfc-editor.org/rfc/rfc8551.html) distinguishes clear detached signatures, opaque signed CMS and encryption. [RFC 8550](https://www.rfc-editor.org/rfc/rfc8550.html) requires certificate processing beyond finding a matching key. [RFC 9787](https://www.rfc-editor.org/rfc/rfc9787.html) adds implementer guidance about cryptographic layers, header interpretation and preserving protection on composition/reply. These are design inputs, not claims that the current projector implements them.

Graph accepts S/MIME in MIME-format messages, but transport acceptance does not implement a local signer, validate a signature or resolve recipient keys. MIME properties are not independently patched through its JSON representation. Keep any future final cryptographic MIME inside the existing immutable Outbox snapshot and uncertain-send journal. [Graph MIME](https://learn.microsoft.com/en-us/graph/outlook-send-mime-message).

Microsoft documents S/MIME, Purview Message Encryption and IRM separately. MIP SDK 1.17 adds EML handling, with behavior depending on the container. RPMSG inspection exposes content streams; it does not return an original reconstructed RPMSG, and generic RemoveProtection is not an RPMSG operation. Thus reconstructing a derivative must not overwrite the protected original or inherit its evidence hash. [Microsoft encryption overview](https://learn.microsoft.com/en-us/purview/email-encryption), [email processing](https://learn.microsoft.com/en-us/information-protection/develop/concept-email).

MIP has its own tenant configuration, rights and supported native distributions. SDK packaging and telemetry consent need review for each supported desktop. Existing Graph tokens must not be reused for a different resource audience; request additional resource access through the same Microsoft Integrations account and its supported authorization layer, without a separate user sign-in system or application-wide permissions by default. [SDK setup](https://learn.microsoft.com/en-us/information-protection/develop/setup-configure-mip).

## Key custody, indexing and rights design

Use native key references or a reviewed firm signing provider. Do not store private keys, PFX passwords or hardware PINs in message metadata, drafts, assistant prompts, logs or ordinary settings. A native Integrations account owns transport identity; certificate selection and key use are separate, explicit capabilities associated with that same sender/account. Bind the certificate SAN and allowed aliases, chain, purpose, policy and key generation before use. Key absence, device lock or hardware-user-presence failure must block the requested cryptographic operation, never downgrade it to ordinary mail.

Validate content integrity separately from trust, email identity, algorithm support, revocation freshness and protected-header scope. A CMS signing-time attribute alone is not a trusted timestamp. Use firm-reviewed trust roots, bounded local parsing and explicit revocation retrieval. Untrusted certificate AIA/CRL URLs must not become unrestricted background network requests. Offline or unavailable revocation data must remain distinguishable from a revoked certificate. No OS/network trust lookup occurred in this prototype.

Future composition must freeze the exact signed/encrypted MIME after recipient and attachment review. Resolve every To/Cc/Bcc recipient without leaking blind-recipient identities through certificate metadata. Draft edits require re-review and new cryptographic bytes; rescheduling alone must not mutate the immutable snapshot. Define certificate expiry/revocation policy for a delayed send and what happens when a hardware signer requires presence. Do not automatically re-sign or send plaintext after a scheduled failure.

Preserve protected originals independently from authorized decrypted derivatives. Derived text/attachments, search, previews, quotations, matter filing, exports and assistant/model disclosure each need their applicable current rights and account/matter grant. A VIEW result or returned body stream does not by itself establish permission to index, extract, export or disclose it to an assistant. Sensitivity-label strings and archive provenance are not authorization. Attach a derivative to its exact original hash, algorithm/trust result, license/policy context and expiry; revoke/purge derived indexes when required while documenting limits for already exported copies.

The current tests prove encrypted technical storage and byte-preserving export of what was supplied. They do not prove Microsoft export rights, a policy-compliant decrypted cache, tamper-proof logging, enterprise certificate enrollment, smart-card behavior, OS key custody, or an offline rights/revocation service.

## Implementation estimate and gates

Planning estimates, not delivery dates or quotes. S/MIME candidate: 12-22 engineer-weeks, plus 2-3 specialist-weeks of independent security review/remediation before compatibility claims.

| Work package | Estimate | Required evidence |
| --- | ---: | --- |
| Typed message/attachment protection state and bounded reader/search semantics | 1-2 weeks | Mixed/nested layers, unsigned additions, malformed CMS and old cached projections never receive a misleading trust result. Shared design-system status controls; no decorative warning panels. |
| Isolated verification, trust, address/purpose/algorithm and revocation processing | 3-5 weeks | Valid, tampered, unknown issuer, wrong address, expired/revoked, missing/stale CRL/OCSP, unsupported algorithms and protected-header cases; resource bounds and no unrestricted network retrieval. |
| Native key references, firm roots and hardware-backed key adapters | 3-6 weeks | macOS/Windows/Linux key access, key lock/removal/rotation, PIN/user-presence cancellation, certificate enrollment and recovery. No private-key export or log leakage. |
| Protected composition, drafts and immutable Outbox integration | 3-5 weeks | Recipients/Bcc, attachments, edit/re-sign review, unavailable signer, scheduled expiry, uncertain dispatch and no plaintext fallback. |
| Cross-client/provider interoperability and rollout | 2-4 weeks | Authorized Gmail/Outlook/IMAP transport, Outlook/Apple Mail/other client samples, EML/MBOX preservation, fuzz/malformed fixtures and reviewed firm certificate policy. |

Microsoft protected-mail processing is a separate 8-14 engineer-week candidate plus 2-4 specialist-weeks of policy/security review, native packaging and remediation. Scope SDK/version/licensing and a consented test tenant first; then build the shared-account auth/native bridge, rights-aware derivatives and source-preserving inspection, platform distribution and explicit revocation/offline tests. Do not infer this effort from a successful CMS test or a Graph Mail permission.

Before claiming native Microsoft protected compatibility, test genuine supported RPMSG/EML/MSG examples with granted, denied, expired and revoked licenses; no-extract/no-export/no-forward restrictions; guests/consumer access where supported; offline license expiry; and attachment inheritance. The synthetic wrapper and Graph denial probes cannot satisfy that gate. An authorized firm test corpus and applicable SDK/service rights are prerequisites, not actions performed by this evaluation.

MAIL-154's core mail security review does not certify these future cryptographic/key/policy changes. Keep S/MIME verification/signing/decryption and Microsoft rights enforcement unavailable until those separate gates pass. MAIL-157 now has the capability matrix, realistic S/MIME prototype and implementation/security estimates. Its genuine Microsoft protected-message/license prototype remains open; the synthetic wrapper cannot close that part of the ticket.
