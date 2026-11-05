/** Stop must cancel template expansion as well as an admitted model turn. */
export const commandSettingsRpc = {
  id: "legalwork.commands",
  methods: {
    invoke: {
      input: { type: "object", properties: { sessionID: { type: "string" }, messageID: { type: "string" }, name: { type: "string" }, prompt: { type: "object" }, delivery: { type: "string", enum: ["queue", "steer"] } }, required: ["sessionID", "messageID", "name", "prompt", "delivery"], additionalProperties: false },
      output: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] },
    },
    refresh: { input: { type: "object" }, output: { type: "object", properties: { refreshed: { type: "boolean" } }, required: ["refreshed"] } },
    cancel: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { cancelled: { type: "boolean" } }, required: ["cancelled"] },
    },
  },
  events: {},
} satisfies import("@opencode/schema/rpc").PortableDefinition;
