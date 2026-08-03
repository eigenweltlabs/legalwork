/** @jsxImportSource react */
import { useMemo, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { McpDirectoryInfo } from "@/app/constants";

const PLACEHOLDER_RE = /\{([^}]+)\}/g;

function extractPlaceholders(url: string | undefined): string[] {
  if (!url) return [];
  const out: string[] = [];
  for (const match of url.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

/**
 * Substitute the firm's answers into a catalog URL template.
 *
 * Vendor connectors hardcode their scheme and interpolate a subdomain
 * (`https://{instance}.highq.com/...`), so those are untouched here. On-prem
 * connectors interpolate the whole address instead, because the firm owns it:
 * a LegalMemory appliance can be `ki.firm.internal`, `ki.firm.com:8443`, or a
 * plain-HTTP host behind an internal TLS-terminating proxy.
 *
 * Two things people actually type have to survive that:
 *
 *   - the full endpoint, not the bare host. Asking for a "base URL" does not
 *     stop anyone pasting the `…/mcp` address they already use elsewhere, and
 *     appending the template's own `/mcp/` on top of it produced `/mcp/mcp/`:
 *     a server that registers cleanly and then resolves to nothing.
 *   - a loopback address, which is a local deployment and is therefore almost
 *     never on TLS. Defaulting `localhost` to https produced a connector that
 *     could only ever fail its handshake.
 */
export function resolveConnectorUrl(template: string, values: Record<string, string>): string {
  // A single-placeholder template is the on-prem case, where the firm owns the
  // whole address. If what they typed already carries a path, that IS the
  // endpoint and it is used verbatim: someone who pastes a working URL must
  // get that URL back, not a rewritten guess at one.
  const onlyPlaceholder = /^\{([^}]+)\}(.*)$/.exec(template);
  if (onlyPlaceholder) {
    const typed = (values[onlyPlaceholder[1]] ?? "").trim();
    if (hasPath(typed)) return withScheme(typed);
    return withScheme(`${typed.replace(/\/+$/, "")}${onlyPlaceholder[2]}`);
  }

  // Vendor templates interpolate a subdomain into a URL they own; substitute
  // and leave the rest alone.
  return template.replace(PLACEHOLDER_RE, (_, key: string) => (values[key] ?? "").trim().replace(/\/+$/, ""));
}

/** Does the value name a path of its own, beyond the host[:port]? */
function hasPath(value: string): boolean {
  const afterScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = afterScheme.indexOf("/");
  return slash !== -1 && afterScheme.slice(slash).replace(/\/+$/, "") !== "";
}

/** Keep an explicit scheme; otherwise loopback means a local deployment, which
 * is almost never on TLS, and anything else defaults to https. */
function withScheme(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `${isLoopback(value) ? "http" : "https"}://${value}`;
}

/** localhost / 127.x / ::1, with or without a port. */
function isLoopback(value: string): boolean {
  const host = value.split("/")[0].replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/**
 * A LegalMemory appliance is the firm's own deployment, so someone arriving
 * here without one needs to be told that rather than left guessing at a URL.
 */
function hintFor(name: string): string | null {
  if (name !== "appliance") return null;
  return "Your firm's running LegalMemory deployment, for example ki.yourfirm.com. Ask whoever administers it, or see eigenweltlabs.com/legalmemory to deploy one.";
}

function labelFor(name: string): string {
  const map: Record<string, string> = {
    appliance: "LegalMemory base URL (host[:port], or http://host if it isn't on TLS)",
    instance: "HighQ instance (subdomain)",
    site: "Site / context name",
    tenant_id: "Microsoft tenant ID",
    tenantHostname: "Relativity tenant hostname",
    region: "Region",
    customer: "Customer subdomain",
  };
  return map[name] ?? name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export type McpConnectorSetupModalProps = {
  entry: McpDirectoryInfo | null;
  open: boolean;
  onClose: () => void;
  onConnect: (entry: McpDirectoryInfo) => void;
};

/**
 * Collects the per-firm bits a connector needs before its one-click OAuth can
 * fire: any {placeholder} segments in the URL (instance/tenant/site) and, for
 * vendors without OAuth dynamic client registration, the firm's own OAuth app
 * clientId/secret. It then hands a fully-resolved entry to connectMcp, which
 * already knows how to write `url` + `oauth` into the engine config.
 */
export function McpConnectorSetupModal(props: McpConnectorSetupModalProps) {
  const entry = props.entry;
  const placeholders = useMemo(() => extractPlaceholders(entry?.url), [entry?.url]);
  const needsCreds = entry?.requiresOauthClient === true;
  // Public OAuth client (PKCE): collect only a client ID, never a secret.
  const clientIdOnly = entry?.oauthClientIdOnly === true;
  // Token-authed connectors (e.g. iManage) whose OAuth the local engine can't do:
  // collect an access token and connect via Authorization: Bearer instead.
  const needsToken = entry?.requiresToken === true;

  const [values, setValues] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scope, setScope] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setValues({});
    setClientId("");
    setClientSecret("");
    setScope("");
    setToken("");
    setError(null);
  };

  const close = () => {
    reset();
    props.onClose();
  };

  const allPlaceholdersFilled = placeholders.every((p) => (values[p] ?? "").trim().length > 0);
  const credsOk = !needsCreds || (clientId.trim().length > 0 && (clientIdOnly || clientSecret.trim().length > 0));
  const tokenOk = !needsToken || token.trim().length > 0;
  const canSubmit = Boolean(entry) && allPlaceholdersFilled && credsOk && tokenOk;

  // The preview keeps unfilled placeholders visible, so it resolves against the
  // typed values with each blank standing in for itself.
  const previewUrl = resolveConnectorUrl(
    entry?.url ?? "",
    Object.fromEntries(placeholders.map((p) => [p, values[p]?.trim() ? values[p].trim() : `{${p}}`])),
  );

  const submit = () => {
    if (!entry || !canSubmit) return;
    const url = resolveConnectorUrl(entry.url ?? "", values);
    if (/[{}]/.test(url)) {
      setError("Fill in every field before connecting.");
      return;
    }
    const oauthConfig = needsCreds
      ? {
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          ...(scope.trim() ? { scope: scope.trim() } : {}),
        }
      : entry.oauthConfig;
    // Token connectors hand off Authorization: Bearer headers; connectMcp uses these
    // and skips OAuth (entry.oauth is already false for these connectors).
    const headers = needsToken && token.trim()
      ? { Authorization: `Bearer ${token.trim()}` }
      : entry.headers;
    props.onConnect({ ...entry, url, oauthConfig, ...(headers ? { headers } : {}) });
    close();
  };

  const inputClass =
    "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {entry?.name ?? "connector"}</DialogTitle>
          <DialogDescription>
            {clientIdOnly
              ? "Enter your instance details and the OAuth client ID your provider issued, then connect."
              : needsCreds
              ? "This service has no automatic app registration, so enter your firm's OAuth app details. Then connect."
              : needsToken
              ? "This service's OAuth isn't supported by the local engine — paste an access token to connect instead."
              : "Enter your instance details, then connect."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
          {error ? (
            <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">{error}</div>
          ) : null}

          {placeholders.map((p) => (
            <label key={p} className="block space-y-1.5">
              <span className="text-xs font-medium text-dls-text">{labelFor(p)}</span>
              <input
                value={values[p] ?? ""}
                // Read the value here, not inside the updater: React nulls the
                // synthetic event's currentTarget once the handler returns, and
                // the functional form of setState runs after that, so deferring
                // the read throws on the first keystroke.
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setValues((prev) => ({ ...prev, [p]: value }));
                }}
                placeholder={`{${p}}`}
                spellCheck={false}
                className={inputClass}
              />
              {hintFor(p) ? (
                <span className="block text-[11px] leading-relaxed text-dls-secondary">{hintFor(p)}</span>
              ) : null}
            </label>
          ))}

          {needsCreds ? (
            <>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-dls-text">OAuth client ID</span>
                <input value={clientId} onChange={(event) => setClientId(event.currentTarget.value)} spellCheck={false} className={inputClass} />
              </label>
              {clientIdOnly ? null : (
                <>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-dls-text">OAuth client secret</span>
                    <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.currentTarget.value)} className={inputClass} />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-dls-text">Scope (optional)</span>
                    <input
                      value={scope}
                      onChange={(event) => setScope(event.currentTarget.value)}
                      placeholder="space-separated scopes"
                      spellCheck={false}
                      className={inputClass}
                    />
                  </label>
                </>
              )}
            </>
          ) : null}

          {needsToken ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-dls-text">API token</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
                placeholder="Paste your access token"
                spellCheck={false}
                className={inputClass}
              />
              <span className="block text-[11px] leading-relaxed text-dls-secondary">
                Sent as <span className="font-mono">Authorization: Bearer …</span> — skips OAuth.
              </span>
            </label>
          ) : null}

          {entry?.url ? (
            <div className="break-all rounded-xl border border-dls-border bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">
              {previewUrl}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
