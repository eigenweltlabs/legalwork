import type { Plugin } from "@opencode/plugin";
import { OpenCode } from "@opencode/client";
import { Form } from "@opencode/schema/form";
import { z } from "zod";
import { browserPasswordRequestSchema, legalResearchProviders, websiteConnectionUrl } from "../native-shared-values.js";
import { browserUrl, requestBrowser, websiteConnections } from "./legalwork-browser-tools.js";
import { requireBrowserNetwork } from "./browser-network-policy.js";
import { nativeTool, nativeToolSignal } from "./native-tool.js";
import { resolveWorkspaceId, serverToken, serverUrl, workspaceToolHeaders } from "./office-plugin-shared.js";

const listing = z.object({ website: z.string().nullable(), passwords: z.array(z.object({
  id: z.string().uuid(), label: z.string(), username: z.string(),
})) });
const loginDetails = z.object({
  label: z.string().trim().min(1).max(200).optional(), username: z.string().max(500).optional(),
  start_url: websiteConnectionUrl.optional().describe("Stable destination to associate with this login, when sign-in uses another URL. Shown in the secure card. Omit OAuth state and session parameters."),
});
function stableUrl(value: string) {
  const url = new URL(value); url.search = ""; url.hash = ""; return url.href;
}
function signInUrl(value: string) {
  const url = stableUrl(value);
  // Verified product entry points establish regional state on a separate sign-in host.
  return ["https://360.lexisnexis.at/", "https://plus.lexis.com/at", "https://plus.lexis.com/at/",
    "https://plus.lexis.com/", "https://plus.lexis.com/uk", "https://plus.lexis.com/uk/",
    "https://www.lexis360intelligence.fr/"].includes(url)
    ? "https://signin.lexisnexis.com/lnaccess/app/signin" : url;
}

