import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  contactsResultSchema,
  type ContactsResult,
} from "../../../../../../server/src/mail/contacts-view";
import type { MailClient, MailAccountView } from "../../mail/mail-client";
import { MailSettingsSection } from "./mail-settings-controls";
const errors = {
  permission:
    "Contact access is missing or was revoked. Reconnect and allow personal contacts. Google People API must be enabled; your organization may restrict consent.",
  unavailable:
    "Contacts could not be refreshed. Cached suggestions remain available. Retry when connected.",
  limit:
    "This address book exceeds the supported synchronization limit. The previous copy is retained.",
  invalid_response:
    "The provider response could not be verified. The previous copy is retained.",
};
export function MailContactsView({
  client,
  accounts,
  onAuthorize,
}: {
  client: MailClient;
  accounts: MailAccountView[];
  onAuthorize: (account: MailAccountView) => void;
}) {
  return (
    <MailSettingsSection
      title="Address books"
      description="Use personal contacts when choosing recipients. Changes made at your provider appear after synchronization."
    >
      <div className="divide-y divide-subtle">
        {accounts
          .filter((account) => account.provider !== "archive")
          .map((account) => (
            <ContactBook
              key={account.id}
              client={client}
              account={account}
              onAuthorize={() => onAuthorize(account)}
            />
          ))}
        <p className="py-3 text-xs text-muted-foreground">
          Organization directories and shared address books have separate
          permissions and are not connected. CardDAV / iCloud contacts are not
          supported; IMAP mail access does not grant address book access.
        </p>
      </div>
    </MailSettingsSection>
  );
}
function ContactBook({
  client,
  account,
  onAuthorize,
}: {
  client: MailClient;
  account: MailAccountView;
  onAuthorize: () => void;
}) {
  const [status, setStatus] = useState<ContactsResult | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await client.request(
          `/accounts/${encodeURIComponent(account.id)}/contacts`,
          contactsResultSchema,
          controller.signal,
          { action: "status" },
        );
        if (!controller.signal.aborted) {
          setStatus(value);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setError(
            "Address book status is unavailable. Reconnect this account if it is disconnected.",
          );
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, account.id]);
  async function action(action: "sync" | "disable") {
    const controller = active.current;
    if (!controller || busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await client.request(
        `/accounts/${encodeURIComponent(account.id)}/contacts`,
        contactsResultSchema,
        controller.signal,
        { action },
      );
      if (!controller.signal.aborted) setStatus(value);
    } catch {
      if (!controller.signal.aborted)
        setError("The address book could not be updated. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const supported =
    (account.provider === "gmail" || account.provider === "graph") &&
    !account.identity;
  return (
    <div className="py-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{account.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {supported
              ? account.provider === "gmail"
                ? "Google personal contacts"
                : "Microsoft personal contacts · default folder"
              : "No personal address book connection"}
          </p>
        </div>
        {supported && (
          <div className="flex gap-2">
            {(!status?.enabled || status.error === "permission") && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onAuthorize}
              >
                Connect contacts
              </Button>
            )}
            {status?.enabled && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || status.state === "syncing"}
                  onClick={() => void action("sync")}
                >
                  {status.state === "syncing" ? "Syncing…" : "Sync now"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void action("disable")}
                >
                  Remove local contacts
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {status?.enabled && (
        <p role="status" className="text-xs text-muted-foreground">
          {status.count} contacts saved for offline use ·{" "}
          {status.lastSyncAt
            ? `Updated ${new Date(status.lastSyncAt).toLocaleString()}`
            : "First sync pending"}
          . Refreshes every 15 minutes while Mail is running. Edit contacts at
          your provider.
        </p>
      )}
      {(error || status?.error) && (
        <p role="alert" className="text-xs text-muted-foreground">
          {error || (status?.error ? errors[status.error] : "")}
        </p>
      )}
    </div>
  );
}
