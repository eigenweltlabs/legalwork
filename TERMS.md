# LegalWork — Terms & Conditions

**Last updated: 10 July 2026**

LegalWork is a local-first desktop application published by **Eigenwelt Labs**
(Berlin, Germany) ("Eigenwelt", "we", "us"). These Terms & Conditions ("Terms")
govern your use of the LegalWork desktop application and its official builds (the
"App"). By installing or using the App, you agree to these Terms. If you do not
agree, do not use the App.

## 1. What LegalWork is

LegalWork is a desktop "cowork" application for legal work — document review,
drafting, and related tasks. It runs on your own computer. You choose the AI
model: you can run open-source models locally, connect a hosted model using
your own API keys, or use the free models provided by Eigenwelt (Section 3).
The App is free for individual use. Enterprise deployment and the Eigenwelt
continual-learning training platform are offered separately under a commercial
agreement.

## 2. Your account and your data stay local

The App is local-first. Your documents, prompts, drafts, file contents, and the
results of your tasks are stored and processed on your own device. We do not
receive them, with one exception: if you use the free models described in
Section 3, the prompts and outputs of those requests are sent to and logged by
Eigenwelt.

When you connect a third-party model provider (for example via your own API
keys), the content you choose to send for inference is transmitted to that
provider so it can generate a response. That exchange is governed by **your**
agreement with that provider, not by these Terms. You are responsible for
choosing providers appropriate for your confidentiality and professional
obligations. If you run a model locally, no inference content leaves your device.

## 3. Free models provided by Eigenwelt

The App includes free models provided by Eigenwelt for **testing purposes**.
No account or login is required to use them.

If you choose free models, we will log usage data for those requests. Please
do not use free models with privileged, client, or matter data — use them
only to try the App. The App shows a notice when a free model is in use.

The free tier is usage-limited (a small per-device daily allowance and rate
limits). Limits, the set of available free models, and the free tier itself
may change or be withdrawn at any time.

For real work, the paid **Eigenwelt Model API** uses prepaid organization
credits and API keys owned by your firm, with zero prompt retention at the
gateway: we record only token counts, the model used, cost, and timestamps —
never prompt or output content.

## 4. Usage analytics (PostHog) — off unless you turn it on

To understand which features are used and to improve the product, the App can
send **anonymous product-usage analytics** to [PostHog](https://posthog.com), our
analytics provider. LegalWork uses PostHog's EU ingestion endpoint.

**This is off by default.** The App sends analytics only after you explicitly
enable **Settings → Privacy → "Share anonymous usage data."** You can turn it off
again at any time in the same place. Turning it off stops analytics network
requests.

What is sent when analytics is on:

- Event names, counts, durations, and lengths (for example, that a task ran and
  how long it took).
- Coarse, non-identifying context such as app version, operating-system platform,
  and the type of workspace or the provider/model identifier you used.
- An anonymous, randomly generated device identifier.

What is **never** sent to analytics:

- Your messages, prompts, or chat content.
- Your documents, file paths, or file contents.
- Your code, matter data, or any work product.

The only exception is text you type directly into an explicit in-app survey field
(for example, an onboarding "how did you hear about us?" question); that answer is
sent because you entered it for that purpose. Analytics is fire-and-forget and
never blocks or slows the App.

## 5. License

The LegalWork source code is made available under the license described in the
[`LICENSE`](./LICENSE) file. These Terms govern your use of the official App
builds we distribute and do not limit any rights granted to you under the
open-source license.

## 6. Acceptable use

You agree to use the App lawfully and in accordance with your own professional and
ethical obligations. You are responsible for the matters and data you process with
the App, including any duties of confidentiality, privilege, and data protection
that apply to them. Do not use the App to violate the rights of others or any
applicable law.

## 7. No legal advice

LegalWork is a software tool that assists with legal work. It does not provide
legal advice, and it is not a substitute for the professional judgment of a
qualified lawyer. AI models can produce incorrect or incomplete output. You are
responsible for reviewing and verifying any output before relying on it.

## 8. No warranty

The App is provided "as is" and "as available", without warranty of any kind,
express or implied, including warranties of merchantability, fitness for a
particular purpose, and non-infringement. We do not warrant that the App will be
uninterrupted, error-free, or that any output will be accurate or fit for your
purpose.

## 9. Limitation of liability

To the maximum extent permitted by law, Eigenwelt Labs will not be liable for any
indirect, incidental, special, consequential, or punitive damages, or for any loss
of data, profits, or business, arising out of or in connection with your use of
the App. Nothing in these Terms excludes liability that cannot be excluded under
applicable law.

## 10. Changes to these Terms

We may update these Terms from time to time. When we do, we will update the "Last
updated" date above. Material changes to how usage analytics or the free models
work will be reflected here. Your continued use of the App after an update means you accept the
revised Terms.

## 11. Governing law

These Terms are governed by the laws of Germany, without regard to conflict-of-law
rules. The courts of Berlin, Germany have jurisdiction over any dispute, to the
extent permitted by applicable law.

## 12. Contact

Questions about these Terms or about analytics:

- Web: https://eigenweltlabs.com/contact
- Email: chris@eigenweltlabs.com
