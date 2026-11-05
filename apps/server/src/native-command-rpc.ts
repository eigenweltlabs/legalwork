/** Stop must cancel template expansion as well as an admitted model turn. */
export const commandSettingsRpc = {
  id: "legalwork.commands",
  methods: {
    refresh: { input: { type: "object" }, output: { type: "object", properties: { refreshed: { type: "boolean" } }, required: ["refreshed"] } },
    cancel: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { cancelled: { type: "boolean" } }, required: ["cancelled"] },
    },
  },
  events: {},
} satisfies import("@opencode/schema/rpc").PortableDefinition;
