/** Names-only provider rotation verifier. Credential values are never rendered. */

const PROVIDERS = {
  ghl: {
    selector: "SETTERFI_GHL_DRIVER",
    names: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_WEBHOOK_PUBLIC_KEY"],
    receiptClass: "ghl.application.read",
  },
  meta: {
    selector: "SETTERFI_META_DRIVER",
    names: [
      "META_APP_SECRET", "META_SYSTEM_USER_TOKEN", "META_WEBHOOK_VERIFY_TOKEN",
      "META_WHATSAPP_SYSTEM_USER_TOKEN", "META_APP_ID", "META_LOGIN_CONFIG_ID",
      "META_WABA_ID", "META_WHATSAPP_PHONE_NUMBER_ID",
    ],
    receiptClass: "meta.account.read",
  },
  openrouter: {
    selector: "SETTERFI_OPENROUTER_DRIVER",
    names: ["OPENROUTER_API_KEY"],
    receiptClass: "openrouter.models.read",
  },
  openai_embeddings: {
    selector: "SETTERFI_EMBEDDINGS_DRIVER",
    names: ["OPENAI_API_KEY"],
    receiptClass: "openai.models.read",
  },
  notion: {
    selector: "SETTERFI_NOTION_DRIVER",
    names: ["NOTION_API_KEY", "NOTION_KB_ROOT_ID"],
    receiptClass: "notion.root.read",
  },
  calendar: {
    selector: "SETTERFI_GHL_DRIVER",
    names: [
      "GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "SETTERFI_GHL_TEST_ACCESS_TOKEN",
      "SETTERFI_GHL_TEST_LOCATION_ID", "SETTERFI_GHL_TEST_CALENDAR_ID",
    ],
    receiptClass: "calendar.slots.read",
  },
  stripe: {
    selector: null,
    names: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    receiptClass: "stripe.account.read",
  },
  supabase: {
    selector: null,
    names: [
      "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD", "NEXT_PUBLIC_SUPABASE_URL",
    ],
    receiptClass: "supabase.project.read",
  },
};

function help() {
  console.log(`Usage: npm run verify:rotation -- --mode <mock|auto|real>

Runs names-only provider credential checks in place.
  mock  Runs synthetic verification choreography for every provider.
  auto  Skips providers whose real selector or required environment names are absent.
  real  Fails closed when any required environment name is absent.

Real provider calls are supplied through the typed verification service; this CLI never prints values.`);
}

function modeFromArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const index = argv.indexOf("--mode");
  const mode = index >= 0 ? argv[index + 1] : "auto";
  if (!["mock", "auto", "real"].includes(mode)) throw new Error("ROTATION_MODE_INVALID");
  return mode;
}

function line(provider, payload) {
  console.log(JSON.stringify({ provider, ...payload }));
}

export async function verifyProviderRotationCli(argv = process.argv.slice(2), environment = process.env) {
  const mode = modeFromArgs(argv);
  if (mode === "help") {
    help();
    return { failed: 0, skipped: 0, verified: 0 };
  }
  let failed = 0;
  let skipped = 0;
  let verified = 0;
  for (const [provider, entry] of Object.entries(PROVIDERS)) {
    if (mode === "mock") {
      line(provider, {
        environmentNames: entry.names,
        result: "verified",
        receiptClass: entry.receiptClass,
        timestamp: new Date(0).toISOString(),
      });
      verified += 1;
      continue;
    }
    if (mode === "auto" && entry.selector && environment[entry.selector]?.trim() !== "real") {
      line(provider, {
        environmentNames: entry.names,
        result: "skipped",
        reason: "selector_not_real",
        missingNames: [entry.selector],
      });
      skipped += 1;
      continue;
    }
    const required = [...entry.names, "SETTERFI_CREDENTIAL_ENCRYPTION_KEY"];
    const missingNames = required.filter((name) => !environment[name]?.trim());
    if (missingNames.length > 0) {
      if (mode === "real") throw new Error(`DriverConfigurationError:${provider}:${missingNames.join(",")}`);
      line(provider, {
        environmentNames: entry.names,
        result: "skipped",
        reason: "missing_environment",
        missingNames,
      });
      skipped += 1;
      continue;
    }
    line(provider, {
      environmentNames: entry.names,
      result: "failed",
      reason: "verification_adapter_required",
    });
    failed += 1;
  }
  console.log(JSON.stringify({ summary: { failed, skipped, verified } }));
  if (failed > 0) process.exitCode = 1;
  return { failed, skipped, verified };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  verifyProviderRotationCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "ROTATION_VERIFICATION_FAILED");
    process.exitCode = 1;
  });
}
