import type { HostApprovalRequest } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}
function searchQuery(value: unknown): string | null {
  if (!record(value) || !onlyKeys(value, ["jsonrpc", "id", "method", "params"]) || value.jsonrpc !== "2.0" || value.id !== 1 || value.method !== "tools/call") return null;
  const params = value.params;
  if (!record(params) || !onlyKeys(params, ["name", "arguments"]) || params.name !== "web_search_exa" || !record(params.arguments)) return null;
  const args = params.arguments;
  if (!onlyKeys(args, ["query", "numResults", "type", "livecrawl", "contextMaxCharacters"]) || typeof args.query !== "string") return null;
  if (args.numResults !== undefined && typeof args.numResults !== "number") return null;
  if (args.contextMaxCharacters !== undefined && typeof args.contextMaxCharacters !== "number") return null;
  if (args.type !== undefined && args.type !== "auto" && args.type !== "fast" && args.type !== "deep") return null;
  if (args.livecrawl !== undefined && args.livecrawl !== "fallback" && args.livecrawl !== "preferred") return null;
  return args.query;
}

const credentialName = /authorization|cookie|api.?key|token|secret|password/i;
const readableLabel = (key: string) => {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Describe the observed destination and payload, never an agent's claimed intent. */
export function networkApprovalContent(network: NonNullable<HostApprovalRequest["network"]>) {
  const url = new URL(network.url);
  let body: unknown;
  if (network.bodyFormat === "text" && network.bodyBytes > 0) {
    try { body = JSON.parse(network.body); } catch { /* Plain text or form data. */ }
  }
  const query = searchQuery(body);
  const search = url.origin === "https://mcp.exa.ai" && url.pathname === "/mcp" && network.method === "POST" &&
    [...url.searchParams.keys()].every(key => key === "exaApiKey") && query !== null
    ? { provider: "Exa Search", query: query } : null;
  const methods: Record<string, [string, string]> = {
    GET: [t("sandbox.approval_read_title"), t("sandbox.approval_read_description")],
    HEAD: [t("sandbox.approval_check_title"), t("sandbox.approval_check_description")],
    POST: [t("sandbox.approval_send_title"), t("sandbox.approval_send_description")],
    PUT: [t("sandbox.approval_replace_title"), t("sandbox.approval_replace_description")],
    PATCH: [t("sandbox.approval_change_title"), t("sandbox.approval_change_description")],
    DELETE: [t("sandbox.approval_delete_title"), t("sandbox.approval_delete_description")],
  };
  const [action, description] = search
    ? [t("sandbox.approval_search_title"), t("sandbox.approval_search_description", undefined, { provider: search.provider })]
    : methods[network.method] ?? [t("sandbox.approval_unknown_title"), t("sandbox.approval_unknown_description")];
  const fields: Array<{ label: string; value: string }> = [];
  let omitted = 0;
  const add = (label: string, value: string) => {
    if (fields.length < 16) fields.push({ label, value });
    else omitted++;
  };
  const field = (key: string, value: string) => add(readableLabel(key), credentialName.test(key) ? t("sandbox.approval_sign_in_value") : value);
  const flatten = (value: unknown, labels: string[], depth = 0) => {
    const label = labels.join(" · ") || t("sandbox.approval_content");
    if (credentialName.test(label)) { add(label, t("sandbox.approval_sign_in_value")); return; }
    if (depth > 8) { omitted++; return; }
    if (Array.isArray(value)) {
      if (!value.length) add(label, t("sandbox.approval_empty"));
      else value.forEach((item, index) => flatten(item, [...labels, String(index + 1)], depth + 1));
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (!entries.length) add(label, t("sandbox.approval_empty"));
      else for (const [key, item] of entries) flatten(item, [...labels, readableLabel(key)], depth + 1);
    } else add(label, value === null ? t("sandbox.approval_empty") : typeof value === "boolean" ? t(value ? "sandbox.approval_yes" : "sandbox.approval_no") : String(value));
  };
  if (!search) {
    for (const [key, value] of url.searchParams) field(key, value);
    if (network.bodyBytes > 0) {
      if (network.bodyFormat === "base64") add(t("sandbox.approval_content"), t("sandbox.approval_binary", undefined, { bytes: network.bodyBytes.toLocaleString() }));
      else if (network.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
        for (const [key, value] of new URLSearchParams(network.body)) field(key, value);
      } else if (body !== undefined) flatten(body, []);
      else add(t("sandbox.approval_content"), network.body);
    }
  }
  const credentials = Object.keys(network.headers).some(name => credentialName.test(name)) || [...url.searchParams.keys()].some(key => credentialName.test(key));
  return {
    action, description, destination: url.host, resource: url.pathname, search, fields, omitted,
    context: [credentials ? t("sandbox.approval_credentials") : "",
      url.protocol === "http:" ? t("sandbox.approval_unencrypted") : "",
      t("sandbox.approval_connection_details")].filter(Boolean).join(" "),
  };
}
