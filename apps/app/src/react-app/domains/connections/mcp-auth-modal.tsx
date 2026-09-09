/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCcw } from "lucide-react";

import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { McpDirectoryInfo } from "@/app/constants";
import { mcpOAuthListen, mcpOAuthWait, mcpOAuthCancel, openDesktopUrl } from "@/app/lib/desktop";
import { unwrap } from "@/app/lib/opencode";
import { getMcpIdentityKey, resolveMcpSignInName } from "@/app/mcp";
import { classifyMcpOAuthError, getMcpOAuthErrorMessage } from "@/app/mcp-oauth-errors";
import { createMcpOAuthFlow, type McpOAuthDriver, type McpOAuthState } from "@/app/mcp-oauth-flow";
import type { Client } from "@/app/types";
import { isDesktopRuntime, normalizeDirectoryPath } from "@/app/utils";
import { t } from "@/i18n";
import { TextInput } from "../../design-system/text-input";

export type McpAuthModalProps = {
  open: boolean;
  onClose: () => void;
  onComplete: () => void | Promise<void>;
  onConfigure?: (entry: McpDirectoryInfo) => void;
  onReloadEngine?: () => void | Promise<void>;
  reloadRequired?: boolean;
  reloadBlocked?: boolean;
  activeSessions?: Array<{ id: string; title: string }>;
  isRemoteWorkspace?: boolean;
  client: Client | null;
  entry: McpDirectoryInfo | null;
  projectDir: string;
  workspaceKey?: string;
  onForceStopSession?: (sessionID: string) => void | Promise<void>;
};

