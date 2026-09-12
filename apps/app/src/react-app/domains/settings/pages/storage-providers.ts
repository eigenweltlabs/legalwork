import { Cloud, Database, Globe, HardDrive, KeyRound, Network } from "lucide-react";
import type { StorageKind, StorageSecretKey } from "@legalwork/types/file-storage";
import { t } from "@/i18n";

export const STORAGE_CHANGED_EVENT = "legalwork:file-storage-changed";
export const storageKinds: StorageKind[] = ["smb", "webdav", "s3", "azure", "gcs", "sftp", "ftp"];
export const storageIcons = {
  smb: Network,
  webdav: Globe,
  s3: Database,
  azure: Cloud,
  gcs: HardDrive,
  sftp: KeyRound,
  ftp: Network,
};
const providerLabels = {
  smb: () => t("storage.provider_smb"),
  webdav: () => t("storage.provider_webdav"),
  s3: () => t("storage.provider_s3"),
  azure: () => t("storage.provider_azure"),
  gcs: () => t("storage.provider_gcs"),
  sftp: () => t("storage.provider_sftp"),
  ftp: () => t("storage.provider_ftp"),
};
const providerDescriptions = {
  smb: () => t("storage.description_smb"),
  webdav: () => t("storage.description_webdav"),
  s3: () => t("storage.description_s3"),
  azure: () => t("storage.description_azure"),
  gcs: () => t("storage.description_gcs"),
  sftp: () => t("storage.description_sftp"),
  ftp: () => t("storage.description_ftp"),
};
const authDescriptions = {
  smb: () => t("storage.auth_smb"),
  webdav: () => t("storage.auth_webdav"),
  s3: () => t("storage.auth_s3"),
  azure: () => t("storage.auth_azure"),
  gcs: () => t("storage.auth_gcs"),
  sftp: () => t("storage.auth_sftp"),
  ftp: () => t("storage.auth_ftp"),
};
const fieldLabels = {
  share: () => t("storage.field_share"),
  domain: () => t("storage.field_domain"),
  rootPath: () => t("storage.field_rootPath"),
  endpoint: () => t("storage.field_endpoint"),
  username: () => t("storage.field_username"),
  bucket: () => t("storage.field_bucket"),
  region: () => t("storage.field_region"),
  prefix: () => t("storage.field_prefix"),
  accessKeyId: () => t("storage.field_accessKeyId"),
  accountName: () => t("storage.field_accountName"),
  container: () => t("storage.field_container"),
  projectId: () => t("storage.field_projectId"),
  host: () => t("storage.field_host"),
  port: () => t("storage.field_port"),
  hostFingerprint: () => t("storage.field_hostFingerprint"),
  password: () => t("storage.field_password"),
  privateKey: () => t("storage.field_privateKey"),
  passphrase: () => t("storage.field_passphrase"),
  secretAccessKey: () => t("storage.field_secretAccessKey"),
  sessionToken: () => t("storage.field_sessionToken"),
  requestHeaders: () => t("storage.field_requestHeaders"),
  accountKey: () => t("storage.field_accountKey"),
  sasToken: () => t("storage.field_sasToken"),
  serviceAccount: () => t("storage.field_serviceAccount"),
};
export const storageLabel = (kind: StorageKind) => providerLabels[kind]();
export const storageDescription = (kind: StorageKind) => providerDescriptions[kind]();
export const storageAuthDescription = (kind: StorageKind) => authDescriptions[kind]();

type ConfigField = { key: string; label: string; placeholder?: string; optional?: boolean; type?: "number" | "url" };
type SecretField = {
  key: StorageSecretKey;
  label: string;
  multiline?: boolean;
  placeholder?: string;
  description?: string;
};
const field = (
  key: keyof typeof fieldLabels,
  placeholder?: string,
  optional = false,
  type?: "number" | "url",
): ConfigField => ({
  key,
  label: fieldLabels[key](),
  placeholder,
  optional,
  type,
});
export function storageFields(kind: StorageKind): ConfigField[] {
  switch (kind) {
    case "smb":
      return [
        field("host", "files.firm.local"),
        field("share", "RA-MICRO"),
        field("prefix", "documents", true),
        field("domain", "FIRM", true),
        field("username"),
        field("port", "445", false, "number"),
      ];
    case "webdav":
      return [
        field("endpoint", "https://files.example.com/remote.php/dav/files/user/", false, "url"),
        field("username", undefined, true),
      ];
    case "s3":
      return [
        field("bucket", "firm-documents"),
        field("region", "eu-central-1"),
        field("endpoint", "https://s3.example.com", true, "url"),
        field("prefix", "matters", true),
        field("accessKeyId", undefined, true),
      ];
    case "azure":
      return [
        field("accountName", "firmstorage"),
        field("container", "documents"),
        field("prefix", "matters", true),
        field("endpoint", "https://firmstorage.blob.core.windows.net", true, "url"),
      ];
    case "gcs":
      return [
        field("bucket", "firm-documents"),
        field("projectId", "firm-project", true),
        field("prefix", "matters", true),
        field("endpoint", undefined, true, "url"),
      ];
    case "sftp":
      return [
        field("host", "files.example.com"),
        field("port", "22", false, "number"),
        field("username"),
        field("rootPath", "/documents"),
        field("hostFingerprint", "SHA256:…"),
      ];
    case "ftp":
      return [
        field("host", "files.example.com"),
        field("port", "21", false, "number"),
        field("username"),
        field("rootPath", "/documents"),
      ];
  }
}
export function storageSecretFields(kind: StorageKind): SecretField[] {
  const secret = (key: StorageSecretKey, multiline = false): SecretField => ({
    key,
    label: fieldLabels[key](),
    multiline,
  });
  switch (kind) {
    case "smb":
    case "webdav":
    case "ftp":
      return [secret("password")];
    case "sftp":
      return [secret("password"), secret("privateKey", true), secret("passphrase")];
    case "s3":
      return [
        secret("secretAccessKey"),
        secret("sessionToken"),
        {
          ...secret("requestHeaders", true),
          placeholder: "X-Return-Missing-Metadata: true",
          description: t("storage.request_headers_help"),
        },
      ];
    case "azure":
      return [secret("accountKey"), secret("sasToken")];
    case "gcs":
      return [secret("serviceAccount", true)];
  }
}
export function storageDefaults(kind: StorageKind): Record<string, string> {
  if (kind === "smb") return { port: "445", encryption: "if-offered" };
  if (kind === "s3") return { region: "eu-central-1" };
  if (kind === "sftp") return { port: "22", rootPath: "/" };
  if (kind === "ftp") return { port: "21", rootPath: "/", security: "tls" };
  return {};
}
