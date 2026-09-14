/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";

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
import { openDesktopUrl } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import { getMcpOAuthErrorMessage } from "@/app/mcp-oauth-errors";
import { t } from "@/i18n";

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
  return t("mcp.legalmemory_url_hint");
}

function labelFor(name: string): string {
  const map: Record<string, string> = {
    appliance: t("mcp_setup.legalmemory_base_url"),
    instance: t("mcp_setup.highq_instance"),
    site: t("mcp_setup.site_context"),
    tenant_id: t("mcp_setup.tenant_id"),
    tenantHostname: t("mcp_setup.relativity_host"),
    region: "Region",
    customer: t("mcp_setup.customer_subdomain"),
  };
  return map[name] ?? name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export type McpConnectorSetupModalProps = {
  entry: McpDirectoryInfo | null;
  open: boolean;
  onClose: () => void;
  /** Suppress automatic sign-in if the user dismisses setup while its save is pending. */
  onCancel?: () => void;
  onConnect: (entry: McpDirectoryInfo) => boolean | void | Promise<boolean | void>;
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
  const redirectUri = entry?.oauthConfig?.redirectUri
    ?? `http://127.0.0.1:${entry?.oauthConfig?.callbackPort ?? 19876}/mcp/oauth/callback`;

  const [values, setValues] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scope, setScope] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const submissionRef = useRef({ id: 0, busy: false });
  const formIdentity = entry?.id ?? entry?.serverName ?? entry?.name;

  useEffect(() => {
    // Initialize only when opening or switching connector, so refreshed catalog
    // objects cannot clear credentials while the user is typing.
    submissionRef.current = { id: submissionRef.current.id + 1, busy: false };
    setConnecting(false);
    setValues({});
    setClientId(entry?.oauthConfig?.clientId ?? "");
    setClientSecret(entry?.oauthConfig?.clientSecret ?? "");
    setScope(entry?.oauthConfig?.scope ?? "");
    setToken("");
    setError(null);
    return () => {
      if (submissionRef.current.busy) props.onCancel?.();
      submissionRef.current = { id: submissionRef.current.id + 1, busy: false };
    };
  }, [props.open, formIdentity]);

  const reset = () => {
    setValues({});
    setClientId("");
    setClientSecret("");
    setScope("");
    setToken("");
    setError(null);
  };

  const close = () => {
    submissionRef.current = { id: submissionRef.current.id + 1, busy: false };
    setConnecting(false);
    reset();
    props.onClose();
  };

  const cancel = () => {
    if (submissionRef.current.busy) props.onCancel?.();
    close();
  };

  const allPlaceholdersFilled = placeholders.every((p) => (values[p] ?? "").trim().length > 0);
  const credsOk = !needsCreds || (clientId.trim().length > 0 && (clientIdOnly || clientSecret.trim().length > 0));
  const tokenOk = !needsToken || token.trim().length > 0;
  const canSubmit = Boolean(entry) && allPlaceholdersFilled && credsOk && tokenOk && !connecting;

  // The preview keeps unfilled placeholders visible, so it resolves against the
  // typed values with each blank standing in for itself.
  const previewUrl = resolveConnectorUrl(
    entry?.url ?? "",
    Object.fromEntries(placeholders.map((p) => [p, values[p]?.trim() ? values[p].trim() : `{${p}}`])),
  );

  const submit = async () => {
    if (!entry || !canSubmit || submissionRef.current.busy) return;
    const url = resolveConnectorUrl(entry.url ?? "", values);
    if (/[{}]/.test(url)) {
      setError(t("mcp.fill_all_fields"));
      return;
    }
    const oauthConfig = needsCreds
      ? {
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          ...(scope.trim() ? { scope: scope.trim() } : {}),
          callbackPort: entry.oauthConfig?.callbackPort,
          redirectUri: entry.oauthConfig?.redirectUri,
        }
      : entry.oauthConfig;
    // Token connectors hand off Authorization: Bearer headers; connectMcp uses these
    // and skips OAuth (entry.oauth is already false for these connectors).
    const headers = needsToken && token.trim()
      ? { Authorization: `Bearer ${token.trim()}` }
      : entry.headers;
    const submissionId = submissionRef.current.id + 1;
    submissionRef.current = { id: submissionId, busy: true };
    setConnecting(true);
    setError(null);
    try {
      const connected = await props.onConnect({ ...entry, url, oauthConfig, ...(headers ? { headers } : {}) });
      if (submissionRef.current.id !== submissionId) return;
      if (connected === false) {
        setError("Could not connect. Check your settings and try again.");
        return;
      }
      close();
    } catch (error) {
      if (submissionRef.current.id === submissionId) setError(getMcpOAuthErrorMessage(error, "Could not connect. Try again."));
    } finally {
      if (submissionRef.current.id === submissionId) {
        submissionRef.current.busy = false;
        setConnecting(false);
      }
    }
  };

  const inputClass =
    "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {entry?.name ?? "connector"}</DialogTitle>
          <DialogDescription>
            {entry?.setupNote ?? (clientIdOnly
              ? t("mcp_setup.oauth_client_hint")
              : needsCreds
              ? t("mcp_setup.no_auto_registration")
              : needsToken
              ? t("mcp_setup.oauth_unsupported")
              : t("mcp_setup.instance_details"))}
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={connecting} className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
          {entry?.setupUrl ? (
            <a
              href={entry.setupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-dls-accent underline underline-offset-4"
              onClick={(event) => {
                if (!isDesktopRuntime() || !entry.setupUrl) return;
                event.preventDefault();
                void openDesktopUrl(entry.setupUrl).catch(() => setError("Could not open the provider's setup instructions."));
              }}
            >
              Provider setup instructions
            </a>
          ) : null}
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
              <div className="space-y-1.5 text-xs text-dls-secondary">
                <p>Register this redirect URL in your provider's OAuth app settings:</p>
                <code className="block break-all rounded-xl border border-dls-border bg-dls-hover px-3 py-2">{redirectUri}</code>
              </div>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-dls-text">{t("mcp.oauth_client_id_label")}</span>
                <input value={clientId} onChange={(event) => setClientId(event.currentTarget.value)} spellCheck={false} className={inputClass} />
              </label>
              {clientIdOnly ? null : (
                <>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-dls-text">{t("mcp.oauth_client_secret_label")}</span>
                    <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.currentTarget.value)} className={inputClass} />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-dls-text">{t("mcp.scope_optional")}</span>
                    <input
                      value={scope}
                      onChange={(event) => setScope(event.currentTarget.value)}
                      placeholder={t("mcp.scope_placeholder_short")}
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
              <span className="text-xs font-medium text-dls-text">{t("mcp.api_token")}</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
                placeholder={t("mcp.api_token_placeholder")}
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
        </fieldset>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {connecting ? "Connecting..." : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
