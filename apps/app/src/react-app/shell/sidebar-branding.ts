import { t } from "@/i18n";

export async function readSidebarBrandLogo(file: File): Promise<string> {
  if (!file.type.toLowerCase().startsWith("image/")) {
    throw new Error(t("settings.customization.logo_error_not_image"));
  }
  if (file.size > 512 * 1024) {
    throw new Error(t("settings.customization.logo_error_too_large"));
  }
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
