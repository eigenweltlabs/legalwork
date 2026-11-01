import { mailIntegrationConfigurationSchema, type MailIntegrationConfiguration } from "../integration-view.js";

/** Worker-private configuration. Never written into the mail database. */
export function createMailIntegrationFetch(configuration: () => MailIntegrationConfiguration | undefined, transport?: typeof fetch): typeof fetch {
  const send: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const perform = transport ?? fetch;
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization");
    const reference = /^Bearer legalwork-mail:(mail_[a-f0-9]{64})$/.exec(authorization ?? "");
    if (!reference) return perform(input, init);
    const request = new Request(input, init);
    const current = mailIntegrationConfigurationSchema.parse(configuration());
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("x-legalwork-mail-capability", current.capability);
    headers.set("x-legalwork-mail-account", reference[1]);
    headers.set("x-legalwork-mail-endpoint", request.url);
    headers.set("x-legalwork-mail-method", request.method);
    return perform(`${current.origin}/mail/internal/integrations/request`, {
      method: "POST", headers, redirect: "error", credentials: "omit", cache: "no-store", signal: request.signal,
      ...(request.body ? { body: await request.blob() } : {}),
    });
  }, transport ?? fetch);
  return send;
}

let workerConfiguration: MailIntegrationConfiguration | undefined;
export function configureMailIntegrationFetch(configuration: MailIntegrationConfiguration) {
  workerConfiguration = mailIntegrationConfigurationSchema.parse(configuration);
}
export const mailProviderFetch = createMailIntegrationFetch(() => workerConfiguration);
