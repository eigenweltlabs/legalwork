# Settings and privacy

Open in LegalWork: [Settings](legalwork://app/settings), [Customization](legalwork://app/settings/shell), [Privacy](legalwork://app/settings/preferences).

Open **Settings** using the gear at the bottom left, directly above your account button, or from the native app menu. The gear remains available when the sidebar is collapsed. The overview links to the active sections. The selected workspace matters for folder permissions; many other settings apply globally.

| Section | Purpose |
| --- | --- |
| Account | Eigenwelt firm sign-in, account/organization context, plan, usage and billing access. |
| AI Providers | Connect, inspect, replace or disconnect model credentials and configure model-related options. |
| Tabular Review | Default review mode, models and minimum answer probability for new reviews. |
| Recorder | Transcription models/source, language, dictation and meeting settings. See [Recorder settings](recorder-settings.md). |
| Office Add-ins | Install/manage the local Word, Excel and PowerPoint add-ins on supported desktops. |
| Integrations | Connected apps, file storage and website logins, with installed connections in the sidebar. Skills are under Workflows. |
| Personalisation | Custom instruction additions, response personality and deletion of legacy local memories. |
| Notifications | Task arrivals, due/overdue reminders, notification scope and system/badge delivery. |
| Tool Permissions | Which tool actions may proceed automatically or require approval, across workspaces. |
| Customization | App language, task suggestions and display of reasoning. Appearance, project defaults, branding and new-window choices depend on the build. |
| Secrets | Browser passwords and environment variables for services and integrations. |
| Privacy | Usage analytics and online model-catalog updates. |
| Updates | Version/channel, update checks, download and install/restart controls. |
| Permissions | Authorized folders and file access for the selected workspace. |

**Evaluations** and **Workflows** have main-sidebar entries. The separate Language/Appearance and Recovery routes are not normal sidebar sections in this build. Advanced and Debug screens are diagnostic surfaces; Debug is shown in developer mode. Old translation keys for cloud sections, theme controls or other screens do not establish a visible menu item.

## Account and firm-managed controls

Open **Account** to sign in, inspect the current firm, plan and usage, and open the available account/billing management action. A saved account can be reconnecting rather than fully disconnected. Use the displayed error and refresh controls before entering credentials again. If sign-out reports unsent project changes, resolve them first.

### Add usage credits

When a chat shows an Eigenwelt usage-limit message, organization administrators can choose **Add credits** if more prepaid funds can resolve the limit. Enter the amount of usable credits, then choose **Review total** for a saved card. Review **Usable credits**, **Tax**, and **Total charge** before selecting **Pay & add credits**. Stripe calculates applicable tax and adds it on top: for example, €100 of credits with 19% VAT costs €119 and adds €100 to the shared balance. Choose **Change amount** to edit the amount before paying.

Closing the dialog before confirming payment leaves your balance unchanged. The next top-up starts with a fresh amount and automatically replaces the earlier unconfirmed price. If a payment was already submitted, the app checks that payment first and shows its progress rather than charging you again. Use **Check payment status** while it is processing. If the card is declined, choose **Try again** to make a fresh attempt or select another payment method.

The saved card is charged directly after confirmation; complete any bank verification that is requested. Without a saved card, use the offered payment or card-setup action. **Use another payment method or promo code** opens Stripe Checkout for normal top-ups. Adding credits does not change the subscription or remove separate spending limits. Trial top-ups enable the explicitly requested extra usage only after verified payment, with limits based on usable credits.

If a price expires, review the amount again. Older LegalWork versions still charge saved cards directly, but treat the amount they confirm as the total including tax: a €100 payment with 19% VAT adds €84.03 of credits. Update LegalWork to select the usable credit amount and review tax added on top. A payment already submitted keeps its original agreed amounts.

Firm policies can supply models, connectors or settings and can lock individual controls. A disabled control with a firm-policy note requires an administrator change; replacing a personal key does not override it. Signing into the firm, connecting a personal model provider and signing into file storage are separate operations.

If your firm allows a provider that uses your own API key or sign-in, complete that connection in **Settings > AI Providers** before using its models. Being added by your administrator does not connect you. If your firm supplies the key, its models become available when that key is available; ask your administrator if it is missing.

## Access and secrets

Authorizing a folder allows the worker to access that location under its rules. Tool Permissions governs actions, not OS microphone, Accessibility or Screen Recording grants. Remote worker roles and provider permissions can impose additional restrictions. An approval in one layer does not override the others.

File access outside the project and its added folders requires approval before the agent can list, read or change those files. This also applies to helper agents. Choose **Allow once** for the current request, **Allow for this chat** to remember access for this chat and its subtasks, or **Deny** to refuse it. You can approve from the parent chat or a subtask: the same access then applies throughout that chat, including subtasks started later. Identical requests already waiting for that approval are resolved together. **Allow once** and **Deny** answer only the selected request. Approving a folder in chat does not add it to the project’s shared folders or grant access to other chats. To deliberately share a folder across the project, manage its authorized folders in **Settings > Permissions**. Stricter tool, agent and firm restrictions still apply.

Other permission requests also offer **Allow for this chat**. The approval stays with that chat after restarting LegalWork; a different chat must ask separately. **Allow once** remains temporary. Project-wide approvals saved previously remain project-wide until revoked; this change does not silently move or delete them. Changed tool or firm permissions can revoke earlier approvals; an approval never overrides a denial.

Existing chat-specific permissions remain limited to their original chat after an engine upgrade. Project permissions remain with their original project. If LegalWork reports that saved settings are missing or damaged, it pauses affected operations instead of resetting permissions. Restore the original LegalWork profile from a backup or contact support; deleting the saved settings is not a repair.

With **Sandboxing** off, commands follow your configured tool, chat and firm permissions without an additional computer-access prompt. In **Settings > Tool Permissions**, use **Ask before running computer commands** to choose whether commands require approval. With sandboxing off, a command can read and change files anywhere your computer account can access; turn on **Sandboxing** in **Settings > Tool Permissions** to confine commands to shared folders. Explicit access denials still apply. A shell approval remembers the exact command, not every command in the displayed project folder. Expand **Details** to review the command. For protected network requests, remembered approval applies to the exact request: changing its destination, headers or contents requires another approval. macOS or Windows can still deny access independently of LegalWork's approval.

Enter API keys and passwords in the relevant connection/Secrets form. Local connection credentials belong to this LegalWork installation; team-managed connections have their own access rules. Do not expose secrets in screenshots, chat examples or diagnostic reports. Changing environment/configuration can require an engine reload; wait for active work or use the app's offered controls.

Open **Settings > Secrets**. Use **Browser passwords > Add password** for website logins or **Environment variables > Add secret** for API keys and other service credentials. Both sections show a compact list and one add action. Expand **Storage and access** below the lists for how these values are stored and used. For an environment variable, enter the exact name expected by the integration and its value, then save. **Saved, not in use yet** means the running engine still needs the offered apply/reload action. Editing a stored value and applying it are distinct steps. If you use a separately operated LegalWork server, configure its integrations on that server.

### Browser passwords

Saved browser logins also work when you browse yourself. Click a username, email or password field on a matching website to see **Fill saved login**, then select an account. You can also press **Arrow Down** to enter the suggestions and **Enter** to select one. **Escape** dismisses the list. LegalWork fills the username and password without submitting the form. For a two-step sign-in, choose the account again on the password page. Suggestions use the same saved logins as Settings and Integrations and appear on top-level sign-in forms in visible local browser tabs. Embedded frames, password-creation fields and verification-code fields do not receive suggestions.

To save a login for any website from chat, give the assistant its sign-in URL and ask to set it up. It shows the secure **Sign-in details needed** card directly. For a known provider, its name is enough. If the URL is missing, the assistant asks you for it first. The card uses the same vault as this settings page. Browser verification happens after you save or select an existing login.

If the assistant reaches a sign-in page without a saved login, it can show **Sign-in details needed** inline in the conversation. Check the displayed website, enter your **Username** (optional) and **Password**, then choose **Save login and resume task**. The website comes from the browser tab and cannot be edited in this card. Your password goes directly to the same device vault as Settings; the assistant receives only the saved entry’s ID and metadata, then continues in the existing tab. Choose **Cancel** to stop the login attempt. Reloading the chat restores a pending request. If the login was already saved, choose **Resume task with saved login** without entering it again. You can later edit or delete it under **Settings > Secrets > Browser passwords**.

On the local desktop, open **Settings > Secrets > Browser passwords > Add password**. Enter a **Name**, the **Website** (a complete HTTPS address), an optional **Username**, and the **Password**, then choose **Save**. The main domain and its subdomains share the saved password. For example, `example.com`, `www.example.com` and `login.example.com` use the same entry. Scheme and port must still match; paths are ignored. Independently owned hosted sites, such as `a.github.io` and `b.github.io`, remain separate. HTTP is supported only for localhost development pages.

Saving one from any chat or onboarding makes it available across your chats on this installation. It does not create a skill or plugin. A research destination can be linked to the same login without changing which sign-in domains are allowed.

Ask the assistant to open that website and use the saved entry to fill the password field. It can find entries for the current website by name and username, then fill by ID without a password value in its tool arguments or results. The same browser tab remains available for you to inspect, take over and continue using. Filling alone does not press the sign-in button. If you ask the assistant to sign in, it can fill the observed fields and press that button together, then check the result. A two-step login requires checking the next page before entering the password; complete any MFA or CAPTCHA yourself when needed. No engine restart or **Apply changes** action is needed for browser passwords.

Choose **Edit password** to update an entry. Leave **Password** empty to retain it; enter it again if changing to a different website. Changing only a subdomain retains it. The saved value is not revealed by this form. **Delete** removes the saved entry from this device’s encrypted vault; it does not sign you out of an existing website session. Browser passwords are not environment variables. This first version is available only in the local desktop browser, not through a separately connected LegalWork server.

To use the same account at more URLs, choose **Edit password > Add URL**. Enter one address under **Website**, then choose **Save URL**. Use **Add URL** again for another address. To allow the password on a separate sign-in website, use **Sign-in websites > Add sign-in URL**, which has its own single address field. Changes save immediately without re-entering your password. Each list has remove buttons; removing a starting page does not revoke its sign-in permission. See [adding URLs to a saved login](integrations.md#add-urls-to-an-existing-login) for the full steps and the automatic repair of older Lexis entries for Austria, France, the UK and the US.

The assistant can add URLs directly when you ask, without a credential card or password re-entry. Specify the saved account and starting page, and include any additional sign-in website where you want that password to work.

The fill tool avoids putting the password into chat or its response. It does not isolate the agent from the password: unrestricted host commands can still read the vault, and page scripts or browser readback tools can access a filled field. The website receives the password normally. Use this with websites and agents you trust.

If no matching entry appears, check the website reported by the password tool against **Sign-in websites**, including its main domain, scheme and port. Redirects to a login subdomain on the same website are supported. If the provider uses a separate sign-in website, add that address to the existing login as described above. A fill requires a current password-field reference in the same chat’s local browser. After navigation, cancellation or a failed fill, inspect the page before retrying. An unreadable vault error requires restoring access to the existing vault/key; do not delete it to reset a password entry.

In **Tool Permissions**, inspect the displayed rule for the operation before changing it. Allowing a tool to run automatically can affect later chats as well as the current one. In workspace **Permissions**, add/remove the intended folder grant and check the selected workspace. Neither setting replaces provider consent or OS access grants.

## Sandboxing

During onboarding, the **Sandboxing** switch appears below the tool approval switches and is off by default. Turn it on to run commands inside a protected environment. **Sandbox network traffic** appears only while sandboxing is on; use it to control internet access for commands, page reads and web searches. Model connections, connected apps and browser tools keep their own permissions. Manage sandbox settings, status and recovery in **Settings > Tool Permissions**. Firm policy can restrict these settings.

To change one chat, open the **shield icon** in the top-right corner of the conversation. Choose **Use application default**, **Sandbox on**, or **Sandbox off**. With sandboxing on, open the network submenu to allow, block, or approve network traffic. The choice applies to that chat and its child agents; other chats keep their own settings. Choose **Use application default** to remove the chat override. Changing the chat's settings stops its running commands. An enforced firm policy hides this menu; view the managed setting in **Settings > Tool Permissions**.

If the chat's protection status cannot be checked, the shield remains available without adding an error above the conversation. Open its menu and choose **Check again** to retry. Until the check succeeds, protection choices are unavailable. If saved settings need recovery, follow the instructions in the menu or open **Settings > Tool Permissions**.

If the app reports that sandboxing is unavailable, commands remain blocked while sandboxing is on. This indicates a runtime problem, not a missing network permission.

Sandbox settings refresh when the connected server reports a change, including changes from another window, synced preferences and firm policy. Reconnecting refreshes the current state. Use **Check again** in **Settings > Tool Permissions** to request a manual refresh.

## Personalisation and memory

Use **Personalisation > System prompt additions** to enter persistent writing instructions, then **Save**. These apply to chats on the current host. Choose a personality such as Default, Pragmatic or Professional if useful; individual models can follow tone differently. Project-specific instructions belong in the project's personalisation controls when available.

The Memory section can contain cleanup controls for legacy local memories. The app no longer creates local memories; their presence in settings does not promise automatic learning from every chat. **Delete local memories** permanently removes the indicated host/workspace memory blocks, not chat history, workspace documents, Wiki pages or a firm's LegalMemory index. For matter facts, use live sources.

## Customization

Change the display language in **Customization**. Use the appearance selector to choose light, dark or system appearance. Task suggestions controls starter suggestions; showing model reasoning changes what is displayed, not the model's reasoning budget.

**Projects** offers defaults for matter fields and a new-window preference to ask, open empty or copy the current context. Project defaults apply when creating a project; they do not overwrite every existing matter.

## App updates

Under **Settings > Updates**, automatic checks run at startup and periodically while the app is visible. They can check again after you return to a long-running app. Turning automatic checks off stops these periodic checks. A download in progress or an update ready to install is left alone. Website outages fall back to GitHub for the same selected release.

To support gradual updates, the updater creates a random installation ID at the first update check and stores it locally. It uses this ID to keep your installation in a consistent rollout group. The ID is included in requests to the update feed, together with the selected update channel and app version.

## Privacy and data flow

Workspace files and local processing remain on the selected worker, but provider requests and connector actions can transmit task data to the chosen service. Local transcription runs on-device; cloud transcription and Voice Mode transmit audio to their selected services. Shared projects, wiki sharing and published calendar feeds also copy the chosen data to the firm's service. Ordinary connected storage is not automatically ingested into a knowledge index.

Official builds can send content-free usage telemetry when enabled. **Settings > Privacy** controls the analytics preference; development builds do not send it. Where offered, online model-catalog updates control refreshing provider/model metadata, not downloading a local transcription model. These settings are separate from network access needed for a provider or connector. App-hiding controls live under Recorder > Meetings. They affect visibility, not provider data handling.

Related: [Localization](localization.md), [Audio](audio.md), [Troubleshooting](troubleshooting.md).

Opening a project does not require a separate project-automation approval. Chat permissions, added-folder access, command approvals and sandbox settings still apply to the agent's operations.

## Unsaved changes when closing or restarting

When you close LegalWork or choose **Settings > Updates > Install and restart**, LegalWork checks for unsaved work, including workflow instructions and files open behind another page. The dialog lists the affected files, with its actions together in the bottom row. The discard action appears in red.

- **Save and close** or **Save and restart** saves the changes before continuing. If a save fails or changes arrive during saving, LegalWork stays open so you can resolve them.
- **Discard and close** or **Discard and restart** discards the listed changes before continuing.
- **Open unsaved file** cancels closing or restarting and brings an affected file to the front. This button appears only when an unsaved file is not already visible.

Use the dialog's close button or press **Esc** to keep working without closing or restarting. If a save is already running, wait for it to finish and try again. A downloaded update remains ready to install when you cancel the restart.

## Firm infrastructure region

The Eigenwelt firm's infrastructure region is chosen once by its administrator during platform onboarding. LegalWork saves the deployment with **Settings > Account** and sends firm features to that deployment after sign-in. Existing firms are assigned by Eigenwelt. Switching the firm's region requires a coordinated migration; there is no region toggle in desktop Settings. See [Getting started](getting-started.md).

This setting covers Eigenwelt's platform, gateway and storage. It does not choose where an AI model performs inference. Model and connector providers keep their own hosting arrangements, and Clerk remains the shared sign-in service. API-key integrations need the regional base URL supplied by the Eigenwelt platform.
