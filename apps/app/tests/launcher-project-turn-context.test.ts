import { expect, test } from "bun:test";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { hashDraftProfile } from "../src/react-app/launcher/draft-profile";
import { projectTurnContext } from "../src/react-app/launcher/project-turn-context";
import { useFusionStore } from "../src/react-app/domains/session/fusion/fusion-store";

test("the Mini Bar sends the registered project's dashboard and selected Fusion models", async () => {
  const baseUrl = "http://localhost:5015";
  const client = { ...createLegalworkServerClient({ baseUrl, token: "account-a" }), listUserEnvKeys: async () => ({ keys: ["DEMO_PROJECT_KEY"] }) };
  const other = { ...createLegalworkServerClient({ baseUrl, token: "account-b" }), listUserEnvKeys: async () => ({ keys: [] }) };
  const workspace = { id: "registered-project", path: "/synthetic/project", contentPath: "/synthetic/documents" };
  const sessionId = "ses_registered_project";
  const models = [{ providerID: "vendor", modelID: "candidate-one" }, { providerID: "vendor", modelID: "candidate-two" }];
  const fusion = useFusionStore.getState();
  fusion.setEnabled(sessionId, true);
  fusion.setSelectedModels(sessionId, models);
  fusion.startTurn(sessionId, {
    userText: "Previous turn", phase: "done", baselineMessageIds: [],
    runs: models.map(model => ({ model, text: "Synthetic prior results", sessionID: null, status: "done", reasoning: "", error: null })),
  });
  const context = { workspaceId: workspace.id, workspaceName: "Migrated project", capturedAt: 1,
    dashboard: { sessionId, profile: await hashDraftProfile(client.draftProfile), context: "Dashboard: Evidence tracker" } };
  try {
    const [part] = await projectTurnContext(client, workspace, sessionId, context, true, false) ?? [];
    expect(part).toMatchObject({ type: "text", synthetic: true });
    expect(part?.text).toContain("Dashboard: Evidence tracker");
    expect(part?.text).toContain("vendor/candidate-one");
    expect(part?.text).toContain("vendor/candidate-two");
    expect(part?.text).toContain("DEMO_PROJECT_KEY");
    const switched = await projectTurnContext(other, workspace, sessionId, context, true, true);
    expect(switched).toBeUndefined();
  } finally {
    fusion.clearTurn(sessionId);
    fusion.setEnabled(sessionId, false);
    fusion.setSelectedModels(sessionId, []);
  }
});
