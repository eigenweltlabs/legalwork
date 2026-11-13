# Lexis saved-login entry pages

Verified on 3 November 2026 using public product pages, redirects and France's production configuration. This verifies routing and sign-in form availability, not a subscriber's credentials, entitlements or authenticated research.

## Failure and repair

The earlier welcome-screen and Settings setup paths saved the authentication origin without a separate starting URL, then appended the research product. This could leave `https://signin.lexisnexis.com/` first in the saved destinations. That root leads to the US corporate gateway. Opening the bare `/lnaccess/app/signin` path without product context returns `ERR_ACI_INVALID`.

All four catalogue products therefore need the same distinction: open the regional product page and allow password filling on `https://signin.lexisnexis.com`. Keep the catalogue's product URL as the starting page. The catalogue's bare `loginUrl` supplies the credential origin, not a navigable sign-in session.

| Catalogue ID | Stable destination | Public sign-in evidence |
| --- | --- | --- |
| `lexis360-at` | `https://360.lexisnexis.at/` and `https://plus.lexis.com/at` | Austrian product entry pages establish their own sign-in context. |
| `lexis360-fr` | `https://www.lexis360intelligence.fr/` | Public configuration supplies `aci=lint` with `/legan-callback`; the contextual sign-in URL returns the French username/password form. |
| `lexis-uk` | `https://plus.lexis.com/uk` | Product redirects with `aci=uk`; the contextual sign-in URL returns the UK form. |
| `lexis-us` | `https://plus.lexis.com/` | Product redirects with `aci=lp`; the contextual sign-in URL returns the US form. |

Sources: [Austrian product](https://360.lexisnexis.at/), [French production configuration](https://www.lexis360intelligence.fr/assets/config.latest.json), [UK login help](https://www.lexisnexis.co.uk/product-adoption/lexis-plus/login-help.html), [US sign-in instructions](https://lnrc.custhelp.com/app/answers/answer_view/a_id/1102196/~/how-to-sign-in-to-lexis%2B).

New preset and onboarding saves now preserve the product destination. Direct setup from the exact verified product URLs maps credentials to the shared sign-in host while retaining the regional starting URL. Unknown paths, alternate ports and lookalike hosts do not receive that mapping.

The one-time vault migration repairs pre-feature entries only when provider IDs or known product URLs identify the region. It supports several known products on one account and preserves custom destinations and credentials. A custom company SSO password does not gain permission on Lexis from destination or provider metadata alone. It does not infer a region from a label or the shared authentication host. Because `plus.lexis.com` is shared, an origin-only fallback at that host is also ambiguous. Existing version 1 entries do not regain removed destinations or permissions. Tests cover these cases and repeat reads after a user removes repaired URLs.

These defects can explain wrong-product navigation or a sign-in error. Public routing checks alone do not establish which failure occurred in a particular customer's chat or measure its contribution to research latency.
