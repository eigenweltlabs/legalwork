/** @jsxImportSource react */
import { LanguageSection } from "../appearance/language-section";
import { LayoutStack } from "../settings-layout";

export type AppearanceViewProps = {
  busy: boolean;
};

// The theme is fixed to Light (see app/theme.ts) and the window/frame controls
// are hidden, so this tab now surfaces only the language picker. The same
// picker also lives in Settings -> Customization, which is the reachable tab.
export function AppearanceView(props: AppearanceViewProps) {
  return (
    <LayoutStack>
      <LanguageSection busy={props.busy} />
    </LayoutStack>
  );
}
