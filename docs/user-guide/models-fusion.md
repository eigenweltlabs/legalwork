# Models and Fusion

Open in LegalWork: [AI Providers](legalwork://app/settings/ai), [Tabular Review settings](legalwork://app/settings/tabular-review).

## Web search

Ask the assistant to search the web in a chat. Search follows the chat's web permissions and network settings. Opening a result's complete page is a separate web request and follows those settings too.

With an entitled paid LegalWork account, searches use AWS Web Search in the **United States** through the existing Eigenwelt gateway in **Europe**. Selecting a chat model hosted in the EU does not move web search into the EU. This is not a US-only or EU-only processing route. Search costs **€0.01 per completed search**, including searches without matches, and uses the account's existing AI allowance or prepaid usage. Standalone Jev API keys cannot use paid search.

Free and lapsed accounts continue to use free Exa search. No separate AWS or Exa key is needed. Paid-search failures and usage limits are reported in the chat; they do not silently send the query to Exa. Check your account connection or request more usage when prompted.

Paid searches accept up to **200 characters per query**. The assistant must reformulate longer searches instead of truncating legal citations. Results include excerpts and source links; ask the assistant to open the relevant sources when excerpts omit an important passage. Search processing does not change the app's saved chat history or the destination website's handling of a subsequent page read.

## Connect and select a model

Open **Settings > AI Providers**, choose the connection action, then follow the provider's supported sign-in or API-key flow. The provider catalog includes hosted services and OpenAI-compatible custom endpoints. For a local service such as Ollama, install and start that service, make the intended model available, and configure its endpoint/model through the local provider flow.

For ChatGPT, choose **Add provider > Continue with ChatGPT**, complete sign-in in your browser, and keep LegalWork open until its connection dialog closes. This also applies when an OpenAI API key or firm connection is already listed. After sign-in, open the chat's model picker to choose an available OpenAI model. The connection is available across local projects; project-specific model restrictions still apply.

Select a connected model using the chat's model picker. Search by model or provider. Disabling a provider in the picker hides its models from selection; disconnecting its credentials is a separate settings action. A model listed by a provider may still be unavailable to your account, region or quota. Use the actual provider error to diagnose this.

When no chat model has been selected yet, connecting your first provider selects its available default model automatically, including during onboarding. Onboarding continues to the remaining setup steps without opening the chat's model picker. You can change the model in the chat's model picker after setup. An existing available selection is kept. If Azure discovery replaces catalog model IDs with deployment names, the selection follows an available deployment from the same provider.

If a provider is connected but no model is selected, the Home composer shows **Select model**, which opens the model picker. **Connect a model provider** appears when no provider is connected.

For Azure, open **Settings > AI Providers > Add provider**, choose **Azure**, and enter your resource name and API key. LegalWork discovers the resource's deployments automatically; choose the deployment name in the chat's model picker. You do not need to enter model definitions yourself. A model marked deprecated in the public catalog can still appear when Azure reports a matching deployment. Deprecation does not extend Azure's retirement date or guarantee continued access.

After adding a deployment, reconnect Azure to reload its deployment list. If discovery fails, the provider can show its general catalog instead of your resource's deployments. Check the resource name, key, network access and Azure firewall rules before retrying. Switching accounts loads the new account's deployments.

Choosing a model in a regular chat also sets the default for new regular chats.
Existing chats keep their own selections. The personal Assistant has its own
model and thinking effort under **Customize assistant > Advanced**; regular chat
choices do not change them. See [Personal Assistant](assistant.md).

When upgrading from the earlier engine, LegalWork keeps custom providers and their selected models. You do not need to recreate a provider. Models you excluded from that provider stay excluded from the project's model selection.

Team AI Connectors can limit which models are available. LegalWork starts with those limits in place; your team does not need to choose **All Models**. Only models allowed by both the team and your project's selection remain available. If a saved chat uses an excluded model, choose an allowed model in its model picker. Other permitted connections remain available. If no models remain on a connection, ask your team administrator to check its allowed models or use another permitted connection.

Older Azure Cognitive Services and Google Vertex Anthropic settings move to **Azure** and **Google Vertex**. Saved endpoints, API keys in those settings, selected models and provider restrictions carry forward. This also repairs settings already transferred by an earlier upgrade. Choose the connected model in the chat's model picker after upgrading.

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
