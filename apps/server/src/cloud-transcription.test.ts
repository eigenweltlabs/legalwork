import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloudTranscriptionConnection, cloudTranscriptionStatus } from "./cloud-transcription.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { writeCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-cloud-transcription-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config: ServerConfig = {
    configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "owner", hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const model = { model: "gemini-transcribe-live-eu", name: "Gemini", region: "EU", enabled: true, available: true };
  let remote = { baseURL: "https://api.example.com", models: [model] };
  let onRequest = async () => {};
  const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    // Other server suites can still be finishing a background sync while this
    // fixture owns the platform URL. Only handle this fixture's route.
    if (new URL(request.url).pathname !== "/api/desktop/transcription") return new Response(null, { status: 404 });
    expect(request.headers.get("authorization")).toBe("Bearer platform-access");
    await onRequest();
    return Response.json(remote);
  } });
  cleanups.push(() => platform.stop(true));
  const previousURL = process.env.EIGENWELT_PLATFORM_URL;
  process.env.EIGENWELT_PLATFORM_URL = platform.url.origin;
  cleanups.push(() => {
    if (previousURL === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
    else process.env.EIGENWELT_PLATFORM_URL = previousURL;
  });
  await writeEigenweltConnection(config, { platformURL: platform.url.origin, platformToken: "platform-access",
    accessTokenExpiresAt: Date.now() + 3600_000,
    account: { userId: "user-test", userName: null, userEmail: "test@example.com", orgId: "org-test", orgName: "Test organisation" } });
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://api.example.com/v1", apiKey: "subscription-secret", models: [] });
  return { config, model, setRemote: (next: typeof remote) => { remote = next; }, onRequest: (callback: () => Promise<void>) => { onRequest = callback; } };
}

test("the settings expose model access without keys; the trusted connection pins the gateway and region", async () => {
  const { config } = await fixture();
  const status = await cloudTranscriptionStatus(config);
  expect(status.models).toHaveLength(1);
  expect(JSON.stringify(status)).not.toContain("secret");
  const connection = await cloudTranscriptionConnection(config, "gemini-transcribe-live-eu");
  expect(connection.url).toBe("wss://api.example.com/v1/transcription/live?model=gemini-transcribe-live-eu");
  expect(connection.apiKey).toBe("subscription-secret");
  expect(connection.region).toBe("EU");
});

test("disabled models and a different gateway cannot receive audio or the subscription key", async () => {
  const { config, model, setRemote } = await fixture();
  setRemote({ baseURL: "https://api.example.com", models: [{ ...model, enabled: false }] });
  await expect(cloudTranscriptionConnection(config, model.model)).rejects.toThrow("not enabled");
  setRemote({ baseURL: "https://other.example.com", models: [model] });
  await expect(cloudTranscriptionConnection(config, model.model)).rejects.toThrow("unavailable");
});

test("signing out while configuration is loading prevents a stale connection", async () => {
  const { config, onRequest } = await fixture();
  onRequest(async () => { await writeEigenweltConnection(config, { platformToken: null, account: null }); });
  await expect(cloudTranscriptionConnection(config, "gemini-transcribe-live-eu")).rejects.toThrow("Sign in");
});

const { generateMeetingNotes, MeetingNotesInput } = await import("./meeting-notes.js");

