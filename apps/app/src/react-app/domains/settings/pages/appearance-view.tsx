/** @jsxImportSource react */
import { LanguageSection } from "../appearance/language-section";
import { ThemeSection } from "../appearance/theme-section";
import { LayoutStack } from "../settings-layout";

export type AppearanceViewProps = {
  busy: boolean;
};

// Keep older Appearance routes working; these controls also live in Customization.
export function AppearanceView(props: AppearanceViewProps) {
  return (
    <LayoutStack>
      <ThemeSection busy={props.busy} />
      <LanguageSection busy={props.busy} />
    </LayoutStack>
  );
}
