# Models and Fusion

Open in LegalWork: [AI Providers](legalwork://app/settings/ai), [Tabular Review settings](legalwork://app/settings/tabular-review).

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

## Choose an Eigenwelt plan or use your own AI

During setup, **Use LegalWork for free** appears above the three paid plans: **Plus**, **Pro** and **Max**. Choose **I bring my own model** to connect your own AI subscription, API key or local model; your provider bills its usage separately.

All three paid plans include collaboration and hosted AI. Per seat, Plus includes €30 of monthly AI usage, Pro €100 and Max €210. The monthly subscription prices are €40, €100 and €200. With yearly billing, the monthly equivalents are €30, €90 and €190, charged as €360, €1,080 and €2,280 per seat per year. Subscription prices exclude VAT.

The comparison keeps subscription prices, included usage, trial buttons and a short feature list visible together. Choose **View all features** on any card to open its full list, including team sync for Tasks, Workflows and files, matter management, Word and Excel add-ins, and Outlook integration. Pro and Max also include the admin dashboard and priority support. Close the details dialog to return to the comparison; your billing choice is kept. Smaller windows and mobile screens allow scrolling as needed.

Use **Yearly** or **Monthly** above the plan cards to compare subscription prices. Each card shows its **Included AI usage** in a separate block; this monthly allowance stays the same for either billing period. Your chosen billing period carries into the plan review, where you can adjust it and see the total before checkout. In German, all three full feature lists also include **Verschwiegenheitsvereinbarung nach § 203 StGB**.

Select a plan to review the billing period, seat count and total before opening checkout. In the German interface, the count is labeled **Nutzer**; use **Nutzer hinzufügen** or **Nutzer entfernen** to adjust it. The first eligible subscription offers seven days for a separate €1 trial fee, with €30 of AI usage for one user on any plan. Inviting a teammate requires starting the paid subscription early. Availability is confirmed in checkout. Existing subscriptions retain their current prices, usage limits, custom grants and access; trials already started keep their original allowance. New Plus subscriptions use EU models by default; model administration, shared storage administration, firm policies and custom usage controls require Pro or Max. Billing and paid teammate invitations remain available on Plus. Existing Sync subscriptions remain recognized; Sync is no longer offered as a new plan. Open **Settings > Account** to review your current firm and manage its subscription.

When your firm changes from Plus to Pro, **Settings > Account** receives the new plan and included usage on the next account refresh. Usage already consumed in the current period still counts toward the new allowance. A higher custom allowance is kept. Updating the app brings the latest plan descriptions and support for Max.

## Model behavior

Reasoning and other model behavior controls depend on the selected model. Only use the options the picker actually exposes. Increasing reasoning can increase latency and usage. Changing the selected model does not install a missing connector, authorize a folder or enable a native capability.

**Settings > Personalisation** controls custom instructions, response personality and legacy memory cleanup. These are distinct from choosing a model. See [Settings and privacy](settings-privacy.md).

## Fusion

Fusion asks additional models for candidate answers and lets the main agent synthesize their work. Use the **Fusion** control beside the composer to enable it and select up to three candidate models. Configure default choices through the Fusion settings associated with AI Providers. The main conversation model remains responsible for the final answer.

Fusion is intended for substantial work; ordinary follow-ups may stay with the main agent. With no Fusion models selected, the app reports the missing setup and sends the message normally. Multiple candidate runs can increase time and cost. This documentation makes no universal accuracy or cost-savings guarantee: evaluate the result for your task.

## Data and usage

When upgrading from v1, LegalWork transfers saved provider logins and API keys into its current connection store, including when it creates a new chat database. Existing connections are kept, and disconnecting an imported account prevents it from being imported again on restart. An expired or revoked credential still needs to be renewed in **Settings > AI Providers**.

Saved **Azure Cognitive Services** and **Google Vertex Anthropic** connections transfer to **Azure** and **Google Vertex**, including their separately saved keys and sign-ins. If you saved connections under both the older and current names, LegalWork keeps the connection under the current name.

An authentication error belongs to the provider selected for that request. A custom provider rejecting its API key does not require you to sign into your Eigenwelt account again.

Requests are sent to the model provider you select. Connecting a local model can keep model inference local, but connected services and other tools can still make network requests. Account access, subscription entitlements and provider credentials are separate sources of availability. **Settings > Account** shows the signed-in firm's plan and usage; external provider billing is governed by that provider.

## Document recognition and review models

In builds exposing **Document recognition providers (OCR)** under AI Providers, choose how scanned pages and images are read. Download the offered local model before using it, or configure a supported custom provider with its endpoint, model and credentials. Test the connection with the supplied sample, then check the selected default. Provider choice determines whether document images leave the computer. A chat-model change does not automatically change OCR.

The Windows desktop app includes the runtime dependencies for its fast local OCR engine. You do not need to install Python, Visual Studio, or a separate Visual C++ runtime package. Download the recognition model from this settings page before using local OCR.

**Higher quality · Local** is an optional download on Apple Silicon Macs and x64 Windows PCs. Open **Settings > AI Providers > Document recognition providers (OCR)**, open the actions menu for **Higher quality · Local**, and choose **Download model**. On Windows, the model and its runtime download about 1.85 GB; shared text and layout models are added only if missing. The size appears before download, and progress shows the current file's transferred bytes. Choose **Cancel** to stop. Choose **Download model** again to retry; completed, verified files are reused, including after an app restart. An interrupted file is downloaded again.

**Download local models automatically** covers the small model and shared layout model. It never starts the higher-quality model download, even if that model was previously selected. Downloading the higher-quality model does not change your default: after setup, use its actions menu to **Test sample**, then **Use as default** when you want it used for OCR. Windows ARM64 remains unsupported for the higher-quality model.

The separate local layout model identifies page regions and reading order where supported. Inspect its download/error state as well as OCR readiness. Recognition and layout can be incomplete independently; neither guarantees correct handwriting or table reconstruction. See [Tabular Review](reviews.md) for how this affects evidence.

Newer AI Providers pages also expose JEV/SystemOne models for structured review questions. They are separate from chat providers. Managed Eigenwelt models depend on firm subscription, region permission and model enablement. A custom JEV-compatible provider uses its own endpoint/key and available model IDs. Test the intended model and check its status. Review defaults belong under **Settings > Tabular Review**; saved reviews retain their own selection.

Related: [Evaluations](evaluations.md), [Integrations](integrations.md), [Troubleshooting](troubleshooting.md).
