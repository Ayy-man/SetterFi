import type { DriverName, DriverSelectorName, EnvironmentName } from "@/lib/env-contract";

export const ROTATION_PROVIDERS = [
  "ghl",
  "meta",
  "openrouter",
  "openai_embeddings",
  "notion",
  "calendar",
  "stripe",
  "supabase",
] as const;

export type RotationProvider = (typeof ROTATION_PROVIDERS)[number];

export type RotationManifestEntry = {
  provider: RotationProvider;
  driverName: DriverName | "stripe" | "supabase";
  selectorName: DriverSelectorName | null;
  credentialNames: readonly EnvironmentName[];
  verificationNames: readonly EnvironmentName[];
  receiptClass: string;
};

export const ROTATION_MANIFEST = {
  ghl: {
    provider: "ghl",
    driverName: "ghl",
    selectorName: "SETTERFI_GHL_DRIVER",
    credentialNames: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_WEBHOOK_PUBLIC_KEY"],
    verificationNames: [],
    receiptClass: "ghl.application.read",
  },
  meta: {
    provider: "meta",
    driverName: "meta",
    selectorName: "SETTERFI_META_DRIVER",
    credentialNames: [
      "META_APP_SECRET",
      "META_SYSTEM_USER_TOKEN",
      "META_WEBHOOK_VERIFY_TOKEN",
      "META_WHATSAPP_SYSTEM_USER_TOKEN",
    ],
    verificationNames: [
      "META_APP_ID",
      "META_LOGIN_CONFIG_ID",
      "META_WABA_ID",
      "META_WHATSAPP_PHONE_NUMBER_ID",
    ],
    receiptClass: "meta.account.read",
  },
  openrouter: {
    provider: "openrouter",
    driverName: "openrouter",
    selectorName: "SETTERFI_OPENROUTER_DRIVER",
    credentialNames: ["OPENROUTER_API_KEY"],
    verificationNames: [],
    receiptClass: "openrouter.models.read",
  },
  openai_embeddings: {
    provider: "openai_embeddings",
    driverName: "embeddings",
    selectorName: "SETTERFI_EMBEDDINGS_DRIVER",
    credentialNames: ["OPENAI_API_KEY"],
    verificationNames: [],
    receiptClass: "openai.models.read",
  },
  notion: {
    provider: "notion",
    driverName: "notion",
    selectorName: "SETTERFI_NOTION_DRIVER",
    credentialNames: ["NOTION_API_KEY"],
    verificationNames: ["NOTION_KB_ROOT_ID"],
    receiptClass: "notion.root.read",
  },
  calendar: {
    provider: "calendar",
    driverName: "calendar",
    selectorName: "SETTERFI_GHL_DRIVER",
    credentialNames: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "SETTERFI_GHL_TEST_ACCESS_TOKEN"],
    verificationNames: ["SETTERFI_GHL_TEST_LOCATION_ID", "SETTERFI_GHL_TEST_CALENDAR_ID"],
    receiptClass: "calendar.slots.read",
  },
  stripe: {
    provider: "stripe",
    driverName: "stripe",
    selectorName: null,
    credentialNames: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    verificationNames: [],
    receiptClass: "stripe.account.read",
  },
  supabase: {
    provider: "supabase",
    driverName: "supabase",
    selectorName: null,
    credentialNames: [
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD",
    ],
    verificationNames: ["NEXT_PUBLIC_SUPABASE_URL"],
    receiptClass: "supabase.project.read",
  },
} as const satisfies Record<RotationProvider, RotationManifestEntry>;

export function rotationEnvironmentNames(entry: RotationManifestEntry) {
  return [...new Set([...entry.credentialNames, ...entry.verificationNames])];
}
