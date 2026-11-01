# Proton Mail Bridge qualification

MAIL-136 checkpoint, 1 November 2026. **Proton Mail Bridge is unqualified and unsupported for this LegalWork release.** No direct Proton API integration is implemented. This records prerequisite and transport evidence; live Bridge acceptance remains open.

## Prerequisites and current gap

Proton requires a paid Mail plan and an installed, configured Bridge application for IMAP/SMTP desktop access. It describes the client connection as local loopback traffic and uses a generated self-signed certificate. Bridge offers STARTTLS/SSL connection modes and certificate export. [Plan and desktop access](https://proton.me/support/imap-smtp-and-pop3-setup), [local connection security](https://proton.me/support/bridge-ssl-connection-issue), [Bridge settings](https://proton.me/support/comprehensive-guide-to-bridge-settings).

LegalWork's current IMAP adapter uses direct TLS, certificate verification and TLS 1.2 or newer. It has no IMAP STARTTLS mode. SMTP supports direct TLS or mandatory STARTTLS, also with certificate verification. The settings schemas do not accept an arbitrary trust override or certificate-verification bypass. There is no reviewed Bridge-specific certificate import/pinning workflow. A paid plan, a local port, successful generic IMAP tests or a connection-mode change alone cannot establish supported Bridge operation.

The normal macOS application folders checked for this checkpoint contain no Proton-named app bundle. No Bridge account/settings, approved paid test account or controlled send recipient was supplied. No app was installed/launched, local Bridge credentials read, trust store altered or provider login attempted. Installation elsewhere is not ruled out by this bounded check.

If Bridge is subsequently qualified, keep its local IMAP/SMTP connection inside the existing **Integrations > Communication** service. The paid Proton account and Bridge's own authentication remain Bridge prerequisites; LegalWork should consume the approved local connection rather than add a competing Proton authentication system.

## Reproducible boundary evidence

These commands use synthetic loopback servers and temporary encrypted stores. They never contact Proton or send real mail:

```sh
node apps/server/scripts/mail-acceptance.mjs --suite providers/imap-backfill --test-name-pattern 'certificate|offline'
node apps/server/scripts/mail-acceptance.mjs --suite providers/smtp-submit
```

| Check | Result | Scope |
| --- | --- | --- |
| Untrusted loopback IMAP certificate; failed account creation | PASS | Existing actual-TLS fixture rejects the certificate with a fixed error; failed authentication creates no active account. |
| TLS IMAP backfill and offline attachment reading through the real worker | PASS | Downloaded generic IMAP bytes remain available locally. This is not a Bridge outage/restart test. |
| SMTP direct TLS and required STARTTLS with a trusted fixture certificate | PASS | Test-only CA injection verifies the positive transport path. Production has no corresponding Bridge trust-import UI. |
| SMTP without advertised required STARTTLS | PASS | No authentication and no message accepted by the fixture. |
| Untrusted loopback SMTP certificate in both TLS modes | PASS | The unmodified production transport rejects it before AUTH/DATA and returns the fixed certificate error without the password. |
| Lost final SMTP DATA acknowledgement | PASS | Outcome stays uncertain and DATA is not automatically repeated. |
| Actual Bridge discovery/setup, large attachments, sending, restart and outage | NOT RUN | No qualified Bridge installation/account or authorized live send scenario is established. |

There are two selected IMAP cases and six SMTP cases. These are transport safety observations, not Proton compatibility or end-to-end encryption claims. The synthetic certificate used by these fixtures is not a captured Bridge certificate.

## Remaining acceptance

Record an exact Bridge version, OS/architecture and authorized paid account before a live pass. Agree synthetic mailbox data, attachment sizes and a named test recipient; keep credentials in the secure local setup flow. Resolve the trust gap first with an explicit, account-scoped public-certificate trust design. Review loopback endpoint binding, certificate identity/fingerprint, replacement/expiry, reconnect generations and both transports. Do not import Bridge's private key or disable TLS verification globally.

Then test manual/discovery setup, historical originals and never-opened attachments, representative large messages, aliases and SMTP rights, uncertain sends, Bridge restart, credential/certificate rotation, and unavailable Bridge. Previously downloaded LegalWork originals must stay readable during an outage without fabricating unavailable bytes or replaying sends. Match provider-visible identities and sampled original/attachment hashes, with exclusions recorded.

Keep MAIL-136 In Progress until this evidence exists or an explicit scope decision removes Bridge from supported providers. No acceptance checkbox is closed by the synthetic fixtures alone. A future support claim must name tested versions and actual limits, independently for reading and sending.
