# Mail OAuth refresh transport

`providers/refresh.ts` exports `refreshMailOAuth({settings, refreshToken, fetch?, signal?, timeoutMs?})`. It performs one refresh attempt with existing installed-app settings, without browser interaction, token persistence, account identification or automatic retries. Credentials are passed directly in memory and posted as form data; no environment, argv, URL or logging channel carries them. This module adds no public API or worker command.

Google uses `https://oauth2.googleapis.com/token` with grant_type, client_id, client_secret and refresh_token. Microsoft uses `https://login.microsoftonline.com/<validated-pilot-tenant>/oauth2/v2.0/token` with grant_type, client_id and refresh_token, without a client secret. Scope is omitted to retain the original grant, rather than attempting a scope upgrade. Configuration readiness does not establish that the original grant exists. [Google installed-app refresh](https://developers.google.com/identity/protocols/oauth2/native-app#offline), [Microsoft refresh request](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token).

## Credential update contract

A successful `MailRefreshResult` contains accessToken, tokenType, expiresAt, nullable grantedScopes, nullable unverifiedIdToken and a discriminated refreshToken update:

- `{action: "preserve"}` means retain exactly the previously supplied refresh credential. An omitted token must never overwrite the stored token with null or undefined.
- `{action: "replace", value: "…"}` means the provider returned a validated replacement. Persist that replacement atomically with the access-token update before retiring the old local credential. This applies to either provider; Microsoft normally issues a replacement, while Google commonly omits it.

Microsoft states that refresh-token reuse returns a fresh token and that the old token is not automatically revoked by that use. Integration must serialize refreshes per owned account and credential generation, ignore results belonging to a locked/disconnected or replaced account, and durably store the returned replacement before removing the old local copy. This transport neither revokes nor deletes tokens. [Microsoft refresh-token lifecycle](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).

If an exchange times out after the provider accepted it, its outcome is unknown: no new credential is assumed and the original is retained. The caller must handle provider-specific recovery and avoid parallel refresh attempts. JavaScript strings cannot offer guaranteed memory zeroization. Returned ID tokens remain explicitly unverified; refresh success does not itself establish a mailbox identity, tenant/audience validation or actual permissions. Omitted scopes remain null.

## Redacted errors and retry scheduling

`MailRefreshError` has a fixed code/message, retryable boolean and nullable retryAfterMs. Provider descriptions, diagnostic IDs, raw response bodies and transport exception text are never propagated.

| Code | Meaning and caller action |
| --- | --- |
| reconsent_required | Structured invalid_grant, interaction_required, consent_required or login_required; offer a user-initiated sign-in, retaining account data. No automatic destructive revoke. |
| client_rejected | Structured invalid_client or unauthorized_client; inspect configured registration. Repeated consent is not assumed to fix it. |
| rate_limited | HTTP 429; defer work using retry timing and caller backoff. |
| transient | HTTP 408/5xx, structured temporarily_unavailable/server_error, or transport failure; bounded caller backoff may retry. |
| timeout | The configured deadline elapsed; retry policy belongs to the caller. |
| cancelled | User/service cancellation; do not retry automatically. |
| configuration_invalid, request_rejected, response_invalid | Invalid local inputs, unrecognized rejection or malformed response; surface a fixed error and require inspection. |

Only the rate_limited, transient and timeout codes have retryable=true. Retry-After is parsed from bounded headers as delta seconds or an HTTP date into a nonnegative safe integer of milliseconds. Invalid values become null. No provider text is copied. The caller should schedule no earlier than a supplied delay and use bounded exponential backoff with jitter otherwise; long delays must be stored/rechecked rather than passed blindly to a platform timer with a smaller integer range. There is no sleep or retry loop in this module. Microsoft describes invalid_grant recovery and transient token endpoint failures in its [token endpoint error contract](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-codes-for-token-endpoint-errors).

Requests disable redirect following. The default deadline is 30 seconds, configurable from 10 ms to 60 seconds; cancellation/deadline bounds waiting even when an injected transport ignores AbortSignal. Success and parsed error bodies are limited to 64 KiB with a streaming byte/count cap. HTTP 429/408/5xx bodies are cancelled without buffering. Success requires HTTP 200 JSON, a nonempty bounded printable access token, Bearer token type and integer expiry from 1 second through 7 days. Expiry is computed conservatively from request start; optional malformed tokens/scopes invalidate the whole result, so partial responses cannot update credentials.

## Evidence and remaining integration

```sh
pnpm --dir apps/server exec bun test src/mail/providers/refresh.test.ts
pnpm --dir apps/server exec tsc -p tsconfig.json --noEmit
```

Tests use synthetic credentials and injected HTTP only. Nine Bun tests include three tests of the compiled module in actual Node: Google preservation/body contract, Microsoft rotation and deadline/redaction. Coverage also exercises error classification, numeric/date Retry-After, malformed and oversized responses, hanging fetch/body, cancellation and no automatic retries. No browser or real token endpoint was used. Provider documentation was checked on 9 September 2026; actual refresh interoperability, encrypted credential storage, single-flight scheduling and account-generation ownership remain integration work.
