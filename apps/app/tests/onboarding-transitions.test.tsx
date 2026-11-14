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

  const plans = (mode: AiPlansOverlayProps["mode"], totalSteps = 7) =>
    renderToStaticMarkup(
      React.createElement(AiPlansOverlay, {
        mode,
        totalSteps,
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

  test("offers a free banner above Plus, Pro and Max with the new prices", () => {
    const html = plans("onboarding");
    expect(html.indexOf("Use LegalWork for free")).toBeLessThan(html.indexOf('data-testid="ai-plan-plus"'));
    for (const plan of ["plus", "pro", "max"]) expect(html).toContain('data-testid="ai-plan-' + plan + '"');
    expect(html).not.toContain('data-testid="ai-plan-sync"');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("€190");
    expect(html).not.toContain("Billed yearly, or");
    expect(html.match(/aria-label="Included AI usage"/g)).toHaveLength(3);
    for (const amount of ["€30", "€100", "€210"]) expect(html).toMatch(new RegExp(`<strong[^>]*>${amount}</strong>`));
    expect(html).toMatch(/<s[^>]*>€90<\/s>/);
    expect(html).toMatch(/<s[^>]*>€190<\/s>/);
    expect(html).toContain('aria-label="Billing period"');
    expect(html).toContain("Try Pro for €1");
    const cards = html.split("<article").slice(1).map(card => card.split("</article>")[0]);
    for (const card of cards) {
      const featureList = card.split("<ul")[1];
      expect(featureList).not.toContain("AI usage");
      expect(featureList).not.toContain("203 StGB");
      expect(card).toContain("Team sync: Tasks, Workflows and files");
      expect(card).toContain("Matter management: clients, matter references, status and responsibilities in one place");
      expect(card).toContain("Word add-in, Excel add-in and Outlook integration");
    }
    expect(cards[0]).not.toContain("Standard support");
    expect(cards[0]).not.toContain("Priority support");
    expect(cards[0]).not.toContain("Admin dashboard");
    expect(cards[1]).toContain("Admin dashboard");
    expect(cards[2]).toContain("Admin dashboard");
    expect(cards[1]).toContain("Priority support");
    expect(cards[2]).toContain("Priority support");
  });

  test("the plan screen appears at once as the onboarding step before permissions and research", () => {
    const html = plans("onboarding");
    expect(html).toContain('data-testid="ai-plans-overlay"');
    expect(html).not.toContain("fade-in");
    expect(html).toContain('aria-valuemax="7"');
    expect(html).toContain('aria-valuenow="5"');
  });

  test("web onboarding includes research in its four-step progress", () => {
    const html = plans("onboarding", 4);
    expect(html).toContain('aria-valuemax="4"');
    expect(html).toContain('aria-valuenow="2"');
  });

  test("the plan screen fades in over a working app", () => {
    expect(plans("gate")).toContain("fade-in");
  });
});

describe("the plan screen's way to updates", () => {
  const render = (props: Partial<AiPlansOverlayProps>) =>
    renderToStaticMarkup(
      React.createElement(AiPlansOverlay, {
        mode: "gate",
        variant: "new",
        account: null,
        serverReady: true,
        onStartSignIn: async () => ({ authorizeUrl: "", sessionId: "" }),
        onWaitSignIn: async () => ({ connected: false }),
        onSignedIn: () => {},
        onBringOwnModel: () => {},
        onOpenBilling: () => {},
        onCheckModels: async () => false,
        ...props,
      }),
    );

  test("offers the update check in every variant when the app can update", () => {
    for (const variant of ["new", "signed-out", "ended", "no-models"] as const) {
      for (const mode of ["gate", "onboarding"] as const) {
        expect(render({ variant, mode, onOpenUpdates: () => {} })).toContain("Check for updates");
      }
    }
  });

  test("hides it where the app cannot update itself", () => {
    expect(render({})).not.toContain("Check for updates");
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
