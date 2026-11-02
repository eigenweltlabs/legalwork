# Integrations

Open in LegalWork: [Integrations](legalwork://app/settings/extensions).

## Find and connect a service

Open **Settings > Integrations**. Browse **Popular**, **Communication**, **Files & storage**, **Legal databases**, **Practice management** and **Research & productivity**, or use **Search integrations**. Select a category to see its complete list. The categories describe what a connection helps you do. Small tags on connector rows and detail pages show how they work: **Skill**, **MCP**, **Integration API**, **File Storage Integration** or **Website Login**. A connection can have more than one tag. A badge such as **1 connection** or **2 connections** shows how many saved connections you already have for that provider. The detail page says **No connections yet** when none have been added. Website entries show **1 saved login** or **2 saved logins**. This counts saved accounts, not verified sign-in.

Select a connector to open its detail page and choose **Connect**. To set up a connection directly from the catalogue, use the **+** beside it. This starts sign-in or opens the setup dialog while keeping the catalogue in place. Complete the requested sign-in or setup. Some services open a browser; others ask for a key, server address or username and password. Website Login entries let you save your own logins for the in-app browser.

Saved connections appear under **Installed** on the left. Named storage connections and saved website accounts stay in this list; the browse categories show their general providers with a connection count. Select an installed connection to inspect it, choose **Manage** to change its settings, or use its remove button. The detail page puts **Firm managed** or **My own** beside the name, followed by status, ownership and access information. File sources are labeled **File Storage Integration**. Choose **Manage** for account, reconnect and disconnect controls. Firm-managed connections retain the access rules set by your firm.

File sources and saved website logins support multiple named connections. Choose **Add another connection** for file sources or **Save another login** for websites, or add the same provider again from the catalogue. Give each entry a distinct name. Each has its own settings and removal action. The general provider page lists saved instances under **Your connections**, or **Your saved logins** for websites; an individual entry page shows only that entry. Connected cloud drives also offer **Add folder view** to create named locations within the existing account. Native account services retain the account choices supported by that service; a folder view does not create a second sign-in.

For a service outside the catalogue, choose **Add > Custom connection** and enter the connection details supplied by the provider. Choose **Add > Import connection** for a supported package or repository, review the requested access, and complete any remaining setup. Removing an imported connection package also removes its included capabilities from the shared library. Existing projects use the updated library.

The chat tool picker has three groups: **Workflows**, **Skills** and **Integrations**. Integrations combines installed packages, MCP connections, signed-in app accounts, named file storage, website logins and installed firm connections in one list. Select any integration to insert its chip into your message. The chip tells the agent which connection to use and stays visible inline in the sent message. Use **Configure** to manage items in the matching library.

Reusable instructions live under **Workflows > Skills**. The Workflows page also has **Workflows** and **Review prompts** tabs.

Removing a connection can take a moment. **Removing…** and a spinner remain visible until it finishes; the removal and cancel buttons are disabled to prevent repeated requests. If removal fails, the connection remains available and an error is shown.

## SharePoint and Dropbox connection methods

SharePoint and Dropbox each have one provider entry in **Files & storage**. Use **+** or open the provider and choose **Connect**. In **Connection method**, keep **Connect with LegalWork** to use the app's standard sign-in. Choose **Custom SharePoint** or **Custom Dropbox** to configure the separate connection with your own app details. Existing custom connections remain in **Installed** with those names.

For Dropbox, give the file connection a name, choose its folder and access, then choose **Connect Dropbox**. Complete the sign-in in the browser. The setup dialog stays open until Dropbox confirms sign-in. Cancelling or failing a new sign-in removes the unfinished connection; it is not reported as a completed connection. An existing account that needs sign-in is marked **Sign in to use it** on its detail page.

## Research databases

The **Save logins for the in-app browser** welcome screen lets you save your own accounts for common legal research websites, including beck-online, juris, Lexis and Westlaw. Use these logins to stay signed in in the in-app browser. Browser use allows your agent to use these websites too. The Website Login entries are shortcuts for your saved browser logins. Country suggestions cover the EU, UK and US. They are a starting list, not a guarantee that your subscription covers a particular matter or jurisdiction.

1. Open **Settings > Integrations > Legal databases**. Search for your provider, including **beck-online**, **juris**, **Libra**, **Lexis** or **Westlaw**.
2. Select the website and choose **Save login**. Give the login a name, enter your username and password, then choose **Save login**. If the provider has no preset sign-in address, enter its current sign-in website.
3. For any other website, choose **Add > Website Login** and enter its website and sign-in URL as well as your account details. Give each login a name so you can distinguish multiple accounts.
4. Find the saved login under **Installed**. Open it and choose **Manage** to rename it or change credentials. Leave the password blank to keep the saved password. **Save another login** saves a separate named account. The website detail page lists these under **Your saved logins**. Removing a saved login also removes all website destinations linked to that login.
5. Ask, for example, “Research this question in beck-online and cite the relevant judgments.” Complete any MFA, CAPTCHA or institutional sign-in in the visible browser when requested. Saving a login does not verify your subscription or sign-in.

The welcome screen offers country suggestions and lets you save logins for several websites. All these paths use the same saved logins across projects.

You can also ask in any chat: “Set up CourtListener for your legal research.” For a known provider, the assistant opens the same **Sign-in details needed** card directly, with the saved provider address. Enter your credentials or choose **Continue with saved login**. It then checks access in the browser. This also works for any other website: provide its sign-in URL, or the assistant asks you for it, then shows the same card directly.

Press **Stop** in the chat to cancel a pending sign-in card, including one that is still opening.

Website logins use LegalWork's existing encrypted vault. Onboarding, the chat sign-in card and **Settings > Secrets > Browser passwords** all save to this same store, available across your chats on this installation. Manage these logins from their integration detail pages or from Secrets. Each entry has its sign-in website and can link several destinations, for example two services using the same sign-in account. Destination URLs do not expand where a password can be filled.

Saving a login does not install a plugin or create a site-specific skill. The built-in **legal-research** skill is available in every project. For legal research, the assistant discovers saved websites, selects suitable research sources, and uses a site-specific skill if one is installed. Otherwise it uses the observed website controls. The country list only helps fill in provider URLs. A normal website and a research database use exactly the same login mechanism.

The general research skill keeps persistent operational notes for each connected website: observed problems, attempted steps and verified recoveries. These notes help later chats, but must be checked against the current website. They contain no account details, credentials, raw page text or legal findings. Ask the assistant to show or forget a site's notes. Existing optional site skills can also keep their own experience log. Notes do not change login permissions. Organization restrictions on custom skills can prevent saving new notes; the assistant reports that limitation.

**Libra (Wolters Kluwer)** is a suggested provider. Ask “Set up Libra” for its secure login card, or select it during onboarding. LegalWork opens `app.libratech.ai` to start sign-in; the saved sign-in domain is `auth.libratech.ai`. For research, the bundled **libra-research** skill submits your question to Libra's agent chat, checks for completion in waits of up to 30 seconds, and stops after five minutes unless you set another limit. It preserves the conversation on timeout so you can ask it to check again without submitting the task twice. Completed answers are reviewed with their cited sources. Source collections depend on your Libra subscription and add-ons. See [Libra's source coverage](https://libratech.ai/product/legal-content).

Research findings belong in **Legal Research** or **Rechtliche Recherche**, which LegalWork prepares automatically. The assistant first asks whether you want the identified legal findings prepared for your knowledge base. After your consent it stages legal knowledge only, with citations and classification by jurisdiction, area of law and issue. Review the proposed contribution and choose **Save to wiki** to publish. Website mechanics, workflows and login fixes stay outside this wiki. See [the wiki guide](wiki.md).

If sign-in redirects between subdomains of the same main domain, your login remains available. If the provider uses a separate main domain, save the login for the actual password page. Setup does not prove the login works: the assistant checks access in the browser during research. Complete MFA, CAPTCHA or institutional sign-in there when needed. For a free account test, choose **United States > CourtListener**; its sign-in supports a free username/password account. Some separate document services may charge for retrieval, so a free account does not imply every linked source is free.

## LegalMemory and firm knowledge

LegalMemory is a separate Eigenwelt knowledge index. Connect the firm's instance using its connector when available. Search its live records for matters, documents and other firm knowledge; inspect the returned source evidence. Connecting ordinary file storage does not automatically create a LegalMemory index.

A disconnected connector's historical output, old chats or runtime caches are not substitutes for the live source. If the firm has not connected LegalMemory, use the source the user identifies or the available connected storage. A failed search is not evidence that the matter does not exist everywhere.

## Google Workspace and other services

Upgrading the engine carries over completed MCP connector sign-ins, including those used by LegalMemory browsing and downloads. A newer sign-in already saved in the app takes precedence, and disconnecting afterward stays disconnected. A sign-in that was never completed, or that the service has expired or revoked, may still require signing in again through the connector's card.

For Gmail and Outlook setup, connection methods, write permissions and troubleshooting, read [Email setup](email.md). The native catalog also includes Google Calendar, Outlook Calendar, Google Drive, OneDrive and SharePoint. Each connector has its own supported operations and write-access setting. Outlook Email and Calendar share an account but activate separately.

For a new Microsoft connection, open **Settings > Integrations**, use **Communication** for email and calendars or **Files & storage** for drives, select **Outlook Email**, **Outlook Calendar**, **OneDrive**, **OneDrive Personal** or **SharePoint**, then select its **Connect** button and complete Microsoft sign-in. LegalWork supplies the app configuration; an Eigenwelt account, Nango and a client secret are not required. Keep **Allow write access** off for a read-only connection. For SharePoint, choose the document library when prompted. A work or school administrator may need to approve access. Saved custom app settings and older managed connections retain their existing method; [Email setup](email.md) explains how to switch.

Connecting a calendar service lets the assistant use that service's available tools. It does not automatically import those events into LegalWork's project Calendar. Connecting a drive does not establish mail access. Check the individual connector's status and granted permissions.

## Browser and Computer Use

The built-in browser opens websites in a browser panel. Ask the assistant to open a URL and inspect the page with the browser tools. Opening or reconnecting a tab gives the assistant a page observation it can use directly for searches, forms, links and other interactions. It can perform known steps together, then inspect the result; a new page or an unexpected result requires another observation. For saved website passwords, use **Settings > Secrets > Browser passwords**; see [browser password setup and limits](settings-privacy.md#browser-passwords). Filling uses the existing tab. Background task tabs remain available after the assistant finishes, so you can reopen them from their chat cards or continue in the same tab on a follow-up. Close a tab when you no longer need it. Website sign-ins, downloads and site permissions are separate from LegalWork model-provider sign-in. Inspect the returned file location after downloading.

Computer Use controls desktop applications and is configured from its integration card. The built-in desktop integration in this build targets macOS and requires Accessibility and Screen Recording permissions. Use its setup/test controls to confirm readiness. For LegalWork's own navigation, prefer the app's UI action tools so the assistant can open settings or sessions directly. Browser automation is for web content, not an assumption that LegalWork's native controls are a website.

Additional integrations, including media capabilities, depend on installed packages and their credentials. The live catalog and returned tool descriptions are authoritative for those tools.

Related: [Storage](connected-storage.md), [Skills](skills-workflows.md), [Audio](audio.md), [Feature availability](feature-availability.md).

### Copy an example

Connector detail pages show practical example requests for file storage, email, calendars and website logins. Click an example on the watercolor panel to copy it, then paste it into a chat. A **Copied** confirmation appears after copying. Examples follow the app language, including both the displayed text and the copied request. The requests name the selected connection without assuming particular files or matters exist. Your account, subscription and permitted access determine which documents are available.

**Eigenwelt Extensions** groups LegalMemory, Open Computer Use and LegalWork UI Control. Box is under **Files & storage**. Use the separate Gmail, Google Calendar and Google Drive entries for Google services.
