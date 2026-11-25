import type { ComponentProps } from "react";
import { Avatar } from "twenty-ui/primitives/data-display";
import { useTheme } from "twenty-ui/theme";
import { stringToThemeColor } from "twenty-ui/utilities";

/** Record identity colors are chromatic; neutral colors are reserved for UI states. */
export function recordColor(seed: string) {
  const color = stringToThemeColor(seed);
  return color === "gray" ? "blue" : color;
}

export function RecordAvatar(props: ComponentProps<typeof Avatar>) {
  const theme = useTheme();
  const color = recordColor(props.colorSeed ?? props.name ?? "");
  return <Avatar {...props} color={theme.color[`${color}12`]}
    backgroundColor={theme.color[`${color}${props.variant === "outline" ? 5 : 4}`]}
    borderColor={theme.color[`${color}6`]} />;
}