function pause(signal: AbortSignal, ms = 500) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function McpAuthModal(props: McpAuthModalProps) {
  // Callback/client identity refreshes must not restart an OAuth attempt.
  const latest = useRef(props);
  latest.current = props;
  const [state, setState] = useState<McpOAuthState>({ phase: "idle" });
  const [preparation, setPreparation] = useState(() => t("mcp.auth.preparing_sign_in"));
  const [needsReload, setNeedsReload] = useState(false);
  // Set where we detect it, so classification never depends on the
  // message language.
  const [needsCredentials, setNeedsCredentials] = useState(false);
  const [waitingForSessions, setWaitingForSessions] = useState(false);
  const [callbackInput, setCallbackInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [forceStopBusy, setForceStopBusy] = useState<string | null>(null);
  const completing = useRef(false);

  const [flow] = useState(() => createMcpOAuthFlow({
    onChange: setState,
    openBrowser: async (url) => {
      if (isDesktopRuntime()) return openDesktopUrl(url);
      // Popup blockers often reject an async open. A direct user-activated link
      // remains visible in every waiting state, including browser-only clients.
      const popup = window.open(url, "_blank");
      if (!popup) throw new Error(t("mcp.auth.popup_blocked"));
      popup.opener = null;
    },
    prepare: async (signal): Promise<McpOAuthDriver> => {
      const entry = latest.current.entry;
      const initialClient = latest.current.client;
      if (!entry || !initialClient) throw new Error(t("mcp.auth.choose_workspace"));
      let client: Client = initialClient;
      setNeedsReload(false);
      setNeedsCredentials(false);
      setWaitingForSessions(false);
      setPreparation(t("mcp.auth.preparing_sign_in"));
      const name = resolveMcpSignInName(entry);
      if (entry.requiresOauthClient && (!entry.oauthConfig?.clientId || (!entry.oauthClientIdOnly && !entry.oauthConfig.clientSecret))) {
        setNeedsCredentials(true);
        throw new Error(t("mcp.auth.client_registration_required"));
      }
      let directory = normalizeDirectoryPath(latest.current.projectDir).replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
      if (!directory) directory = unwrap(await client.path.get()).directory;
      signal.throwIfAborted();
      if (!directory) throw new Error(t("mcp.pick_workspace_first"));

      let reloaded = false;
      const readStatus = async () => {
        client = latest.current.client ?? client;
        return unwrap(await client.mcp.status({ directory }))[name];
      };
      const reload = async () => {
        if (latest.current.isRemoteWorkspace || !latest.current.onReloadEngine || reloaded) {
          setNeedsReload(true);
          throw new Error(t("mcp.auth.server_not_registered"));
        }
        if (latest.current.reloadBlocked) {
          setWaitingForSessions(true);
          setPreparation(t("mcp.auth.waiting_for_conversation_title"));
          while (latest.current.reloadBlocked) await pause(signal);
        }
        signal.throwIfAborted();
        setWaitingForSessions(false);
        setPreparation(t("mcp.auth.applying_changes_title"));
        await latest.current.onReloadEngine?.();
        reloaded = true;
        signal.throwIfAborted();
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try { if (await readStatus()) return; } catch { /* Worker is restarting. */ }
          await pause(signal);
        }
        setNeedsReload(true);
        throw new Error(t("mcp.auth.server_not_registered"));
      };

      // An anonymous MCP handshake can be connected. Explicit sign-in still
      // always calls auth.start; a status snapshot is only an availability check.
      let status;
      try { status = await readStatus(); } catch (error) {
        if (!latest.current.reloadRequired) throw error;
      }
      signal.throwIfAborted();
      if (!status) await reload();
      if (status?.status === "disabled") throw new Error(t("mcp.auth.server_disabled"));

      let listenerId: string | undefined;
      let notice: string | undefined;
      const oauth = entry.oauthConfig;
      const redirectUri = oauth?.redirectUri ?? `http://127.0.0.1:${oauth?.callbackPort ?? 19876}/mcp/oauth/callback`;
      let cleanup: Promise<void> | undefined;
      const dispose = () => {
        signal.removeEventListener("abort", onAbort);
        if (listenerId && !cleanup) cleanup = mcpOAuthCancel(listenerId).catch(() => {});
        return cleanup;
      };
      const onAbort = () => { void dispose(); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (isDesktopRuntime()) {
        const listen = async () => {
          const listener = await mcpOAuthListen({ redirectUri });
          listenerId = listener.listenerId;
          if (signal.aborted) { await dispose(); signal.throwIfAborted(); }
        };
        try {
          await listen();
        } catch (error) {
          signal.throwIfAborted();
          // Old engine-owned OAuth listeners hold the callback port until restart.
          // Apply once, when idle, then let the app bind before starting OAuth.
          if (getMcpOAuthErrorMessage(error).includes("MCP_OAUTH_CALLBACK_IN_USE") && !latest.current.isRemoteWorkspace && latest.current.onReloadEngine && !reloaded) {
            await reload();
            try { await listen(); } catch (retryError) {
              signal.throwIfAborted();
              notice = t("mcp.auth.automatic_return_unavailable", { message: getMcpOAuthErrorMessage(retryError) });
            }
          } else {
            notice = t("mcp.auth.automatic_return_unavailable", { message: getMcpOAuthErrorMessage(error) });
          }
        }
      } else {
        notice = t("mcp.auth.callback_error_notice");
      }
      signal.throwIfAborted();
      setPreparation(t("mcp.auth.requesting_link"));
      const authClient = client;
      const activeListenerId = listenerId;
      return {
        start: async () => {
          try {
            return unwrap(await authClient.mcp.auth.start({ name, directory }));
          } catch (error) {
            // Some engine versions mask discovery errors on auth/start as a
            // generic 500, while mcp/status retains the provider's explanation.
            const message = getMcpOAuthErrorMessage(error);
            if (/unexpected server error|check server logs/i.test(message)) {
              const snapshot = await authClient.mcp.status({ directory }).catch(() => null);
              const currentStatus = snapshot?.data?.[name];
              if (currentStatus && "error" in currentStatus && currentStatus.error) {
                throw new Error(currentStatus.error);
              }
            }
            throw error;
          }
        },
        complete: async (code) => unwrap(await authClient.mcp.auth.callback({ name, directory, code })),
        receiveCode: activeListenerId ? (state) => mcpOAuthWait({ listenerId: activeListenerId, state }) : undefined,
        dispose,
        notice,
      };
    },
  }));

  const identity = props.entry ? getMcpIdentityKey(props.entry) : "";
  const ready = Boolean(props.client && props.entry);
  useEffect(() => {
    setCallbackInput("");
    setCopied(false);
    setActionError(null);
    setNeedsReload(false);
    completing.current = false;
    if (props.open && ready) void flow.start();
    return () => flow.cancel();
  }, [props.open, identity, props.projectDir, props.workspaceKey, ready, flow]);

  const close = () => {
    if (flow.getState().phase === "success") { void complete(); return; }
    flow.cancel();
    props.onClose();
  };
  const retry = () => {
    setCallbackInput("");
    setCopied(false);
    setActionError(null);
    void flow.start();
  };
  const configure = () => {
    if (!props.entry || !props.onConfigure) return;
    flow.cancel();
    props.onConfigure({ ...props.entry, requiresOauthClient: true });
  };
  const complete = async () => {
    if (flow.getState().phase !== "success" || completing.current) return;
    completing.current = true;
    try { await latest.current.onComplete(); } catch (error) {
      setActionError(getMcpOAuthErrorMessage(error));
      completing.current = false;
    }
  };
  const reloadAndRetry = async () => {
    if (!props.onReloadEngine || props.reloadBlocked) return;
    flow.cancel();
    setActionError(null);
    try {
      await props.onReloadEngine();
      if (latest.current.open) await flow.start();
    } catch (error) { setActionError(getMcpOAuthErrorMessage(error)); }
  };
  const forceStop = async (sessionId: string) => {
    if (!props.onForceStopSession || forceStopBusy) return;
    setForceStopBusy(sessionId);
    try { await props.onForceStopSession(sessionId); } catch (error) {
      setActionError(getMcpOAuthErrorMessage(error));
    } finally { setForceStopBusy(null); }
  };

  const errorKind = classifyMcpOAuthError(state.error);
  const needsSetup =
    needsCredentials || errorKind === "client_registration_required" || errorKind === "invalid_client";
  const busy = state.phase === "preparing" || state.phase === "completing";
  const waiting = state.phase === "waiting";
  const serverName = props.entry?.name ?? "MCP Server";

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("mcp.auth.connect_server", { server: serverName })}</DialogTitle>
          <DialogDescription>{t("mcp.auth.modal_description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {busy ? (
            <div className="space-y-3 rounded-[20px] border border-dls-border bg-dls-hover px-5 py-6 text-center" role="status">
              <Loader2 size={28} className="mx-auto animate-spin text-dls-accent" />
              <p className="text-sm font-medium">{state.phase === "completing" ? t("mcp.auth.finishing") : preparation}</p>
              {waitingForSessions ? (
                <div className="space-y-2 text-left">
                  <p className="text-xs text-dls-secondary">{t("mcp.auth.reload_blocked")}</p>
                  {(props.activeSessions ?? []).map((session) => (
                    <div key={session.id} className="flex items-center justify-between gap-3 text-xs">
                      <span>{session.title}</span>
                      <Button variant="outline" size="sm" disabled={forceStopBusy !== null} onClick={() => void forceStop(session.id)}>
                        {forceStopBusy === session.id ? t("mcp.auth.force_stopping") : t("mcp.auth.force_stop")}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {state.phase === "success" ? (
            <div className="flex items-center gap-3 rounded-[20px] border border-emerald-7/20 bg-emerald-3/20 p-5" role="status">
              <CheckCircle2 className="text-emerald-11" />
              <div><p className="text-sm font-medium">{t("mcp.auth.connected_title")}</p><p className="text-xs text-dls-secondary">{t("mcp.auth.connected_body", { server: serverName })}</p></div>
            </div>
          ) : null}
          {state.error || actionError ? (
            <div className="space-y-3 rounded-xl border border-red-7/20 bg-red-7/10 p-4" role="alert">
              <p className="whitespace-pre-wrap text-sm text-red-11">{actionError ?? state.error}</p>
              {needsSetup ? (
                <>
                  <p className="text-xs text-dls-secondary">{props.entry?.setupNote ?? t("mcp.auth.setup_hint")}</p>
                  {props.onConfigure ? <Button onClick={configure}>{t("mcp.auth.connection_setup")}</Button> : null}
                </>
              ) : state.phase === "error" ? (
                needsReload && props.onReloadEngine ? (
                  <Button onClick={() => void reloadAndRetry()} disabled={props.reloadBlocked}>
                    <RefreshCcw size={14} />{t("mcp.auth.reload_engine_retry")}
                  </Button>
                ) : <Button variant="outline" onClick={retry}>{t("mcp.auth.retry")}</Button>
              ) : waiting ? <Button variant="outline" onClick={() => { flow.cancel(); retry(); }}>{t("mcp.auth.start_new_sign_in")}</Button> : null}
            </div>
          ) : null}
          {waiting && state.authorizationUrl ? (
            <div className="space-y-4 rounded-[20px] border border-dls-border bg-dls-hover p-4">
              <p className="text-sm font-medium">{t("mcp.auth.waiting_authorization")}</p>
              <p className="text-xs text-dls-secondary">{state.notice ?? t("mcp.auth.approve_in_browser")}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void flow.reopen()}>{t("mcp.auth.open_sign_in_page")}</Button>
                <Button variant="outline" onClick={() => {
                  void navigator.clipboard.writeText(state.authorizationUrl ?? "").then(() => setCopied(true), () => setActionError(t("mcp.auth.copy_failed")));
                }}>{copied ? t("mcp.auth.copied") : t("mcp.auth.copy_link")}</Button>
              </div>
              <details open={Boolean(state.notice)}>
                <summary className="cursor-pointer text-xs font-medium">{t("mcp.auth.finish_with_callback")}</summary>
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-dls-secondary">{t("mcp.auth.callback_help")}</p>
                  <TextInput label={t("mcp.auth.callback_label")} placeholder={t("mcp.auth.callback_placeholder")} value={callbackInput} onChange={(event) => setCallbackInput(event.currentTarget.value)} />
                  <Button onClick={() => void flow.submit(callbackInput)} disabled={!callbackInput.trim()}>{t("mcp.auth.complete_connection")}</Button>
                </div>
              </details>
            </div>
          ) : null}
        </div>
        <DialogFooter className="shrink-0">
          {state.phase === "success" ? (
            <Button onClick={() => void complete()}><CheckCircle2 data-icon="inline-start" />{t("mcp.auth.done")}</Button>
          ) : <DialogClose render={<Button variant="outline" />}>{t("mcp.auth.cancel")}</DialogClose>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
