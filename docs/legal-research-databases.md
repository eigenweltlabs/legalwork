# Legal research database onboarding

Research checked on 2026-10-28. This is a practical shortlist of established and locally relevant research services across all 27 EU member states, the UK and US. It is not a measured market-share ranking or an exhaustive catalogue. Country suggestions do not establish a provider's jurisdictional or subscription coverage. The source of truth for the shipped presets is `packages/types/src/legal-research.ts`.

## Country suggestions

| Country | Services |
| --- | --- |
| Austria | RDB (MANZ), Lexis 360 |
| Belgium | Strada lex Belgique, Libra (Wolters Kluwer) |
| Bulgaria | Ciela Net |
| Croatia | IUS-INFO Croatia |
| Cyprus | Leginet |
| Czechia | Beck-online CZ, ASPI CZ, Libra (Wolters Kluwer) |
| Denmark | Karnov |
| Estonia | Estlex |
| Finland | Edilex |
| France | Dalloz, Lexis 360 Intelligence |
| Germany | beck-online, juris, Libra (Wolters Kluwer) |
| Greece | NOMOS |
| Hungary | Jogtár, Libra (Wolters Kluwer) |
| Ireland | Westlaw Ireland, vLex |
| Italy | DeJure, One LEGALE, Libra (Wolters Kluwer) |
| Latvia | Lursoft |
| Lithuania | Infolex |
| Luxembourg | Strada lex Luxembourg |
| Malta | Lexis+ UK, HeinOnline |
| Netherlands | InView Legal, Libra (Wolters Kluwer) |
| Poland | LEX, Legalis, Libra (Wolters Kluwer) |
| Portugal | DataJuris, vLex |
| Romania | Sintact, Lege5, Libra (Wolters Kluwer) |
| Slovakia | Beck-online SK, ASPI SK, Libra (Wolters Kluwer) |
| Slovenia | IUS-INFO Slovenia, Tax-Fin-Lex |
| Spain | Aranzadi Digital, Tirant Online, vLex |
| Sweden | JUNO |
| United Kingdom | Westlaw UK, Lexis+ UK, vLex |
| United States | Westlaw, Lexis+, Bloomberg Law, HeinOnline, vLex, CourtListener |

Malta's suggestions are international services listed by the University of Malta library. They are not claimed to be dedicated Maltese-law collections. Lursoft focuses on Latvian company/legal records rather than a comprehensive commentary library. Users can search across countries or add their own provider.

## Research entry points and sign-in origins

The research URL starts a normal browser visit. The login URL supplies the vault origin. Stable addresses are stored without OAuth state, session IDs, nonces or authorization codes. The card stores the canonical sign-in origin; saved destination URLs omit query strings and fragments, so pasted OAuth parameters are discarded. A login origin can differ from the research domain; it must not be inferred from the provider name or an assumed subdomain. Sources include provider documentation, public login forms and observed redirects from the linked research entry point. No paid account was used to claim successful authentication.

