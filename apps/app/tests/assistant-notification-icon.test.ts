import { expect, test } from "bun:test";
import { assistantNotificationIcon } from "../src/react-app/domains/session/sidebar/assistant-notification-icon";

test("desktop notifications draw the shared flower for new defaults and legacy dots, preserving animal artwork", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const drawn: string[] = [];
  class TestImage {
    src = "";
    naturalWidth = 1080;
    naturalHeight = 1080;
    async decode() {}
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: TestImage });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ drawImage: (image: TestImage) => { drawn.push(image.src); } }),
      toDataURL: () => "data:image/png;base64,fixture",
    }),
  } });
  try {
    for (const icon of ["flower", "dot", "bird"] satisfies Array<"flower" | "dot" | "bird">) {
      expect(await assistantNotificationIcon(icon)).toBe("data:image/png;base64,fixture");
    }
    expect(drawn).toHaveLength(3);
    expect(drawn[0]).toContain("flower.png");
    expect(drawn[1]).toBe(drawn[0]);
    expect(drawn[2]).toContain("bird.png");
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousImage) Object.defineProperty(globalThis, "Image", previousImage);
    else Reflect.deleteProperty(globalThis, "Image");
  }
});
