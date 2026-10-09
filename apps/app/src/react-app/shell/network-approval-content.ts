import type { HostApprovalRequest } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

/** Describe observed request contents, without guessing an agent's intent. */
export function networkApprovalContent(network: NonNullable<HostApprovalRequest["network"]>) {
  const url = new URL(network.url);
  const methods: Record<string, [string, string]> = {
    GET: [t("sandbox.approval_read_title"), t("sandbox.approval_read_description")],
    HEAD: [t("sandbox.approval_check_title"), t("sandbox.approval_check_description")],
    POST: [t("sandbox.approval_send_title"), t("sandbox.approval_send_description")],
    PUT: [t("sandbox.approval_replace_title"), t("sandbox.approval_replace_description")],
    PATCH: [t("sandbox.approval_change_title"), t("sandbox.approval_change_description")],
    DELETE: [t("sandbox.approval_delete_title"), t("sandbox.approval_delete_description")],
  };
  const [action, description] = methods[network.method] ?? [t("sandbox.approval_unknown_title"), t("sandbox.approval_unknown_description")];
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
