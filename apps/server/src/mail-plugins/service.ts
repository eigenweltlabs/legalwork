import { createHash } from "node:crypto";
import type { MailAction, MailProvider } from "@legalwork/types/mail-plugins";
import { ApiError } from "../errors.js";
import { vaultLock } from "../file-storage/oauth/vault.js";
import { MailPluginOAuth } from "./oauth.js";
import { mailProviderAction } from "./providers.js";
import { MailPluginVault } from "./vault.js";

type SendAction = Extract<MailAction, { action: "send" }>;
export class MailPlugins {
  readonly vault: MailPluginVault;
  readonly oauth: MailPluginOAuth;
  constructor(path: string) { this.vault = new MailPluginVault(path); this.oauth = new MailPluginOAuth(this.vault); }
  async execute(provider: MailProvider, action: MailAction, approve: (summary: string) => Promise<void>, signal?: AbortSignal, workspaceId?: string) {
    const account = await this.oauth.access(provider, action.accountId);
    if (["draft", "reply_draft", "send"].includes(action.action) && !account.canWrite) throw new ApiError(403, "mail_write_not_granted", "Reconnect this account with drafts and sending enabled in Plugins settings.");
    if (action.action !== "send") return mailProviderAction(account, action, signal);
    return this.send(provider, action, approve, signal, workspaceId);
  }
  private async send(provider: MailProvider, action: SendAction, approve: (summary: string) => Promise<void>, signal?: AbortSignal, workspaceId?: string) {
    const key = `${provider}:${action.accountId}:${action.requestId}`;
    const outgoing = { to: action.to, cc: action.cc, bcc: action.bcc, subject: action.subject, body: action.body };
    const digest = createHash("sha256").update(JSON.stringify(outgoing)).digest("hex");
    return vaultLock(`${this.vault.path}:send:${key}`, async () => {
      const previous = (await this.vault.read()).sends[key];
      if (previous) {
        if (previous.digest !== digest) throw new ApiError(409, "mail_send_changed", "This send request already refers to different email content.");
        if (previous.state === "sent") return { accepted: true, alreadySubmitted: true, requestId: action.requestId };
        throw new ApiError(409, "mail_send_uncertain", "This email may already have been submitted. Check Sent mail before requesting a new send. LegalWork will not retry automatically.");
      }
      const account = await this.oauth.account(provider, action.accountId);
      await approve([`Send email from ${account.email}`, `To: ${action.to.join(", ")}`, `Cc: ${action.cc.join(", ") || "(none)"}`, `Bcc: ${action.bcc.join(", ") || "(none)"}`, `Subject: ${action.subject}`, "", action.body].join("\n"));
      if (signal?.aborted) throw new ApiError(403, "mail_send_cancelled", "This email send was cancelled.");
      const refreshed = await this.oauth.access(provider, action.accountId);
      if (refreshed.connectedAt !== account.connectedAt || !refreshed.canWrite) throw new ApiError(409, "mail_account_changed", "The email connection changed while awaiting approval. Review the account before sending again.");
      // Pin the account until submission finishes. Disconnect waits for this operation.
      return vaultLock(`${this.vault.path}:account:${action.accountId}`, async () => {
        const current = await this.oauth.account(provider, action.accountId);
        if (current.connectedAt !== account.connectedAt || !current.canWrite) throw new ApiError(409, "mail_account_changed", "The email connection changed before sending.");
        await this.vault.update((value) => {
          if (workspaceId && !value.grants[workspaceId]?.includes(action.accountId)) throw new ApiError(403, "mail_project_access_required", "This project's email permission was removed before sending.");
          value.sends[key] = { digest, state: "sending", createdAt: new Date().toISOString() };
        });
        try {
          const result = await mailProviderAction(current, action, signal);
          await this.vault.update((value) => { const receipt = value.sends[key]; if (receipt) receipt.state = "sent"; });
          return { accepted: true, requestId: action.requestId, providerResult: result };
        } catch {
          await this.vault.update((value) => { const receipt = value.sends[key]; if (receipt) receipt.state = "uncertain"; });
          throw new ApiError(409, "mail_send_uncertain", "The email provider did not confirm the outcome. Check Sent mail before requesting another send. LegalWork will not retry automatically.");
        }
      });
    });
  }
}
