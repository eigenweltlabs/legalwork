// Explicit released-engine protocols. Raw wire evidence remains separate from
// these read-only benchmark views; production clients never use this adapter.
const locationQuery = (directory) =>
  new URLSearchParams({ "location[directory]": directory }).toString();
function array(value, label) {
  if (!Array.isArray(value))
    throw new Error(`Invalid ${label}: expected complete array`);
  return value;
}
async function pages(read, path, parameters) {
  const result = [];
  const seen = new Set();
  let cursor;
  do {
    const query = new URLSearchParams(cursor ? undefined:parameters);
    if (cursor) query.set("cursor", cursor);
    const page = await read(`${path}?${query}`);
    result.push(...array(page.data, path));
    cursor = page.cursor?.next ?? undefined;
    if (cursor && seen.has(cursor))
      throw new Error(`Repeated native page cursor at ${path}`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}
export function attributeSessionHistory(entries, requestedSessionID) {
  if(typeof requestedSessionID!=="string" || !requestedSessionID)throw new Error("Exact requested session identity is required");
  return entries.map(entry=>{
    const actual=entry.info?.sessionID??entry.sessionID;
    if(actual!==undefined&&actual!==requestedSessionID || entry.benchmarkRequestedSessionID!==undefined&&entry.benchmarkRequestedSessionID!==requestedSessionID)throw new Error("Returned engine history conflicts with the exact requested session");
    return {...entry,benchmarkRequestedSessionID:requestedSessionID};
  });
}
export async function detectEngineProtocol(driver, directory) {
  let info;
  try {
    info = await driver.engine("/api/info");
  } catch (error) {
    // The frozen v1 server serves its HTML application fallback for unknown
    // /api paths. Accept that only after the real v1 health contract below
    // positively identifies a healthy released v1 engine.
    if (![404, 405].includes(error.status) && error.code !== "html-fallback-response") throw error;
  }
  if (info?.version?.startsWith("2.")) {
    const scoped = (path) => `${path}?${locationQuery(directory)}`;
    let readiness;
    const ready = () =>
      (readiness ??= driver.engine(scoped("/api/model")).catch((error) => {
        readiness = undefined;
        throw error;
      }));
    return {
      id: "native-v2",
      version: info.version,
      health: { healthy: true, ...info },
      eventPath: "/api/event",
      directory,
      ready,
      skills: async () => {
        await ready();
        return array(
          (await driver.engine(scoped("/api/skill"))).data,
          "native skills",
        );
      },
      catalogs: async () => {
        const models = await ready();
        const [providers, agents, plugins, mcp, toolCatalog] =
          await Promise.all([
            driver.engine(scoped("/api/provider")),
            driver.engine(scoped("/api/agent")),
            driver.engine(scoped("/api/plugin")),
            driver.engine(scoped("/api/mcp")),
            driver.observerCatalog(),
          ]);
        const observed = toolCatalog;
        if (
          observed?.observer?.id !== "legalwork-benchmark-observer" ||
          observed.observer.mutatesEngine !== false ||
          observed.schemaCoverage !== "complete"
        )
          throw new Error(
            "Complete native tool schemas require the explicit read-only benchmark observer plugin; run setup-observer first",
          );
        const tools = array(observed.tools, "observed native tools");
        return {
          providers,
          models,
          agents,
          plugins,
          mcp,
          toolCatalog: observed,
          tools: tools.map((tool) => tool.id),
        };
      },
      messages: async (sessionID) =>
        attributeSessionHistory(await pages(
          driver.engine,
          `/api/session/${encodeURIComponent(sessionID)}/message`,
          { order: "asc" },
        ),sessionID),
      sessions: (parentID) =>
        pages(driver.engine, "/api/session", {
          directory,
          parentID,
          order: "asc",
        }),
      active: async () => (await driver.engine("/api/session/active")).data,
      inbox: async (sessionID) =>
        array(
          (await driver.engine(`/api/session/${encodeURIComponent(sessionID)}/inbox`)).data,
          "native session inbox",
        ),
      interactions: async () => {
        const [permissions, forms, host] = await Promise.all([
          driver.engine(scoped("/api/permission/request")),
          driver.engine(scoped("/api/form")),
          driver.pendingHostApprovals(),
        ]);
        return {
          permissions: array(permissions.data, "native permission requests"),
          forms: array(forms.data, "native forms"),
          host: array(host,"scoped host approvals"),
        };
      },
      session: async (sessionID) =>
        (await driver.engine(`/api/session/${encodeURIComponent(sessionID)}`))
          .data,
      stop: sessionID => driver.engine(`/api/session/${encodeURIComponent(sessionID)}/interrupt`,{}),
      isAssistant: (message) => message.type === "assistant",
      info: (message) => message,
      isBusy: (state, id) => state[id]?.type === "running",
      model: (message) => ({
        providerID: message.model?.providerID,
        modelID: message.model?.id,
        variant: message.model?.variant,
      }),
      limitations: [
        "Registered tools are a location catalog; ctx.tool.list has no agent/session selection argument. Actual model-visible tools and schema changes are captured in every model request; native agent and session permissions are retained separately.",
        "Native events are live-only. A disconnected raw capture fails the evidence run rather than claiming gap-free replay.",
      ],
    };
  }
  if (info?.version && !info.version.startsWith("1."))
    throw new Error(`Unsupported released engine version: ${info.version}`);
  const health = await driver.engine("/global/health");
  if (health.healthy !== true || !health.version?.startsWith("1."))
    throw new Error("Cannot establish a supported healthy v1/v2 engine");
  return {
    id: "legacy-v1",
    version: health.version,
    health,
    eventPath: "/global/event",
    directory,
    skills: async () => {
      const value = await driver.engine("/skill");
      return array(Array.isArray(value) ? value : value.items, "v1 skills");
    },
    catalogs: async () => {
      const [providers, tools] = await Promise.all([
        driver.engine("/provider"),
        driver.engine("/experimental/tool/ids"),
      ]);
      return {
        providers,
        tools: array(tools, "v1 tool IDs"),
        toolCatalog: null,
      };
    },
    messages: async (sessionID) =>
      attributeSessionHistory(await driver.engine(`/session/${encodeURIComponent(sessionID)}/message`),sessionID),
    sessions: (parentID) =>
      driver.engine(`/session/${encodeURIComponent(parentID)}/children`),
    active: () => driver.engine("/session/status"),
    // The frozen v1 protocol has no native inbox. Its active/retry state and
    // complete history remain authoritative for the baseline.
    inbox: async () => [],
    interactions: async () => {
      const [permissions, forms, host] = await Promise.all([
        driver.engine("/permission"),
        driver.engine("/question"),
        driver.pendingHostApprovals(),
      ]);
      return {
        permissions: array(permissions, "v1 permission requests"),
        forms: array(forms, "v1 questions"),
        host: array(host,"scoped host approvals"),
      };
    },
    session: (sessionID) =>
      driver.engine(`/session/${encodeURIComponent(sessionID)}`),
    stop: sessionID => driver.engine(`/session/${encodeURIComponent(sessionID)}/abort`,{}),
    isAssistant: (message) => message.info?.role === "assistant",
    info: (message) => message.info,
    isBusy: (state, id) => ["busy", "retry"].includes(state[id]?.type),
    model: (message) => ({
      providerID: message.info?.providerID,
      modelID: message.info?.modelID,
      variant: message.info?.variant,
    }),
    limitations: [
      "The frozen v1 public tool-ID endpoint exposes IDs rather than complete schemas. Effective complete schemas remain authoritative in captured model requests.",
    ],
  };
}
export async function observeSessionActivity(protocol, sessionIDs) {
  const ids = [...sessionIDs];
  const [active, inboxes] = await Promise.all([
    protocol.active(),
    Promise.all(ids.map(async (id) => [id, await protocol.inbox(id)])),
  ]);
  const inboxBySessionID = Object.fromEntries(inboxes);
  return {
    active,
    inboxBySessionID,
    unsettledSessionIDs: ids.filter(
      (id) => protocol.isBusy(active, id) || inboxBySessionID[id].length > 0,
    ),
  };
}

/** No decisions are inferred from a permission's wording. An autonomous task
 * cannot be claimed complete after a human approval, rejection, or answer. */
export async function observeSessionInteractions(protocol, sessionIDs) {
  const ids = new Set(sessionIDs);
  const interactions = await protocol.interactions();
  return {
    permissions: interactions.permissions.filter(request => ids.has(request.sessionID)),
    forms: interactions.forms.filter(request => ids.has(request.sessionID)),
    // A same-workspace approval without session attribution cannot be assumed
    // unrelated to this isolated task. Hold it without making a decision.
    host: array(interactions.host,"scoped host approvals").filter(request=>!request.sessionID || ids.has(request.sessionID)),
  };
}

export async function sessionTreeIDs(protocol, rootID) {
  const ids = new Set([rootID]);
  async function visit(parentID) {
    for (const child of await protocol.sessions(parentID)) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      await visit(child.id);
    }
  }
  await visit(rootID);
  return ids;
}
export function skillCatalogIdentity(skills) {
  return JSON.stringify(
    skills
      .map(({ name, description, content }) => ({ name, description, content }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}
export function engineEventIdentity(event) {
  const value = event.payload ?? event;
  return {
    protocol: value.data !== undefined ? "native-v2" : "legacy-v1",
    type: value.type,
    id: value.id ?? null,
    created: value.created ?? null,
    sessionID: value.data?.sessionID ?? value.properties?.sessionID ?? null,
    location: value.location ?? event.directory ?? null,
    durable: value.durable ?? null,
  };
}
