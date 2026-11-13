import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { connectorStatusSchema } from "@legalwork/types/connectors";
import { LegalworkServerError } from "../src/app/lib/legalwork-server";
import { connectorStatusQuery } from "../src/react-app/domains/settings/connector-status-query";

const connected = connectorStatusSchema.parse({ configured: true, requiresSignIn: false, connectors: [
  { id: "outlook", name: "Outlook Email", configured: true, active: true, connections: [{ id: "saved", createdAt: null, needsReconnect: false }] },
] });

test("saved connector lookup recovers from startup timeouts without reconnecting the account", async () => {
  const cache = new QueryClient();
  let reads = 0;
  const reader = { baseUrl: "http://local.test", connectorSavedStatus: async () => {
    if (++reads < 3) throw new LegalworkServerError(503, "server_starting", "Request timed out.");
    return connected;
  } };
  try {
    expect(await cache.fetchQuery({ ...connectorStatusQuery(reader), retryDelay: 0 })).toEqual(connected);
    expect(reads).toBe(3);
  } finally { cache.clear(); }
});

test("an exhausted lookup can be refreshed, and a background timeout retains known accounts", async () => {
  const cache = new QueryClient();
  let unavailable = false, reads = 0;
  const reader = { baseUrl: "http://local.test", connectorSavedStatus: async () => {
    reads++;
    if (unavailable) throw new Error("Request timed out.");
    return connected;
  } };
  const options = { ...connectorStatusQuery(reader), retryDelay: 0, staleTime: 0 };
  try {
    await cache.fetchQuery(options);
    unavailable = true;
    await expect(cache.fetchQuery(options)).rejects.toThrow("Request timed out.");
    expect(cache.getQueryData(options.queryKey)).toEqual(connected);
    unavailable = false;
    expect(await cache.fetchQuery(options)).toEqual(connected);
    expect(reads).toBe(5);
  } finally { cache.clear(); }
});

test("permission denials are not retried and different servers never share account state", async () => {
  const cache = new QueryClient();
  let reads = 0;
  const reader = { baseUrl: "http://denied.test", connectorSavedStatus: async () => {
    reads++;
    throw new LegalworkServerError(403, "forbidden", "Access denied");
  } };
  try {
    await expect(cache.fetchQuery({ ...connectorStatusQuery(reader), retryDelay: 0 })).rejects.toThrow("Access denied");
    expect(reads).toBe(1);
    const other = { baseUrl: "http://other.test", connectorSavedStatus: async () => connected };
    expect(await cache.fetchQuery(connectorStatusQuery(other))).toEqual(connected);
    expect(cache.getQueryData(connectorStatusQuery(reader).queryKey)).toBeUndefined();
    expect(connectorStatusQuery(null).enabled).toBe(false);
  } finally { cache.clear(); }
});
