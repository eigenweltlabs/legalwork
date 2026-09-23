import { useEffect, useId, useState } from "react";
import {
  contactsResultSchema,
  type ContactSuggestion,
} from "../../../../../server/src/mail/contacts-view";
import type { MailClient } from "./mail-client";
/** Suggestions replace only the unfinished recipient, preserving earlier addresses. */
export function recipientFragment(value: string) {
  const boundary = Math.max(value.lastIndexOf(","), value.lastIndexOf(";"));
  return {
    prefix: boundary < 0 ? "" : value.slice(0, boundary + 1) + " ",
    query: value.slice(boundary + 1).trim(),
  };
}
export function recipientOptions(
  value: string,
  contacts: ContactSuggestion[],
  history: string[],
) {
  const { prefix, query } = recipientFragment(value),
    seen = new Set<string>();
  return [
    ...contacts.map((contact) => ({
      address: contact.address,
      label: `${contact.name || contact.address} · Personal contacts`,
    })),
    ...history
      .filter((address) => address.toLowerCase().includes(query.toLowerCase()))
      .map((address) => ({ address, label: "Recent draft recipient" })),
  ]
    .flatMap((item) => {
      const key = item.address.toLowerCase();
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ value: prefix + item.address, label: item.label }];
    })
    .slice(0, 30);
}
export function MailRecipientInput({
  client,
  account,
  label,
  value,
  onChange,
  history,
}: {
  client: MailClient;
  account: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  history: string[];
}) {
  const list = useId(),
    [contacts, setContacts] = useState<ContactSuggestion[]>([]);
  const { query } = recipientFragment(value);
  useEffect(() => {
    const controller = new AbortController();
    setContacts([]);
    const timer = setTimeout(() => {
      void client
        .request(
          `/accounts/${encodeURIComponent(account)}/contacts`,
          contactsResultSchema,
          controller.signal,
          { action: "search", query: query.slice(0, 256) },
        )
        .then((result) => {
          if (!controller.signal.aborted) setContacts(result.items);
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, account, query]);
  return (
    <>
      <input
        aria-label={label}
        list={list}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Name or email address"
      />
      <datalist id={list}>
        {recipientOptions(value, contacts, history).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </datalist>
    </>
  );
}