export function browserPasswordRequestTool(ctx: Plugin.Context) {
  return nativeTool(ctx, {
    name: "legalwork_browser_request_password",
    description: "Show the existing secure login card immediately for any website. For setup, pass website_url supplied by the user, or provider for a catalogue preset such as CourtListener. If neither URL nor preset is known, ask for the sign-in website first. No help/research skill, web search or browser tab is needed before the card. The card displays the website and offers matching saved logins. During browsing, use the current tab's browser_url instead. Waits for save or cancel, returns metadata only. Passwords go directly to the existing vault, never chat. After saving, open start_url to establish fresh sign-in state and list matching passwords before filling fresh observed fields to verify access. Saving alone does not verify access. On cancel, stop. Local desktop only.",
    schema: z.union([
      z.object({ provider: z.string().trim().min(1).max(200).describe("Known provider name, ID or alias, such as CourtListener, beck-online or juris. Uses the built-in catalogue; no URL lookup needed.") }).strict(),
      loginDetails.extend({ website_url: websiteConnectionUrl.describe("Sign-in website supplied by the user. Its origin is shown in the card for confirmation. Do not guess an authentication domain. No open browser tab required.") }).strict(),
      loginDetails.extend({ browser_url: browserUrl }).strict(),
    ]),
    async execute(input, context) {
      if (!context.sessionID || !context.abort) throw new Error("A browser password request requires its calling chat.");
      const sessionID = context.sessionID, signal = context.abort;
      const preset = "provider" in input ? legalResearchProviders.filter(provider =>
        [provider.id, provider.name, ...provider.aliases].some(name => name.toLowerCase() === input.provider.toLowerCase())) : [];
      if ("provider" in input && preset.length !== 1) return JSON.stringify({ status: "provider_required",
        message: preset.length ? "Ask which provider the user means, then use its exact ID." : "No matching preset. Ask for the sign-in website, then use website_url to show the secure card directly.",
        providers: preset.map(({ id, name, countries }) => ({ id, name, countries })) });
      const provider = preset[0];
      if (provider && !provider.loginUrl) return JSON.stringify({ status: "login_url_required", research_url: provider.researchUrl,
        message: "This provider has no confirmed sign-in URL. Ask the user for it, then pass website_url with this research_url as start_url. Do not infer an authentication domain." });
      const direct = "website_url" in input ? { loginUrl: signInUrl(input.website_url),
        request: { website: new URL(signInUrl(input.website_url)).origin, label: input.label ?? new URL(input.website_url).hostname, username: input.username ?? "", startUrl: stableUrl(input.start_url ?? input.website_url) } }
        : provider?.loginUrl ? { loginUrl: provider.loginUrl,
          request: { website: new URL(provider.loginUrl).origin, label: provider.name, username: "", startUrl: provider.researchUrl } } : undefined;
      // Saving a login needs no website access. Browser use afterwards
      // still checks the calling chat's network policy and actual page origin.
      const workspaceId = direct ? await resolveWorkspaceId(context, { requireDirectory: true }) : (await requireBrowserNetwork(context)).workspaceId;
      // The plugin domain omits forms; use the supported native HTTP API through
      // LegalWork's existing project/session admission proxy.
      const native = OpenCode.make({ baseUrl: `${serverUrl()}/workspace/${encodeURIComponent(workspaceId)}/opencode`,
        headers: { Authorization: `Bearer ${serverToken()}` } });
      const forms = native.session.form;
      const current = "browser_url" in input ? listing.parse(await requestBrowser(input.browser_url, "passwords", undefined, context)) : undefined;
      if (current?.passwords.length) return JSON.stringify(current);
      const parsed = browserPasswordRequestSchema.safeParse(direct ? direct.request : "browser_url" in input ? { website: current?.website,
          label: input.label ?? (current?.website ? new URL(current.website).hostname : ""), username: input.username ?? "", ...(input.start_url ? { startUrl: input.start_url } : {}) } : undefined);
      if (!parsed.success) throw new Error("Open a supported HTTPS website before requesting a saved login.");
      const request = parsed.data;
      const stream = new AbortController();
      const events = native.event.subscribe({ signal: AbortSignal.any([signal, stream.signal]) })[Symbol.asyncIterator]();
      let formID: Form.ID | undefined;
      let resolved = false;
      try {
        // Unlike the plugin's live-only stream, native HTTP SSE starts with
        // server.connected. It confirms subscription before form
        // creation. Immediate replies and reloads cannot fall into an SSE gap.
        if ((await events.next()).done) throw new Error("The chat's input connection is unavailable.");
        signal.throwIfAborted();
        // Keep the ID before sending and let bounded creation finish, so Stop
        // cannot discard the response and leave a newly created card behind.
        formID = Form.ID.create();
        await forms.create({ sessionID, id: formID, title: `Save login for ${new URL(request.website).hostname}`,
          metadata: { legalworkBrowserPassword: request }, fields: [
            { key: "password_id", type: "string", hidden: true },
            { key: "cancelled", type: "boolean", hidden: true, default: false },
          ] }, { signal: AbortSignal.timeout(10_000) });
        signal.throwIfAborted();
        while (true) {
          const detail = await forms.get({ sessionID, formID }, { signal });
          resolved = detail.state.status !== "pending";
          if (detail.state.status === "cancelled") return JSON.stringify({ cancelled: true });
          if (detail.state.status === "answered") {
            const answer = z.object({ password_id: z.string().optional(), cancelled: z.boolean().optional() }).strict().parse(detail.state.answer);
            if (answer.cancelled) return JSON.stringify({ cancelled: true });
            const id = z.string().uuid().parse(answer.password_id);
            if (!("browser_url" in input)) {
              const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspaceId)}/browser-connections?origin=${encodeURIComponent(request.website)}`, {
                headers: await workspaceToolHeaders(context), signal: nativeToolSignal(10000),
              });
              if (!response.ok) throw new Error("Saved website connections are unavailable to this chat.");
              const connection = websiteConnections.parse(await response.json()).items.find(item => item.id === id);
              if (!connection || !connection.websites.some(site => site.url === request.startUrl)) throw new Error("The saved login or website destination changed. Check the saved entry before continuing.");
              return JSON.stringify({ status: "saved", website: request.website, password_id: id, login_url: direct?.loginUrl, start_url: request.startUrl,
                message: "The login is saved in Secrets. Access is not yet verified. Open start_url so the provider establishes fresh sign-in state, then list matching passwords for the actual sign-in page and inspect fresh field refs before filling. Do not ask for the password again." });
            }
            await requireBrowserNetwork(context);
            let latest: z.infer<typeof listing>;
            try { latest = listing.parse(await requestBrowser(input.browser_url, "passwords", undefined, context)); }
            catch {
              signal.throwIfAborted();
              // Renderer reloads revoke the old capability. The form and saved
              // entry survive; request a fresh connection, not another password.
              return JSON.stringify({ website: request.website, password_id: id, status: "reconnect_required",
                message: "The card returned a saved-entry reference, but the browser connection changed while waiting. Open the website again to obtain a fresh browser_url, then list matching entries and inspect fresh refs before filling. Do not ask for the password again." });
            }
            const password = latest.passwords.find(item => item.id === id);
            // The desktop applies the vault's main-domain/subdomain matcher.
            if (!password) throw new Error("The browser website or saved login changed. Inspect the current tab before requesting another login.");
            return JSON.stringify({ website: latest.website, passwords: [password] });
          }
          while (true) {
            const event = await events.next();
            if (event.done) throw new Error("The chat's input connection closed. Inspect the request before retrying.");
            if ((event.value.type === "form.replied" || event.value.type === "form.cancelled") && event.value.data.id === formID && event.value.data.sessionID === sessionID) break;
          }
        }
      } finally {
        stream.abort();
        await events.return?.().catch(() => {});
        // Cancellation/Stop must not leave an orphaned credential card.
        if (formID && !resolved) await forms.cancel({ sessionID, formID }, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      }
    },
  });
}
