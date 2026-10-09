import type { HostApprovalRequest } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

/** Describe observed request contents, without guessing an agent's intent. */
export function networkApprovalContent(network: NonNullable<HostApprovalRequest["network"]>) {
  const url = new URL(network.url);
  const methods: Record<string, string> = { GET: "read", HEAD: "check", POST: "send", PUT: "replace", PATCH: "change", DELETE: "delete" };
  const kind = methods[network.method] ?? "unknown";
  const action = t(`sandbox.approval_${kind}_title`);
  const description = t(`sandbox.approval_${kind}_description`);
  const sent = [];
  for (const [key, value] of url.searchParams) sent.push(`${key}: ${value}`);
  if (network.bodyBytes > 0) {
    if (network.bodyFormat === "base64") sent.push(t("sandbox.approval_binary", undefined, { bytes: network.bodyBytes.toLocaleString() }));
    else if (network.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      for (const [key, value] of new URLSearchParams(network.body)) sent.push(`${key}: ${value}`);
    } else {
      try { sent.push(JSON.stringify(JSON.parse(network.body), null, 2)); }
      catch { sent.push(network.body); }
    }
  }
  const credentials = Object.keys(network.headers).some((name) => /authorization|cookie|api.?key|token|secret/i.test(name));
  return {
    action, description, destination: url.host, resource: url.pathname,
    sent: sent.join("\n\n"),
    context: [credentials ? t("sandbox.approval_credentials") : "",
      url.protocol === "http:" ? t("sandbox.approval_unencrypted") : "",
      t("sandbox.approval_connection_details")].filter(Boolean).join(" "),
  };
}
