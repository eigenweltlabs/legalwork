import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { compareProviders } from "../src/app/utils/providers";
import {
  AiPlansOverlay,
  type AiPlansOverlayProps,
} from "../src/react-app/domains/onboarding/ai-plans-overlay";
import { OfficeStep } from "../src/react-app/domains/onboarding/office-step";

/**
 * Onboarding steps replace each other in one render. A step that renders
 * nothing while it loads, or a screen that fades in after an opaque step,
 * shows the bare app for a moment.
 */
describe("onboarding transitions", () => {
  test("the Office step covers the app while it checks for Office", () => {
    const html = renderToStaticMarkup(React.createElement(OfficeStep, { onDone: () => {} }));
    expect(html).toContain("fixed inset-0 z-40");
  });

  const plans = (mode: AiPlansOverlayProps["mode"]) =>
    renderToStaticMarkup(
      React.createElement(AiPlansOverlay, {
        mode,
        variant: "new",
        account: null,
        serverReady: true,
        onStartSignIn: async () => ({ authorizeUrl: "", sessionId: "" }),
        onWaitSignIn: async () => {
          throw new Error("not used");
        },
        onSignedIn: () => {},
        onBringOwnModel: () => {},
        onOpenBilling: () => {},
        onCheckModels: async () => false,
      }),
    );

  test("the plan screen appears at once as the onboarding step after permissions", () => {
    const html = plans("onboarding");
    expect(html).toContain('data-testid="ai-plans-overlay"');
    expect(html).not.toContain("fade-in");
  });

  test("the plan screen fades in over a working app", () => {
    expect(plans("gate")).toContain("fade-in");
  });
});

describe("provider order in the connect dialog", () => {
  test("only Eigenwelt is pinned, every other provider sorts by name", () => {
    const providers = [
      { id: "302ai", name: "302.AI" },
      { id: "opencode", name: "OpenCode Zen" },
      { id: "anthropic", name: "Anthropic" },
      { id: "abacus", name: "Abacus" },
      { id: "OpenAI", name: "OpenAI" },
      { id: "eigenwelt", name: "Eigenwelt Subscription" },
      { id: "mistral", name: "Mistral" },
    ];
    expect(providers.toSorted(compareProviders).map((provider) => provider.id)).toEqual([
      "eigenwelt",
      "302ai",
      "abacus",
      "anthropic",
      "mistral",
      "OpenAI",
      "opencode",
    ]);
  });
});
