/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantIdentity } from "../src/react-app/domains/session/sidebar/assistant-identity";
import { AssistantAvatar, AssistantAvatarPicker, AssistantFlowerIcon } from "../src/react-app/domains/session/sidebar/assistant-appearance";
import { AssistantAvatarIconSchema, AssistantProfileSchema, DEFAULT_ASSISTANT_PROFILE } from "@legalwork/types/main-assistant";

test("animated avatars provide a still-image source for reduced motion", () => {
  const working = renderToStaticMarkup(<AssistantAvatar icon="cat" motion="thinking" />);
  expect(working).toContain("cat-thinking.webp");
  expect(working).toContain('media="(prefers-reduced-motion: reduce)"');
  expect(working).toContain("cat-idle.png");
  const idle = renderToStaticMarkup(<AssistantAvatar icon="cat" motion="idle" />);
  expect(idle).toContain("cat-idle.png");
  expect(idle).not.toContain("cat-thinking.webp");
});

test("sidebar animals stay static while the default and legacy dot use the iOS flower during activity", () => {
  const sidebar = renderToStaticMarkup(<AssistantAvatar icon="cat" />);
  expect(sidebar).not.toContain("thinking.webp");
  expect(sidebar).not.toContain("<picture");
  const flower = renderToStaticMarkup(<AssistantAvatar icon="flower" motion="thinking" />);
  expect(flower).toContain("flower.png");
  expect(flower).not.toContain("<svg");
  expect(flower).not.toContain("<picture");
  expect(flower).not.toContain("scale-125");
  expect(renderToStaticMarkup(<AssistantAvatar />)).toBe(flower);
  expect(renderToStaticMarkup(<AssistantAvatar icon="dot" motion="thinking" />)).toBe(flower);
  expect(renderToStaticMarkup(<AssistantFlowerIcon />)).toContain("flower.png");
});

test("the picker offers one flower first and preserves legacy profile names and animal choices", () => {
  expect(DEFAULT_ASSISTANT_PROFILE).toEqual({ name: null, icon: "flower" });
  expect(AssistantAvatarIconSchema.options).toHaveLength(10);
  expect(AssistantAvatarIconSchema.options[0]).toBe("flower");
  expect(AssistantAvatarIconSchema.safeParse("dot").success).toBe(false);
  expect(AssistantProfileSchema.parse({ name: "Johannes", icon: "dot" })).toEqual({ name: "Johannes", icon: "dot" });
  const selectedLegacy = renderToStaticMarkup(<AssistantAvatarPicker compact selected="dot" onSelect={() => {}} />);
  expect(selectedLegacy).toBe(renderToStaticMarkup(<AssistantAvatarPicker compact selected="flower" onSelect={() => {}} />));
  expect(selectedLegacy).toContain('aria-label="LegalWork flower"');
  expect(selectedLegacy).not.toContain("Concentric circles");
  const animal = renderToStaticMarkup(<AssistantAvatar icon="bird" />);
  expect(animal).toContain("bird.png");
  expect(animal).not.toContain("flower.png");
});

test("the top Assistant avatar loops while idle as well as while working", () => {
  const html = renderToStaticMarkup(<AssistantIdentity workspaceId="fixture" sessionId="idle" profile={{ name: "Johann", icon: "cat" }} />);
  expect(html).toContain("cat-thinking.webp");
  expect(html).toContain('media="(prefers-reduced-motion: reduce)"');
});