| Provider | Research entry | Login address / vault host | Sources |
| --- | --- | --- | --- |
| beck-online | [Research](https://beck-online.beck.de/Home) | [beck-online.beck.de](https://beck-online.beck.de/Home) | [1](https://status.beck.de/de) |
| juris | [Research](https://www.juris.de/jportal/) | [www.juris.de](https://www.juris.de/jportal/) | [1](https://www.juris.de/jportal/nav/services/faqs/index.jsp) |
| Libra (Wolters Kluwer) | [Research](https://app.libratech.ai/) | auth.libratech.ai, observed app redirect; start sign-in from the app | [Official entry](https://libratech.ai/), [collections](https://libratech.ai/product/legal-content), [ownership](https://www.wolterskluwer.com/en/news/wolters-kluwer-completes-acquisition-of-libra-technology-gmbh) |
| RDB (MANZ) | [Research](https://rdb.manz.at/) | [login.manz.at](https://login.manz.at/login) | [1](https://rdb.manz.at/login) |
| Lexis 360 | [Research](https://360.lexisnexis.at/) | [signin.lexisnexis.com](https://signin.lexisnexis.com/lnaccess/app/signin) | [1](https://360.lexisnexis.at/) |
| Strada lex Belgique | [Research](https://www.stradalex.com/) | Unconfirmed: user must enter current login URL | [1](https://www.stradalex.com/), [2](https://statics.stradalex.com/doc/sl/en/SLBE_GENERAL_FR.pdf) |
| Ciela Net | [Research](https://web7.ciela.net/) | [web7.ciela.net](https://web7.ciela.net/) | [1](https://web6.ciela.net/) |
| IUS-INFO Croatia | [Research](https://www.iusinfo.hr/) | [www.iusinfo.hr](https://www.iusinfo.hr/prijava) | [1](https://www.iusinfo.hr/) |
| Leginet | [Research](https://www.leginet.eu/) | [www.leginet.eu](https://www.leginet.eu/) | [1](https://www.leginet.eu/) |
| Beck-online CZ | [Research](https://app.beck-online.cz/) | [app.beck-online.cz](https://app.beck-online.cz/bo/login) | [1](https://www.beck-online.cz/) |
| ASPI CZ | [Research](https://www.aspi.cz/) | [login.wolterskluwer.cz](https://login.wolterskluwer.cz/) | [1](https://www.aspi.cz/) |
| Karnov | [Research](https://pro.karnovgroup.dk/) | [pro.karnovgroup.dk](https://pro.karnovgroup.dk/auth/pro-dk/users/sign_in) | [1](https://docs.karnovgroup.com/customer-portal/), [2](https://pro.karnovgroup.dk/) |
| Estlex | [Research](https://estlex.ee/) | [estlex.ee](https://estlex.ee/) | [1](https://estlex.ee/) |
| Edilex | [Research](https://www.edilex.fi/) | [yritystunnus.almamedia.fi](https://yritystunnus.almamedia.fi/) | [1](https://www.edilex.fi/) |
| Dalloz | [Research](https://www.dalloz.fr/) | [connexion.dalloz.fr](https://connexion.dalloz.fr/login) | [1](https://www.dalloz.fr/), [2](https://www.dalloz.fr/Home/hulkStatic/DZ/AIDE/DZ/aide.html) |
| Lexis 360 Intelligence | [Research](https://www.lexis360intelligence.fr/) | [signin.lexisnexis.com](https://signin.lexisnexis.com/lnaccess/app/signin) | [1](https://www.lexisnexis.com/supportandtraining/fr/lexis-360-intelligence/b/lexis-360-intelligence/posts/lexis-360-intelligence---je-ne-parviens-pas-a-me-connecter-je-reviens-toujours-sur-la-page-se-connecter) |
| NOMOS | [Research](https://nomosdb.gr/nomos-ui/main) | [nomosdb.gr](https://nomosdb.gr/nomos-ui/main) | [1](https://nomosdb.gr/nomos-ui/main) |
| Jogtár | [Research](https://uj.jogtar.hu/) | [fiok.wolterskluwer.hu](https://fiok.wolterskluwer.hu/) | [1](https://uj.jogtar.hu/), [2](https://uj.jogtar.hu/wk-login) |
| Westlaw Ireland | [Research](https://ie.westlaw.com/) | [signon.thomsonreuters.com](https://signon.thomsonreuters.com/) | [1](https://legalsolutions.thomsonreuters.co.uk/en/customer-support/online-services/getting-started.html) |
| DeJure | [Research](https://dejure.lefebvregiuffre.it/) | [cliente.giuffre.it](https://cliente.giuffre.it/logingfl/Login?site=dejurenew) | [1](https://dejure.lefebvregiuffre.it/) |
| One LEGALE | [Research](https://onelegale.wolterskluwer.it/) | [login.wolterskluwer.eu](https://login.wolterskluwer.eu/) | [1](https://onelegale.wolterskluwer.it/) |
| Lursoft | [Research](https://www.lursoft.lv/) | [www.lursoft.lv](https://www.lursoft.lv/lv/user/login) | [1](https://www.lursoft.lv/) |
| Infolex | [Research](https://www.infolex.lt/teise/) | [www.infolex.lt](https://www.infolex.lt/teise/Default.aspx?Login=1) | [1](https://www.infolex.lt/teise/Default.aspx?Login=1) |
| Strada lex Luxembourg | [Research](https://www.stradalex.lu/) | Unconfirmed: user must enter current login URL | [1](https://statics.stradalex.lu/doc/slu/fr/SLU_GENERAL.pdf) |
| InView Legal | [Research](https://www.inview.nl/) | [login.wolterskluwer.eu](https://login.wolterskluwer.eu/) | [1](https://www.wolterskluwer.com/nl-nl/solutions/inview/support/inview-legal/veelgestelde-vragen), [2](https://assets.contenthub.wolterskluwer.com/api/public/content/2039072-factsheet-inview-browserondersteuning-d905a61165?v=4b4a0884) |
| LEX | [Research](https://sip.lex.pl/) | [borg.wolterskluwer.pl](https://borg.wolterskluwer.pl/core/v2.0/login) | [1](https://sip.lex.pl/) |
| Legalis | [Research](https://sip.legalis.pl/) | [sip.legalis.pl](https://sip.legalis.pl/login) | [1](https://sip.legalis.pl/) |
| DataJuris | [Research](https://db.datajuris.pt/) | [db.datajuris.pt](https://db.datajuris.pt/) | [1](https://www.datajuris.pt/) |
| Sintact | [Research](https://sintact.ro/) | [autentificare.wolterskluwer.ro](https://autentificare.wolterskluwer.ro/) | [1](https://shop.wolterskluwer.ro/storage/file/core_files/2025/6/23/35b1bc1cce22a6fa99db5e080c2b97f0/Sintact.ro-Manual-de-utilizare.pdf) |
| Lege5 | [Research](https://lege5.ro/) | [lege5.ro](https://lege5.ro/Authentication/Login) | [1](https://lege5.ro/Authentication/Login) |
| Beck-online SK | [Research](https://app.beck-online.sk/) | [app.beck-online.sk](https://app.beck-online.sk/bo/login) | [1](https://www.beck-online.sk/) |
| ASPI SK | [Research](https://www.aspi.sk/) | [login.wolterskluwer.cz](https://login.wolterskluwer.cz/) | [1](https://www.aspi.sk/) |
| IUS-INFO Slovenia | [Research](https://www.iusinfo.si/) | [www.iusinfo.si](https://www.iusinfo.si/prijava) | [1](https://www.iusinfo.si/) |
| Tax-Fin-Lex | [Research](https://www.tax-fin-lex.si/) | [www.tax-fin-lex.si](https://www.tax-fin-lex.si/Uporabnik/Prijava) | [1](https://www.tax-fin-lex.si/) |
| Aranzadi Digital | [Research](https://soluciones.aranzadilaley.es/content/Inicio.aspx) | [login-miespacio.aranzadilaley.es](https://login-miespacio.aranzadilaley.es/account/login) | [1](https://info.aranzadilaley.es/landing-temporal-ad) |
| Tirant Online | [Research](https://www.tirantonline.com/) | [www.tirantonline.com](https://www.tirantonline.com/base/tol/user_logins/new) | [1](https://prime.tirant.com/es/) |
| JUNO | [Research](https://juno.nj.se/b) | [juno.nj.se](https://juno.nj.se/auth/pro-se/users/sign_in) | [1](https://www.nj.se/anvand-juno/support) |
| Westlaw UK | [Research](https://uk.westlaw.com/) | [signon.thomsonreuters.com](https://signon.thomsonreuters.com/) | [1](https://legalsolutions.thomsonreuters.co.uk/en/customer-support/online-services/getting-started.html) |
| Lexis+ UK | [Research](https://plus.lexis.com/uk) | [signin.lexisnexis.com](https://signin.lexisnexis.com/lnaccess/app/signin) | [1](https://www.lexisnexis.co.uk/product-adoption/lexis-plus/login-help.html), [2](https://www.um.edu.mt/library/databases/) |
| Westlaw | [Research](https://1.next.westlaw.com/) | [signon.thomsonreuters.com](https://signon.thomsonreuters.com/) | [1](https://legal.thomsonreuters.com/en/support) |
| Lexis+ | [Research](https://plus.lexis.com/) | [signin.lexisnexis.com](https://signin.lexisnexis.com/lnaccess/app/signin) | [1](https://lnrc.custhelp.com/app/answers/answer_view/a_id/1102196/~/how-to-sign-in-to-lexis%2B) |
| Bloomberg Law | [Research](https://www.bloomberglaw.com/) | [www.bloomberglaw.com](https://www.bloomberglaw.com/login) | [1](https://www.bloomberglaw.com/login) |
| HeinOnline | [Research](https://heinonline.org/HOL/Welcome) | [access.heinonline.com](https://access.heinonline.com/HOL/login-hol) | [1](https://access.heinonline.com/HOL/login-hol), [2](https://www.um.edu.mt/library/databases/) |
| vLex | [Research](https://app.vlex.com/) | [vlex.com](https://vlex.com/account/login) | [1](https://vlex.com/account/login) |
| CourtListener | [Research](https://www.courtlistener.com/) | [www.courtlistener.com](https://www.courtlistener.com/sign-in/) | [1](https://github.com/freelawproject/courtlistener-api-client/blob/main/MCP_README.md), [2](https://wiki.free.law/c/courtlistener/help/memberships/individual-memberships/individual-memberships-faqs) |

## Observations and limitations

- Lexis+ US/UK, Lexis 360 Austria and Lexis 360 Intelligence France use `signin.lexisnexis.com`. Westlaw uses `signon.thomsonreuters.com`.
- ASPI Czechia and Slovakia both redirect to `login.wolterskluwer.cz`. Jogtár uses `fiok.wolterskluwer.hu`; LEX uses `borg.wolterskluwer.pl`; Sintact uses `autentificare.wolterskluwer.ro`. These are not one interchangeable Wolters Kluwer domain.
- RDB redirects to `login.manz.at`; Dalloz to `connexion.dalloz.fr`. Edilex redirects to `yritystunnus.almamedia.fi`, where this research environment received an access block.
- DeJure's current research site embeds the `cliente.giuffre.it` login. The existing password-filling tool checks both the top-level website and the password field. The skill opens the configured sign-in page at top level or asks for manual sign-in if the provider requires its embedded flow. It does not weaken those checks.
- Strada lex Belgium and Luxembourg returned their own 404 page during this check. Their official help confirms email/password accounts, but the current password-page origin could not be confirmed. These presets deliberately have no login URL. Setup requires the user to enter the current sign-in page before any password is collected.
- Site state, institutional SSO, MFA, anti-bot checks and subscription modules can change the actual flow. Account setup is not an authentication or entitlement test. New, unrelated authentication domains require an explicit saved login through the existing secure card.

## Free test provider

CourtListener provides a free individual account for US legal research. [Register](https://www.courtlistener.com/register/), then sign in at [CourtListener](https://www.courtlistener.com/sign-in/) with the account username and password. The Free Law Project's [account requirements](https://github.com/freelawproject/courtlistener-api-client/blob/main/MCP_README.md) distinguish free accounts from [paid memberships](https://wiki.free.law/c/courtlistener/help/memberships/individual-memberships/individual-memberships-faqs). Basic case-law research is suitable for this test; do not select paid PACER retrieval or purchase a membership.

The public CourtListener sign-in page returned HTTP 403 in this automated environment. The free account offering is documented, but a live login or authenticated search is **not** verified here. Use the visible Browser Automation tab for any required provider check. Do not enter real credentials in the preview fixture or in chat.

## Implementation and validation

Onboarding, chat and Settings share the existing encrypted BrowserPasswordStore. Provider setup validates a saved-login UUID against the actual sign-in domain and attaches destination metadata to that vault entry. Several destinations can share one login. Updates preserve linked destinations when the login website remains the same; moving credentials to a different main domain clears old links. Destination query strings and fragments are stripped. Host-only credential management and the existing main-domain/subdomain fill checks remain unchanged.

Saving a login does not create a plugin or skill. The bundled `legal-research` skill is seeded in every workspace, discovers saved website metadata with `legalwork_browser_connections`, and optionally loads a site-specific skill from the normal catalogue. Country presets only prefill URLs. **Settings > Secrets > Browser passwords** is the single management view. Onboarding uses the full-page OnboardingCover, standard 32px heading, progress dots and bottom Back/Skip/Continue footer. There is no separate website-management modal under Integrations.

### Direct website setup and Libra research

For any website, `legalwork_browser_request_password` can display the existing vault card directly with a user-supplied `website_url`. Known providers use `provider` to resolve catalogue URLs internally. Missing URLs are requested from the user. Neither a live browser capability nor a research/help skill is required before this card. The existing `browser_url` path remains available when sign-in is encountered during browsing. A saved entry is validated through the scoped metadata-only discovery endpoint, filtered using the existing vault domain matcher. Reusing an account adds the requested destination without duplicating its password. Browser verification then starts at `start_url` to establish fresh authentication state.

Libra is bundled with a `libra-research` skill and suggested in countries with listed source collections. The public app entry was observed redirecting to an email-first Auth0 page on `auth.libratech.ai`; state-bearing paths are not persisted. Authenticated chat controls have not been tested. The skill submits one research prompt, inspects submission before any retry, and checks observed progress with native browser waits of at most 30 seconds. The default overall deadline is five minutes. Timeout preserves the conversation and reports incomplete status; a later check reuses the same conversation. The skill reviews source citations and uses the general research skill's existing per-website operational memory and automatic source preservation and wiki contribution flow.

### Persistent website experience

After loading `legal-research`, the agent reads and updates `legalwork_research_experience` with a saved connection ID and an exact destination URL. The server checks the bundled skill's canonical path and content and verifies the destination is still linked. Managed calls retain their originating session and workspace scope; discovery and website memory require collaborator access. The tool returns no password or username. Credential writes remain host-only. Existing optional provider skills retain their owned experience logs.

Notes persist in `research_skill_experience`, keyed by connection UUID plus a hash of the destination URL and issue key. The app-managed skill file is unchanged by learning. Notes are excluded from skill exports and unavailable when their saved connection is removed. Transactions, expected revisions and idempotent retries preserve concurrent changes. Each website has at most 30 bounded notes. Skill permissions, read-only mode, organization policy, approval and audit apply to writes.

The skill instructs the agent to log observed failures automatically, distinguish unresolved attempts from verified fixes and retire obsolete advice. Each note records a timestamp and skill fingerprint; changed packages or observations older than 30 days are flagged for rechecking. Notes are fallible operational data, never authority to change vault rules, bypass access controls, make purchases or draw legal conclusions. The agent must write generic, matter-independent observations. The API additionally rejects obvious URLs, email addresses, credential assignments, long token-like strings and HTML; this is defense in depth, not comprehensive secret or personal-data detection. Vault values are never read by the learning path.

The regression tests exercise persistence through fresh native tool instances and chats, automatic loading, setup retry, reinstall, provider isolation, revision conflicts, deletion, note limits, stale versions, aging, invalid payloads and read-only access. This tests the durable learning mechanism with observed-outcome fixtures, not live-provider recovery or a claim that a model's reported success has been independently verified.

### Personal legal knowledge base

The app's session shell calls the owner-only `POST /wikis/legal-research/ensure` once per connection/language/country on launch, including existing installations and users who skip database setup. `WikiStore` creates a personal, project-accessible wiki with purpose `legal-research`, an English or German initial title, a home page, browsing indexes and dedicated content instructions. The selected country seeds its jurisdiction, with EU law for EU countries, the three UK systems for GB and federal law for US. It does not use the generic firm/process starter or import findings. A serialized ensure operation plus the durable `wiki_defaults` marker handles retries and restarts without resetting names, files, access or deliberate removal. A completed registration recovers an interrupted marker write. A same-named user wiki is not silently adopted or rewritten. Creation uses the normal independent wiki folder checks and owner/read-only boundary; it does not create sharing or background jobs.

The legal-research skill and fixed wiki-tool guidance require reading and downloading relevant primary sources and contributing useful legal findings without a separate consent-to-prepare step. Agents discover the research wiki by its stable purpose and contribute through `wiki_suggest` with immutable source snapshots. `requireAgentApproval` defaults to false for the automatically generated research wiki and true for other wikis. An existing generated wiki adopts false only if no explicit setting was saved. When true, the contribution remains pending until human Save. When false, authenticated project-agent contributions publish in the background through the same revision-checked store operation. The human Save endpoint remains unavailable to agents. Dedicated wiki sessions may edit their own wiki. Publication does not grant access, bypass read-only roles or enable general proactive knowledge capture. Website operations remain in the separate skill experience log.

UI evidence uses the explicitly labeled development preview with synthetic credentials. Server tests use a temporary vault, runtime database and configuration directory. They cover preset validation, mismatched domains, owner authorization, repeat setup, global visibility, read-only mode, manual edits and uninstall. These tests do not authenticate to external providers.

To reproduce the interface, run `pnpm --filter @legalwork/app dev` and open `/onboarding-preview.html?step=research&lang=de&country=DE`. Add `research-error` to simulate one connection failure. This preview never stores real passwords or links real websites. The full research selection is an onboarding step. Later login management is in **Settings > Secrets > Browser passwords**.

### Research wiki classification and review

The canonical hierarchy is jurisdiction / area of law / specific legal issue. International regimes and comparative syntheses have separate branches. The design combines jurisdiction-based classification at the [Law Library of Congress](https://wwws.loc.gov/law/about/collections.php) with subject navigation at [beck-online](https://beck-online.de/rechtsgebiete/) and [Westlaw](https://www.thomsonreuters.com/en-us/help/westlaw-advantage/tools/access-the-west-key-number-system). The [UK Judiciary](https://www.judiciary.uk/about-the-judiciary/our-justice-system/jud-acc-ind/justice-sys-and-constitution/) distinguishes three UK systems; the [European e-Justice Portal](https://e-justice.europa.eu/topics/legislation-and-case-law_en) distinguishes EU, national and international law. The shared 17-area catalogue is our product taxonomy, with local subtopics, not an official universal classification.

All substantive pages retain `type: legal-research`. Guidance specifies `knowledge_type`, `jurisdictions`, `primary_area`, `areas`, `topics`, `law_as_of`, `researched_on` and `related`, with citations, territorial limits and supersession links in the text. IDs stay stable across UI languages. The read-only research index projects the saved snapshot by area or jurisdiction, with scoped jurisdiction and comparison views; it links canonical pages instead of writing duplicate indexes. Unclassified legacy findings remain visible. Historical previews do not inject a live index.

`destination.createFolders` explicitly proposes missing parents in the designated research wiki only. Staging and dismissal write nothing into the wiki. The review shows the complete path, new-folder notice, legal classification and dates. Human Save or an allowed background contribution creates the parents through WikiStore's safe path writer and preserves exact draft/page revision checks. Other wikis still require an existing folder. Agents inspect the nearest existing parent's inherited instructions before proposing a new branch.

The structure migration records its version, original language and first selected country in `wiki_research_structure`. It adds navigation once, updates only v1/v2 starter files whose exact hashes match the shipped originals, and never moves or rewrites substantive findings. User-edited files, renamed wikis, access restrictions, removed navigation and deliberate wiki removal are preserved. Shared wikis are not restructured automatically. Country selection may arrive after first launch; it adds only the initial country's landing pages and does not recreate other navigation. Tests use a frozen v1 fixture to exercise the actual migration.
