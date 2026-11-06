import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AudioStep } from "../src/react-app/domains/onboarding/audio-step";
import { RecorderFlow, type RecorderFeature } from "../src/react-app/domains/onboarding/recorder-flow";
import { useRecorderStore } from "../src/react-app/domains/recorder/recorder-store";

test("Recorder introduction keeps setup and permissions inside its dialog", () => {
  const initial = useRecorderStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, {
    permissions: { platform: "darwin", packaged: true, microphone: "not-determined", systemAudio: "not-determined" },
    dictationReadiness: { platform: "darwin", packaged: true, microphone: "not-determined", inputMonitoring: "not-determined", accessibility: "denied", automation: "not-determined" },
  });
  const queryClient = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AudioStep feature="meetings" legalworkClient={null} workspaceId={null} onBack={() => {}} onDone={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Set up meeting recording");
    expect(html).toContain(">Skip</button>");
    expect(html).not.toContain("Allow microphone access");
    expect(html).not.toContain("Allow system audio access");
    expect(html).not.toContain("Download the speech model");
    expect(html).not.toContain("Input Monitoring");
    expect(html).not.toContain("Accessibility");
    expect(html).not.toContain("Insert dictated text");
    expect(html).not.toContain('data-testid="onboarding-dictation-permissions"');
  } finally {
    queryClient.clear();
    Object.assign(initial, previous);
  }
});

test("configured recording setup remains reopenable without resetting permissions", () => {
  const requirements = ["microphone", "systemAudio", "model"].map(id => ({
    id, title: id, description: id, ready: true, action: <button>Request access</button>,
  }));
  const html = renderToStaticMarkup(<RecorderFlow feature="meetings" demo loading={false}
    meetingRequirements={requirements} dictationRequirements={[]} onBack={() => {}} onDone={() => {}} />);
  expect(html).toContain("Ready to use");
  expect(html).toContain("Set up again");
  expect(html).toContain(">Continue</button>");
  expect(html).not.toContain("Request access");
  expect(requirements.every(item => item.ready)).toBe(true);
});

const featureSteps: { feature: RecorderFeature; step: number; heading: string }[] = [
  { feature: "meetings", step: 3, heading: "Record meetings." },
  { feature: "dictation", step: 4, heading: "Dictate anywhere" },
];
for (const { feature, step, heading } of featureSteps) {
  test(`${feature} has its own progress point in the seven-step onboarding`, () => {
    const html = renderToStaticMarkup(<RecorderFlow feature={feature} demo loading={false}
      meetingRequirements={[]} dictationRequirements={[]} onBack={() => {}} onDone={() => {}} />);
    expect(html).toContain(heading);
    expect(html).toContain('aria-valuemax="7"');
    expect(html).toContain(`aria-valuenow="${step}"`);
  });
}
