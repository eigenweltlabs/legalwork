import type { AssistantIcon } from "@legalwork/types/main-assistant";
import flower from "@/assets/assistant/flower.png";
import bear from "@/assets/assistant/bear.png";
import bird from "@/assets/assistant/bird.png";
import cat from "@/assets/assistant/cat.png";
import dog from "@/assets/assistant/dog.png";
import fox from "@/assets/assistant/fox.png";
import rabbit from "@/assets/assistant/bunny.png";
import professionalBear from "@/assets/assistant/professional-bear.png";
import professionalFox from "@/assets/assistant/professional-fox.png";
import professionalOwl from "@/assets/assistant/professional-owl.png";

export const assistantAvatarImages = { flower, cat, dog, bear, rabbit, fox, bird, professional_bear: professionalBear, professional_fox: professionalFox, professional_owl: professionalOwl };
type AvatarIcon = keyof typeof assistantAvatarImages;
const legacyIcons: Record<Exclude<AssistantIcon, AvatarIcon>, AvatarIcon> = {
  dot: "flower", owl: "bird", panda: "bear", penguin: "bird", otter: "dog", frog: "cat", robot: "cat", sprout: "rabbit",
};
export function assistantAvatarIcon(icon: AssistantIcon): AvatarIcon {
  switch (icon) {
    case "flower": case "cat": case "dog": case "bear": case "rabbit": case "fox": case "bird":
    case "professional_bear": case "professional_fox": case "professional_owl": return icon;
    default: return legacyIcons[icon];
  }
}