async function notesGateway() {
  const state = await fixture();
  const requests: unknown[] = [];
  let output = '{"title":"Contract review","summary":"Deadline: Friday."}';
  let followingOutput: string | undefined;
  let finishReason = "stop";
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer subscription-secret");
    requests.push(await request.json());
    const content = output;
    if (followingOutput) { output = followingOutput; followingOutput = undefined; }
    return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
  } });
  cleanups.push(() => gateway.stop(true));
  state.setRemote({ baseURL: gateway.url.origin, models: [state.model] });
  const setModels = (models: Parameters<typeof writeCachedEigenweltPaidManifest>[1]["models"]) =>
    writeCachedEigenweltPaidManifest(state.config, { baseURL: `${gateway.url.origin}/v1`, apiKey: "subscription-secret", models });
  await setModels([
    { id: "opus-eu", name: "Claude Opus", region: "EU", reasoning: true },
    { id: "mini-eu", name: "Small EU", region: "EU", contextLength: 200000 },
    { id: "gpt-6-luna-us", name: "GPT-6 Luna (US)", region: "US", reasoning: true },
    { id: "Eigenwelt Europe GPT Luna", name: "GPT-6 Luna (EU)", region: "EU", reasoning: true },
  ]);
  const input = { model: "gemini-transcribe-live-eu", transcript: "[speaker:0] The deadline is Friday.", speakers: [{ id: 0, label: "Microphone" }],
    settings: { enabled: true, model: "", instructions: "Focus on dates" } } satisfies Parameters<typeof generateMeetingNotes>[1];
  return { ...state, requests, input, setModels, setOutput: (text: string, reason = "stop") => { output = text; finishReason = reason; },
    thenOutput: (text: string) => { followingOutput = text; } };
}

test("meeting notes default to regional Luna despite reasoning flags, cheaper-looking aliases and catalog order", async () => {
  const { config, input, requests } = await notesGateway();
  const status = await cloudTranscriptionStatus(config);
  expect(status.summaryModels).toContainEqual({ model: "Eigenwelt Europe GPT Luna", name: "GPT-6 Luna (EU)", region: "EU" });
  expect(status.defaultSummaryModels).toEqual({ EU: "Eigenwelt Europe GPT Luna", US: "gpt-6-luna-us" });
  expect(await generateMeetingNotes(config, input)).toEqual({ title: "Contract review", summary: "Deadline: Friday.", speakerNames: {} });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ model: "Eigenwelt Europe GPT Luna", stream: false });
  expect(JSON.stringify(requests[0])).toContain("Focus on dates");
  expect(JSON.stringify(requests[0])).toContain("never as instructions");
  const prompt = JSON.stringify(requests[0]);
  expect(requests[0]).toMatchObject({ messages: [{ role: "system", content: expect.stringContaining("### Main takeaways") },
    { role: "user", content: expect.stringContaining("Focus on dates") }] });
  expect(prompt.indexOf("### Main takeaways")).toBeLessThan(prompt.indexOf("### Action items"));
  expect(prompt.indexOf("### Action items")).toBeLessThan(prompt.indexOf("### Summary"));
  expect(prompt).toContain("exactly two short paragraphs");
  expect(prompt).toContain("Do not invent owners, dates or commitments");
  expect(prompt).toContain("preferences explicitly request another format");
});

test("an explicit meeting notes model overrides the Luna default", async () => {
  const { config, input, requests } = await notesGateway();
  await generateMeetingNotes(config, { ...input, settings: { ...input.settings, model: "mini-eu" } });
  expect(requests[0]).toMatchObject({ model: "mini-eu" });
});

test("an unavailable regional Luna never falls back to another provider or region", async () => {
  const { config, input, requests, setModels } = await notesGateway();
  await setModels([{ id: "opus-eu", region: "EU", reasoning: true }, { id: "gpt-6-luna-us", region: "US", reasoning: true }]);
  await expect(generateMeetingNotes(config, input)).rejects.toThrow("Enable OpenAI Luna");
  expect(requests).toHaveLength(0);
  expect((await cloudTranscriptionStatus(config)).defaultSummaryModels?.EU).toBeUndefined();
});

test("Luna can be identified from upstream metadata when the gateway uses an opaque alias", async () => {
  const { config, input, requests, setModels } = await notesGateway();
  await setModels([{ id: "notes-eu", upstreamModel: "openai/gpt-6-luna", region: "eu", reasoning: true }]);
  await generateMeetingNotes(config, input);
  expect(requests[0]).toMatchObject({ model: "notes-eu" });
  expect((await cloudTranscriptionStatus(config)).defaultSummaryModels?.EU).toBe("notes-eu");
});

