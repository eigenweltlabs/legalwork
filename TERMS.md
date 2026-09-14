# LegalWork — Terms & Conditions

**Last updated: 11 September 2026**

LegalWork is a local-first desktop application published by **Eigenwelt Labs**,
operated by Poensgen Technology UG (haftungsbeschränkt), Berlin, Germany
("Eigenwelt", "we", "us"). These Terms & Conditions ("Terms") govern your use of
the LegalWork desktop application and its official builds (the "App"). By
installing or using the App, you agree to these Terms. If you do not agree, do
not use the App.

The authoritative, current version is published at
<https://eigenweltlabs.com/legalwork/terms>, together with the
[privacy notice](https://eigenweltlabs.com/legalwork/privacy). This file is the
same document kept with the source; if the two ever differ, the published
version governs.

The hosted Eigenwelt Plus service — subscriptions, the Eigenwelt models, and the
Knowledge Hub — has [separate terms](https://eigenweltlabs.com/eigenwelt-plus/terms).

## 1. What LegalWork is

LegalWork is a desktop "cowork" application for legal work — document review,
drafting, recordings, transcription and related tasks. It runs on your own
computer. Beyond reading your files, the App can create and directly edit
documents, spreadsheets and presentations in your workspace, including tracked
changes in Word documents.

You choose the AI model: run open-source models locally, connect a hosted model
using your own API keys, or sign in with an Eigenwelt Plus subscription
(Section 4). The App itself is free. Enterprise deployment and the Eigenwelt
continual-learning training platform are offered separately under a commercial
agreement.

## 2. Your data stays local

The App is local-first. Your documents, prompts, drafts, file contents,
recordings and the results of your tasks are stored and processed on your own
device. We do not receive them merely because you use the App.

When you connect a third-party model provider (for example with your own API
key), the content you choose to send for inference is transmitted to that
provider so it can generate a response. That exchange is governed by **your**
agreement with that provider, not by these Terms. You are responsible for
choosing providers appropriate for your confidentiality and professional
obligations. If you run a model locally, no inference content leaves your device.

Three features send content somewhere beyond ordinary inference. None of them
operates until you turn it on:

- **Voice Mode** requires a connected OpenAI provider. While it runs, your
  microphone audio streams continuously to OpenAI's Realtime API, and an excerpt
  of the current chat is sent with it as context so the voice model can follow
  the conversation. The voice model can also call tools that act on your
  workspace. This runs under your own agreement with OpenAI; Eigenwelt receives
  neither the audio nor the chat excerpt.
- **Connected services** (MCP connectors and integrations) transmit the content
  you or the agent direct to them to that provider, under its own terms.
  Eigenwelt is not a party to that exchange.
- **LegalMemory**, when connected, returns documents and citations from the
  appliance into your workspace, and from there into the requests sent to
  whichever model you selected. Where you run the appliance yourself, Eigenwelt
  receives nothing in the process.

Files you attach to a chat are written into your workspace on disk and stay
there independently of the conversation: deleting a chat does not delete the
file.

Custom instructions and the App's local memory are stored on your device.
Because both are added to the system prompt, their contents form part of every
request sent to the model provider you have chosen. Settings → Personalisation
controls whether the agent may derive memory from tool, web and MCP results, and
can delete all local memory.

## 3. Recording

The recorder can capture the microphone and system audio. Capture,
transcription and the models used for it run entirely on your device — audio and
transcripts are not uploaded, including to us. Transcription models unlocked on a
paid plan are also local models; the subscription only governs which of them you
can download.

Because system audio also captures the other people in a conversation, you are
responsible for obtaining the consents required and for complying with
applicable law on recording speech (in Germany, in particular § 201 StGB), and
for having a data-protection basis covering the people recorded. The same
applies to Voice Mode.

## 4. Eigenwelt models

The Eigenwelt models are available through an Eigenwelt Plus subscription, set
up in the App under "Sign in with Eigenwelt". The subscription, its included
usage allowance and the free trial are governed by the
[Eigenwelt Plus Terms](https://eigenweltlabs.com/eigenwelt-plus/terms). Which
models you can use is decided by an administrator of your firm.

The paid gateway does not store prompt or output content and keeps only
content-free metering data — model, token counts, cost, status and timestamps.
Our inference providers apply zero data retention by default and do not train on
your content.

This includes the Gemini models served through Google Cloud (Vertex AI), in the
EU region as well as the US one: Google has switched off abuse-monitoring logging
for Eigenwelt, so prompts sent to these models are not logged or retained for
abuse monitoring either.

### Free Eigenwelt models (closed to new users)

The free evaluation gateway is no longer offered to new users; current builds set
up an Eigenwelt Plus subscription instead. Where access still exists — an older
installation, or a device key already issued — the following continues to apply
unchanged. **The free gateway is not zero-retention:** prompts, responses, model
and usage details may be logged. Do not use it with personal, privileged, client
or matter data. The App shows a notice when a free model is in use. The free
service is subject to per-device, per-IP, rate and global limits, and may change
or be withdrawn at any time.

## 5. Office add-ins

You can install an add-in that makes LegalWork available inside Word, Excel and
PowerPoint. Installing it places the add-in manifest in your Office installation
and sets up a locally trusted certificate for the local HTTPS connection over
which the add-in talks to the App on your device. Both are removed when you
uninstall it. The add-in communicates only with the LegalWork application running
locally; no data leaves your device for it to work. Installation may require
administrator rights and a restart of the Office applications.

## 6. Usage analytics (PostHog)

To understand which features are used and to improve the product, the App can
send **anonymous, content-free product analytics** to
[PostHog](https://posthog.com), using PostHog's EU Cloud in Frankfurt.

This option is shown on the welcome screen when you first set up the App; nothing
is sent before you complete that screen. You can turn it off at any time in
**Settings → Privacy → "Share anonymous usage data,"** which takes effect
immediately. Development builds (`pnpm dev`) send nothing.

What is sent when analytics is on:

- Event names, counts and durations (for example, that a task ran and how long it
  took).
- Coarse context such as app version, operating-system platform, and the provider
  or model identifier you used.
- Onboarding-flow events, including microphone and system-audio permission
  prompts and model downloads; Office add-in installation; connecting and
  disconnecting a connector, together with which connector it was; and changes to
  tool and permission toggles.
- Error and crash events: an error name from a fixed list, a hash used to group
  similar errors, the component affected, a status code, and the surface the
  error occurred on. These are produced from a fixed schema rather than extracted
  from error text, which is how the guarantee below is kept.
- A random identifier, new on every app start and never stored on your device,
  plus a machine-generated task id used to group the events of one task.
- Where the App is used from, no finer than city level (derived from the request
  IP, which is not stored).

What is **never** sent to analytics:

- Your messages, prompts, or chat content.
- Your documents, file paths, or file contents.
- Your code, matter data, recordings, or any work product.

Analytics never blocks or slows the App. Details on the legal basis, retention
and your rights are in the
[privacy notice](https://eigenweltlabs.com/legalwork/privacy).

## 7. License and output

The LegalWork source code is made available under the license described in the
[`LICENSE`](./LICENSE) file. These Terms govern your use of the official App
builds we distribute and do not limit any rights granted to you under the
open-source license. To the extent permitted by law, you retain your rights in
your inputs and own the output you generate. AI output may not be unique.

## 8. Acceptable use

You agree to use the App lawfully and in accordance with your own professional
and ethical obligations. You are responsible for the matters and data you process
with the App, including any duties of confidentiality, privilege and data
protection that apply to them. Do not use the App to violate the rights of others
or any applicable law.

## 9. No legal advice

LegalWork is a software tool that assists with legal work. It does not provide
legal advice, and it is not a substitute for the professional judgment of a
qualified lawyer. AI models can produce incorrect, incomplete or outdated output.
You are responsible for reviewing and verifying any output, citation or work
product before relying on it or sharing it. This applies expressly to changes the
agent makes to existing files: review them before the file is used or shared.

## 10. No warranty

The App is provided "as is" and "as available", without warranty of any kind,
express or implied, including warranties of merchantability, fitness for a
particular purpose, and non-infringement. We do not warrant that the App will be
uninterrupted, error-free, or that any output will be accurate or fit for your
purpose.

## 11. Limitation of liability

Nothing in these Terms limits liability for intent, gross negligence, injury to
life, body or health, an expressly assumed guarantee, or any liability that
cannot be limited under applicable law. For slight negligence we are liable only
for breach of a material contractual obligation, and only for the foreseeable
damage typical of this agreement. Otherwise, and to the maximum extent permitted
by law, Eigenwelt Labs will not be liable for any indirect, incidental, special,
consequential or punitive damages, or for any loss of data, profits or business,
arising out of or in connection with your use of the App.

## 12. Changes to these Terms

We may update these Terms from time to time with effect for the future, and will
update the "Last updated" date above. Material changes to how usage analytics,
the Eigenwelt models or the features in Section 2 work will be reflected here.
Your continued use of the App after an update means you accept the revised Terms.

## 13. Governing law

These Terms are governed by the laws of Germany, without regard to conflict-of-law
rules. The courts of Berlin, Germany have jurisdiction over any dispute, to the
extent permitted by applicable law.

## 14. Contact

Questions about these Terms, the models, or analytics:

- Web: https://eigenweltlabs.com/contact
- Email: chris@eigenweltlabs.com
