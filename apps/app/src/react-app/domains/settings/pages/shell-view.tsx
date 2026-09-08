/** @jsxImportSource react */
import { useId, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { cn } from "@/lib/utils";
import legalworkMarkDark from "@/assets/legalwork-mark-dark.svg";

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
  LayoutStack,
} from "../settings-layout";
import { LanguageSection } from "../appearance/language-section";
import { useShellConfig, DEFAULT_SHELL_CONFIG } from "../../../shell/shell-config";
import { useLocal } from "@/react-app/kernel/local-provider";
import { t } from "@/i18n";

const SIDEBAR_BRAND_LOGO_MAX_BYTES = 512 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("settings.customization.logo_error_read")));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.trim()) {
        reject(new Error(t("settings.customization.logo_error_read")));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function ShellCustomizationView() {
  const { config, update } = useShellConfig();
  const local = useLocal();
  const [brandLogoError, setBrandLogoError] = useState<string | null>(null);
  const logoInputId = useId();
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const handleSidebarBrandLogoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    const mime = file.type.trim().toLowerCase();
    if (!mime.startsWith("image/")) {
      setBrandLogoError(t("settings.customization.logo_error_not_image"));
      return;
    }
    if (file.size > SIDEBAR_BRAND_LOGO_MAX_BYTES) {
      setBrandLogoError(t("settings.customization.logo_error_too_large"));
      return;
    }
    setBrandLogoError(null);
    void (async () => {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        update({ sidebarBrandLogoDataUrl: dataUrl });
        captureAnalyticsEvent("branding_customized", {
          has_custom_name: config.sidebarBrandName.trim().length > 0,
          has_custom_logo: dataUrl.trim().length > 0,
        });
      } catch (error) {
        setBrandLogoError(
          error instanceof Error ? error.message : t("settings.customization.logo_error_load"),
        );
      }
    })();
  };

  const customSidebarBrandName = config.sidebarBrandName.trim();
  const customSidebarBrandLogo = config.sidebarBrandLogoDataUrl.trim();
  const sidebarBrandLogoSrc = customSidebarBrandLogo || legalworkMarkDark;
  const showSidebarBrandName = customSidebarBrandName.length > 0 || !customSidebarBrandLogo;
  const sidebarBrandName = showSidebarBrandName
    ? (customSidebarBrandName || DEFAULT_SHELL_CONFIG.sidebarBrandName)
    : "";
  const sidebarBrandAlt = sidebarBrandName || DEFAULT_SHELL_CONFIG.sidebarBrandName;

  return (
    <LayoutStack>
      {/* ---- Language ----
           One setting, so it carries its own title; a section header above it
           would just repeat the row's "Language" heading. */}
      <LayoutSection>
        <LanguageSection />
      </LayoutSection>

      {/* ---- Branding ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.customization.branding_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>
            {t("settings.customization.branding_desc")}
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.customization.sidebar_name")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("settings.customization.sidebar_name_desc")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Field className="w-64 max-w-full gap-0">
                <FieldLabel className="sr-only" htmlFor="shell-sidebar-brand-name">
                  {t("settings.customization.sidebar_name_label")}
                </FieldLabel>
                <Input
                  id="shell-sidebar-brand-name"
                  className="h-8 text-xs"
                  value={config.sidebarBrandName}
                  placeholder={DEFAULT_SHELL_CONFIG.sidebarBrandName}
                  onChange={(event) => update({ sidebarBrandName: event.currentTarget.value })}
                  onBlur={(event) =>
                    captureAnalyticsEvent("branding_customized", {
                      has_custom_name: event.currentTarget.value.trim().length > 0,
                      has_custom_logo: config.sidebarBrandLogoDataUrl.trim().length > 0,
                    })
                  }
                />
              </Field>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.customization.sidebar_logo")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("settings.customization.sidebar_logo_desc")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => logoInputRef.current?.click()}
                >
                  <span>{t("settings.customization.upload_logo")}</span>
                </Button>
                {config.sidebarBrandLogoDataUrl.trim() ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      update({ sidebarBrandLogoDataUrl: "" });
                      setBrandLogoError(null);
                    }}
                  >
                    {t("settings.customization.use_default")}
                  </Button>
                ) : null}
                <input
                  ref={logoInputRef}
                  id={logoInputId}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleSidebarBrandLogoChange}
                />
              </div>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          <div className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-hover/40 p-3">
            <img
              src={sidebarBrandLogoSrc}
              alt={t("settings.customization.logo_alt", { name: sidebarBrandAlt })}
              className={cn(
                "shrink-0 border border-dls-border object-contain p-1",
                showSidebarBrandName
                  ? "h-10 w-10 rounded-lg"
                  : "h-16 w-[13rem] max-w-full rounded-md object-left",
              )}
            />
            {showSidebarBrandName ? (
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  {t("settings.customization.preview")}
                </div>
                <div className="truncate text-sm font-medium text-foreground">{sidebarBrandName}</div>
              </div>
            ) : (
              <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                {t("settings.customization.logo_only")}
              </div>
            )}
          </div>
          {brandLogoError ? (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>{brandLogoError}</AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <Info />
              <AlertDescription>{t("settings.customization.logo_hint")}</AlertDescription>
            </Alert>
          )}
        </LayoutSectionItem>

        {/* Task suggestions - shown below the logo */}
        <LayoutSectionItem className="gap-3">
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.customization.task_suggestions")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("settings.customization.task_suggestions_desc")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.customization.task_suggestions")}
                checked={config.starterCards}
                onCheckedChange={(value) => update({ starterCards: value })}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      {/* ---- Model ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.model_title")}</LayoutSectionTitle>
        </LayoutSectionHeader>

        {/* Show model reasoning */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.show_model_reasoning")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.show_model_reasoning_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.show_model_reasoning")}
                checked={local.prefs.showThinking}
                onCheckedChange={(value) =>
                  local.setPrefs((previous) => ({ ...previous, showThinking: value, showThinkingChosen: true }))
                }
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>
    </LayoutStack>
  );
}
