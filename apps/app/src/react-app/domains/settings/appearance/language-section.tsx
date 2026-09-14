/** @jsxImportSource react */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LANGUAGE_OPTIONS,
  SYSTEM_LANGUAGE,
  detectSystemLanguage,
  isLanguagePreference,
  setLanguagePreference,
  t,
} from "@/i18n";
import { useLanguagePreference } from "@/i18n/use-locale";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
} from "../settings-layout";

type LanguageSectionProps = {
  busy?: boolean;
};

export function LanguageSection(props: LanguageSectionProps) {
  const preference = useLanguagePreference();
  const detected = detectSystemLanguage();
  const detectedName =
    LANGUAGE_OPTIONS.find((option) => option.value === detected)?.nativeName ?? detected;

  const items = [
    { value: SYSTEM_LANGUAGE, label: t("settings.language_system", { language: detectedName }) },
    ...LANGUAGE_OPTIONS.map((option) => ({ value: option.value, label: option.nativeName })),
  ];

  // The row owns its section, header included: LayoutSection only cards up
  // children whose type is literally LayoutSectionItem, so a caller wrapping
  // <LanguageSection /> in its own LayoutSection leaves the row outside the
  // card that every other setting row sits in.
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.language")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.language_section_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.language_display")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.language.description")}</LayoutSectionItemDescription>

          <LayoutSectionItemHeaderActions>
            <div className="w-64 max-w-full">
              <Select
                value={preference}
                items={items}
                onValueChange={(value) => {
                  if (isLanguagePreference(value)) setLanguagePreference(value);
                }}
                disabled={props.busy}
              >
                <SelectTrigger className="w-full" aria-label={t("settings.language")}>
                  <SelectValue placeholder={t("settings.language")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
    </LayoutSection>
  );
}
