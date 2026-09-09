# Authenticated mail identity discovery

`providers/identity.ts` exports `discoverMailIdentity({settings, accessToken, grantedScopes, fetch?, signal?, timeoutMs?})`. The caller supplies the access token and actual granted scopes from its trusted OAuth exchange or protected credential store. This is authenticated provider API discovery, not JWT decoding. No ID token input is accepted, no email becomes an account key, and no token is persisted or logged.

## Return and persistence contract

The result has `provider`, `authority`, `providerSubject`, `tenantId`, `email` and nullable `displayName`. The immutable identity tuple is **provider + authority + providerSubject**. It aligns with the credential repository's authority/providerSubject fields. Caller-owned clientId and desktop owner remain separate bindings; this helper does not derive either from a provider response.

Google returns provider=gmail, authority=`https://accounts.google.com`, tenantId=null and the subject obtained from Google's authenticated UserInfo endpoint. Graph returns provider=graph, authority=`https://login.microsoftonline.com/<tenant-guid>/v2.0`, the API-verified configured tenantId and Graph's directory user id. That Graph authority is a deterministic namespace for the verified tenant, not a claim that an ID token's signature or issuer was checked. Graph GUIDs are lowercased; Google subjects remain byte-for-byte unchanged.

On reconnect, the caller must compare the entire immutable tuple before attaching credentials to an existing account. Email/display name are mutable metadata and cannot justify merging accounts. Inputs must belong to the same owned authorization attempt; scopes are trusted transport metadata, not client-supplied request-body assertions. Discovery does not prove token audience/client ownership independently of that trusted OAuth context.

## Google scopes and consistency

`GMAIL_MAIL_SCOPES` now requires `openid`, `email` and `https://www.googleapis.com/auth/gmail.modify`. Existing modify-only or optional Workspace read/compose configurations are insufficient; request explicit new consent rather than assuming an upgrade. Discovery requires actual granted scopes, accepts Google's expanded `https://www.googleapis.com/auth/userinfo.email` spelling for email, and fails with scope_unverified when grants are absent. The configuration validator deliberately retains the canonical requested spelling. No requested-scope fallback is used.

Using one access token, discovery GETs fixed `https://openidconnect.googleapis.com/v1/userinfo`, then `https://gmail.googleapis.com/gmail/v1/users/me/profile`. UserInfo must contain a bounded nonempty sub, email and boolean email_verified=true. Gmail's emailAddress must match that verified email case-insensitively. There is no dot, plus, alias, Workspace-domain or googlemail.com normalization; discrepancies fail identity_mismatch. The immutable Google subject remains stable across address changes. [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [UserInfo contract](https://developers.google.com/identity/openid-connect/reference), [Gmail profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile).

No profile scope is required just for a display name; missing name yields null. Email validation intentionally supports a conservative unquoted ASCII subset. Unusual quoted/international addresses require an explicit future policy rather than implicit acceptance or normalization.

## Graph tenant boundary

The pilot first GETs fixed `https://graph.microsoft.com/v1.0/organization?$select=id`. It requires exactly one organization, no continuation link, and an ID equal to the configured explicit tenant GUID. It then GETs fixed `https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName` using the same snapshotted token. The canonical subject is the directory id, scoped by the verified tenant. A missing or malformed mail field fails; userPrincipalName is not a fallback mailbox address and need not equal mail. These addresses can legitimately differ. Graph mail is provider-returned primary address metadata; it is not an OIDC email_verified assertion or proof of mailbox licensing/provisioning. [Graph user API](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0), [user properties](https://learn.microsoft.com/en-us/graph/api/resources/user?view=graph-rest-1.0).

Actual User.Read (also accepted with the https://graph.microsoft.com/ prefix) is required. Organization's id is available under existing User.Read with the ordinary User role; Organization.Read.All is not requested. A forbidden organization lookup fails closed rather than bypassing tenant verification. This organization endpoint does not support personal Microsoft accounts. Outlook.com and multitenant mail remain intended product capabilities but require a separately reviewed identity policy, not a silent expansion of this pilot. [Organization list permissions and response](https://learn.microsoft.com/en-us/graph/api/organization-list?view=graph-rest-1.0).

Graph identity discovery verifies only its required discovery permission. It does not certify Mail.ReadWrite/Mail.Send or offline_access; callers must independently check actual grants for each operation. Google requires modify because Gmail profile consistency is part of this full-mail contract.

## Bounds and errors

All calls use Authorization: Bearer headers, never query tokens. URLs are fixed constants and redirects are disabled. A single 30-second deadline covers both sequential calls and streamed body reads (configurable 10 ms–60 seconds). Each JSON body is bounded to 64 KiB, with a chunk-count cap; HTTP error bodies are cancelled unread. Cancellation and timeout reject even if an injected transport ignores abort. Late responses are cancelled and cannot produce a result or initiate the second request.

Errors contain only fixed codes: configuration_invalid, scope_unverified, cancelled, timeout, unauthorized, forbidden, transient, response_invalid or identity_mismatch. Raw provider descriptions, identities, tokens, response bodies and network exception messages never appear in diagnostics. HTTP 401/403 are distinct; 408/429/5xx and transport failures are transient. No retry, revocation, browser launch or destructive operation occurs here.

## Validation and unresolved live checks

```sh
pnpm --dir apps/server exec bun test src/mail/provider-config.test.ts src/mail/providers/identity.test.ts src/mail/providers/oauth.test.ts src/mail/providers/refresh.test.ts
pnpm --dir apps/server exec tsc -p tsconfig.json --noEmit
```

Identity tests exercise synthetic API responses, immutable subjects, verified-email mismatches, foreign/ambiguous tenants, no UPN fallback, absent grants, redaction, byte limits, hangs, cancellation and late-response cleanup. Three smoke tests compile the module and run under actual Node with injected HTTP. No provider HTTP or browser consent occurred. Sources were checked on 9 September 2026. Live Google grant spellings, tenant policy permissions, mailbox availability and credential-store integration still need qualification.
