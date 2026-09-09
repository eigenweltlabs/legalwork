# Private mail OAuth foundation

`apps/server/src/mail/providers/oauth.ts` implements authorization-code transport for the dedicated Gmail/Graph registrations. It does not open a browser, initiate actual consent, select a cloud owner, identify a mailbox, persist tokens or expose a public route. It leaves the existing Google Workspace extension unchanged. Official provider/RFC details were reviewed on 9 September 2026.

## Caller contract

`startMailOAuth(settings, options)` accepts installed-app settings derived from `MailProviderConfig`, omitting the runtime redirect. Gmail additionally receives its Desktop client secret directly in memory; this is never an environment lookup. Graph receives the explicit pilot tenant GUID and registered native redirect. The configuration checker still requires full-mail Gmail modify and Graph delegated scope prerequisites. A valid local configuration is not a live authorization assertion.

The returned handle contains `authorizationUrl`, `redirectUri`, `expiresAt`, `loopbackFamilies`, `result` and `cancel()`. The trusted desktop caller opens `authorizationUrl` in the system browser only after user initiation, awaits `result`, and cancels when the user locks mail, closes connection UI or quits. No callback/state/verifier/authorization URL is logged or persisted by this module. Code/state in the authorization response query are necessary for this requested OAuth flow; access/refresh/ID tokens never appear in generated URLs. The caller must not log the token result.

Each flow creates independent cryptographic 32-byte state and a 32-byte PKCE verifier (43 base64url characters), derives an S256 challenge, and binds the same verifier and exact callback URI to the token exchange. Provider-facing authorization uses response_type=code; Graph explicitly uses response_mode=query. Google requests offline access and consent. Desktop clients are public clients: a Google Desktop client secret is not confidential proof of application identity. [Google installed-app flow](https://developers.google.com/identity/protocols/oauth2/native-app), [Microsoft code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [PKCE](https://www.rfc-editor.org/rfc/rfc7636.html).

## Callback binding

- Gmail binds only `127.0.0.1` on an OS-assigned port and generates `http://127.0.0.1:<port>/`.
- Graph keeps the actual registered redirect `http://localhost/mail/callback`, adding the runtime ephemeral port. It binds separate `127.0.0.1` and `::1` listeners to that same port; both require HTTP Host `localhost:<port>`. There is never a wildcard interface bind. Microsoft does not support an IPv6 literal redirect; accepting localhost connections over IPv6 does not change the redirect to an IPv6 literal.
- If Graph's IPv6 bind reports EADDRINUSE, both attempted listeners are closed and a fresh ephemeral port is tried, at most three attempts. An occupied counterpart is never silently ignored. EAFNOSUPPORT, EPROTONOSUPPORT or EADDRNOTAVAIL intentionally selects IPv4-only localhost operation and reports that via `loopbackFamilies`; other binding failures close everything and fail. Browser/OS fallback on IPv6-disabled installations still requires platform qualification.

Microsoft ignores the port when matching localhost redirects, but preserves path/case; it does not grant that port exception to literal IP redirects. The foundation therefore rejects alternate Graph callback registrations instead of silently switching hosts or paths. [Microsoft redirect rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), [native loopback guidance](https://www.rfc-editor.org/rfc/rfc8252.html).

The listener validates GET, exactly one expected Host header, the exact raw path, bounded request target/headers, no request body and no URL tokens. Dot-segment/encoded-path alternatives are rejected rather than normalized into the callback. Returned state is compared using timingSafeEqual on fixed-size SHA-256 digests. Invalid/missing/duplicate state does not consume the pending flow. A valid-state code or denial atomically consumes it before asynchronous exchange; malformed or repeated code/error combinations cannot exchange twice. Provider error descriptions are never reflected, even for denied consent. Browser responses are fixed text with no-store, no-referrer and restrictive CSP headers.

Default flow lifetime is five minutes (configurable 10 ms–10 minutes). Expiry/cancellation rejects the result, aborts exchange and closes all sockets/listeners. Listeners stop accepting connections after a valid callback, with a bounded 250 ms window for the fixed response to flush. The test-only `listen` dependency permits deterministic occupied-port/IPv6-disabled tests; production must use the default binder.

## Token exchange and unresolved identity

`exchangeMailOAuthCode` can also be called directly with explicit code/verifier/redirect inputs. It POSTs form data only to `https://oauth2.googleapis.com/token` or `https://login.microsoftonline.com/<validated-tenant>/oauth2/v2.0/token`. Gmail's Desktop secret is placed in that POST body; Graph never sends a client secret. Redirect following is disabled (`redirect: "error"`). Neither provider raw errors nor fetch errors are returned or logged.

The exchange defaults to a 30-second deadline (10 ms–60 seconds allowed), combines cancellation with AbortController, and rejects by deadline even if an injected transport ignores abort. JSON bodies are capped at 64 KiB while streaming. Successful responses require HTTP 200, JSON, a bounded nonempty printable access token, Bearer token type and an integer expires_in between 1 second and 7 days. No expiry default is invented; expiry is computed conservatively from request start. Malformed optional token/scope fields fail validation. Empty stream chunks are rejected; response buffering cannot grow without a byte/count cap. [OAuth token response contract](https://www.rfc-editor.org/rfc/rfc6749.html), [provider response fields](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

Result fields are `accessToken`, nullable `refreshToken`, `tokenType`, `expiresAt`, nullable `grantedScopes`, and nullable **`unverifiedIdToken`**. Missing scope/refresh information stays null; this foundation never substitutes requested scopes or assumes renewable access. Even when returned, an ID token is only unverified transport data. Before creating an owned mailbox or enabling provider operations, integration must validate the actual signed-in provider identity, tenant/audience and granted permissions, then persist credentials through its separate protected store. Never derive the desktop owner from a decoded, unverified token. Refresh-token exchange/rotation, identity discovery/verification and credential persistence remain separate work.

## Validation and limits

```sh
pnpm --dir apps/server exec bun test src/mail/providers/oauth.test.ts
pnpm --dir apps/server exec tsc -p tsconfig.json --noEmit
```

The tests exercise actual loopback sockets with synthetic credentials and injected provider HTTP. They cover PKCE correlation, state uniqueness/one-use, wrong host/path/method/state, duplicate parameters, provider denial redaction, simultaneous callbacks, Graph IPv4/IPv6 delivery, occupied-port retry/disabled-IPv6 fallback, expiration/cancellation, redirected/error/malformed/oversized token responses, hanging fetch/body deadlines and absent optional grants. A temporary compilation also runs three smoke tests in actual Node, including normal localhost name resolution and listener cleanup. No test opens a browser, contacts a live token endpoint, uses the new real client IDs or changes existing Workspace credentials.

No live provider interoperability or consent was verified. Google Desktop client creation remains the operator's supported console step; Azure app creation alone does not imply tenant consent. Public rollout verification, cross-platform callback behavior, OS-vault ownership and eventual Outlook.com/multitenant policy remain integration prerequisites.
