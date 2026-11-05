# Models and Fusion

Open in LegalWork: [AI Providers](legalwork://app/settings/ai), [Tabular Review settings](legalwork://app/settings/tabular-review).

## Connect and select a model

Open **Settings > AI Providers**, choose the connection action, then follow the provider's supported sign-in or API-key flow. The provider catalog includes hosted services and OpenAI-compatible custom endpoints. For a local service such as Ollama, install and start that service, make the intended model available, and configure its endpoint/model through the local provider flow.

For ChatGPT, choose **Add provider > Continue with ChatGPT**, complete sign-in in your browser, and keep LegalWork open until its connection dialog closes. This also applies when an OpenAI API key or firm connection is already listed. After sign-in, open the chat's model picker to choose an available OpenAI model. The connection is available across local projects; project-specific model restrictions still apply.

Select a connected model using the chat's model picker. Search by model or provider. Disabling a provider in the picker hides its models from selection; disconnecting its credentials is a separate settings action. A model listed by a provider may still be unavailable to your account, region or quota. Use the actual provider error to diagnose this.

Choosing a model in a regular chat also sets the default for new regular chats.
Existing chats keep their own selections. The personal Assistant has its own
model and thinking effort under **Customize assistant > Advanced**; regular chat
choices do not change them. See [Personal Assistant](assistant.md).

When upgrading from the earlier engine, LegalWork keeps custom providers and their selected models. You do not need to recreate a provider. Models you excluded from that provider stay excluded from the project's model selection.

Keys can originate from a settings connection, environment variables or managed configuration. The AI Providers page identifies their source. An environment-managed connection may not be removable through the ordinary disconnect button; change it at the source instead. Store service secrets under **Settings > Secrets** when the relevant integration needs environment variables. Never paste a secret into a prompt as a setup shortcut.

## Model behavior

Reasoning and other model behavior controls depend on the selected model. Only use the options the picker actually exposes. Increasing reasoning can increase latency and usage. Changing the selected model does not install a missing connector, authorize a folder or enable a native capability.

**Settings > Personalisation** controls custom instructions, response personality and legacy memory cleanup. These are distinct from choosing a model. See [Settings and privacy](settings-privacy.md).

## Fusion

Fusion asks additional models for candidate answers and lets the main agent synthesize their work. Use the **Fusion** control beside the composer to enable it and select up to three candidate models. Configure default choices through the Fusion settings associated with AI Providers. The main conversation model remains responsible for the final answer.

Fusion is intended for substantial work; ordinary follow-ups may stay with the main agent. With no Fusion models selected, the app reports the missing setup and sends the message normally. Multiple candidate runs can increase time and cost. This documentation makes no universal accuracy or cost-savings guarantee: evaluate the result for your task.

## Data and usage

When upgrading from v1, LegalWork transfers saved provider logins and API keys into its current connection store, including when it creates a new chat database. Existing connections are kept, and disconnecting an imported account prevents it from being imported again on restart. An expired or revoked credential still needs to be renewed in **Settings > AI Providers**.

An authentication error belongs to the provider selected for that request. A custom provider rejecting its API key does not require you to sign into your Eigenwelt account again.

Requests are sent to the model provider you select. Connecting a local model can keep model inference local, but connected services and other tools can still make network requests. Account access, subscription entitlements and provider credentials are separate sources of availability. **Settings > Account** shows the signed-in firm's plan and usage; external provider billing is governed by that provider.

## Document recognition and review models

In builds exposing **Document recognition providers (OCR)** under AI Providers, choose how scanned pages and images are read. Download the offered local model before using it, or configure a supported custom provider with its endpoint, model and credentials. Test the connection with the supplied sample, then check the selected default. Provider choice determines whether document images leave the computer. A chat-model change does not automatically change OCR.

The separate local layout model identifies page regions and reading order where supported. Inspect its download/error state as well as OCR readiness. Recognition and layout can be incomplete independently; neither guarantees correct handwriting or table reconstruction. See [Tabular Review](reviews.md) for how this affects evidence.

Newer AI Providers pages also expose JEV/SystemOne models for structured review questions. They are separate from chat providers. Managed Eigenwelt models depend on firm subscription, region permission and model enablement. A custom JEV-compatible provider uses its own endpoint/key and available model IDs. Test the intended model and check its status. Review defaults belong under **Settings > Tabular Review**; saved reviews retain their own selection.

Related: [Evaluations](evaluations.md), [Integrations](integrations.md), [Troubleshooting](troubleshooting.md).