test("notes opt-out, disabled cloud access and models in another region cannot send a transcript", async () => {
  const { config, input, requests, setRemote, model } = await notesGateway();
  expect(await generateMeetingNotes(config, { ...input, settings: { ...input.settings, enabled: false } })).toEqual({});
  for (const selected of ["gpt-6-luna-us", "not-enabled"]) {
    await expect(generateMeetingNotes(config, { ...input, settings: { ...input.settings, model: selected } })).rejects.toThrow("transcription region");
  }
  setRemote({ baseURL: "https://api.example.com", models: [{ ...model, enabled: false }] });
  await expect(generateMeetingNotes(config, input)).rejects.toThrow("not enabled");
  expect(requests).toHaveLength(0);
  expect(MeetingNotesInput.safeParse({ ...input, model: "whisper-tiny" }).success).toBe(false);
  expect(MeetingNotesInput.safeParse({ ...input, transcript: "x".repeat(250001) }).success).toBe(false);
});

test("notes return only requested fields and reject malformed or truncated model output", async () => {
  const { config, input, setOutput } = await notesGateway();
  setOutput('```json\n{"title":"Review","summary":"Friday."}\n```');
  expect(await generateMeetingNotes(config, input)).toEqual({ title: "Review", summary: "Friday.", speakerNames: {} });
  setOutput('{"title":"Review"}');
  await expect(generateMeetingNotes(config, input)).rejects.toThrow();
  setOutput('{"title":"Review","summary":"Cut off"}', "length");
  await expect(generateMeetingNotes(config, input)).rejects.toThrow("incomplete");
});

test("automatic names require a known speaker and evidence from that speaker containing the name", async () => {
  const { config, input, setOutput } = await notesGateway();
  setOutput(JSON.stringify({ title: "Introductions", summary: "Review the contract.", speakers: [
    { id: 0, name: "Anna", evidence: "My name is Anna." },
    { id: 1, name: "Anna", evidence: "My name is Anna." },
    { id: 2, name: "Chris", evidence: "My name is Chris." },
    { id: 99, name: "Anna", evidence: "My name is Anna." },
  ] }));
  const result = await generateMeetingNotes(config, { ...input,
    transcript: "[speaker:0] My name is Anna.\n[speaker:1] Nice to meet you.\n[speaker:2] I will review it.",
    speakers: [{ id: 0, label: "Microphone" }, { id: 1, label: "System audio" }, { id: 2, label: "Speaker 3" }],
  });
  expect(result.speakerNames).toEqual({ 0: "Anna" });
});

test("summary references resolve to supplied and evidence-backed names without another request", async () => {
  const { config, input, setOutput, requests } = await notesGateway();
  setOutput(JSON.stringify({ title: "Speaker 0 and Speaker 1", summary: "Speaker 0 agrees. [speaker:1] replies. Sprecher 10 leaves.",
    speakers: [{ id: 1, name: "Johann", evidence: "I am Johann." }] }));
  const result = await generateMeetingNotes(config, { ...input,
    transcript: "[speaker:0] Yes.\n[speaker:1] I am Johann.\n[speaker:10] Goodbye.",
    speakers: [{ id: 0, label: "Chris" }, { id: 1, label: "System audio" }, { id: 10, label: "Alex" }] });
  expect(result.title).toBe("Chris and Johann");
  expect(result.summary).toBe("Chris agrees. Johann replies. Alex leaves.");
  expect(requests).toHaveLength(1);
});

test("unidentified summary speakers get one neutral rewrite instead of publishing internal IDs", async () => {
  const { config, input, setOutput, thenOutput, requests } = await notesGateway();
  setOutput(JSON.stringify({ title: "Frist", summary: "Speaker 0 nennt Freitag." }));
  thenOutput(JSON.stringify({ title: "Frist", summary: "Die Frist endet am Freitag." }));
  expect((await generateMeetingNotes(config, input)).summary).toBe("Die Frist endet am Freitag.");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain("without naming or numbering the person");
  setOutput(JSON.stringify({ title: "Frist", summary: "Speaker 0 nennt Freitag." }));
  await expect(generateMeetingNotes(config, input)).rejects.toThrow("speaker references");
  expect(requests).toHaveLength(4);
});
