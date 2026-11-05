import type { OpenCodeClient } from "@opencode/client";
import { z } from "zod";

export const nativeModelInventorySchema = z.object({ models: z.array(z.string()) }).strict();
export const nativeModelCatalogRequestSchema = z.object({ providerID: z.string() }).strict();
export const nativeModelCatalogRpc = {
  id: "legalwork.model-catalog",
  methods: {
    inventory: {
      input: { type: "object", properties: { providerID: { type: "string" } }, required: ["providerID"], additionalProperties: false },
      output: { type: "object", properties: { models: { type: "array", items: { type: "string" } } }, required: ["models"], additionalProperties: false },
    },
  },
  events: {},
} satisfies import("@opencode/schema/rpc").PortableDefinition;

/** Server-side inventory lookup. Only IDs cross this boundary; provider keys,
 * model settings and transport headers remain inside the engine. */
export async function nativeModelCatalogInventory(client: OpenCodeClient, location: { directory: string }, providerID: string): Promise<string[]> {
  return nativeModelInventorySchema.parse(await client.rpc(nativeModelCatalogRpc).inventory({ providerID }, { location })).models;
}
