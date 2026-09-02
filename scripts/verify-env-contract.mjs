/** Names-only environment verification. Secret values are inspected but never rendered. */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const SELECTORS = {
  SETTERFI_GHL_DRIVER: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_WEBHOOK_PUBLIC_KEY"],
  SETTERFI_OPENROUTER_DRIVER: ["OPENROUTER_API_KEY"],
  SETTERFI_META_DRIVER: [
    "META_APP_ID", "META_APP_SECRET", "META_SYSTEM_USER_TOKEN", "META_WEBHOOK_VERIFY_TOKEN",
    "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
  ],
  SETTERFI_EMBEDDINGS_DRIVER: ["OPENAI_API_KEY"],
  SETTERFI_GHL_PROVISIONING_DRIVER: ["GHL_AGENCY_COMPANY_ID", "GHL_SNAPSHOT_ID", "GHL_NUMBER_POOL_ID"],
  SETTERFI_STRIPE_DRIVER: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
};

const META_OAUTH_REQUIREMENTS = [
  "APP_BASE_URL", "META_APP_ID", "META_APP_SECRET", "META_LOGIN_CONFIG_ID",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
];
const META_WHATSAPP_REQUIREMENTS = [
  "META_WHATSAPP_SYSTEM_USER_TOKEN", "META_WABA_ID", "META_WHATSAPP_PHONE_NUMBER_ID",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
];
const GHL_AGENT_OAUTH_REQUIREMENTS = [
  "APP_BASE_URL", "GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_INSTALL_URL",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
];
const GHL_AGENCY_OAUTH_REQUIREMENTS = [
  "APP_BASE_URL", "GHL_AGENCY_CLIENT_ID", "GHL_AGENCY_CLIENT_SECRET", "GHL_AGENCY_INSTALL_URL",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
];
// Arming the Google connect flow needs the client pair, the base URL the redirect_uri is computed
// from once and sent byte-identically to both Google endpoints, and the envelope key the grant is
// stored under. Without the key the envelope module silently falls back to its mock key, which
// would put a live refresh token behind a value published in the repository.
const GOOGLE_CALENDAR_OAUTH_REQUIREMENTS = [
  "APP_BASE_URL", "GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
];
const FIRST_CUSTOMER_BASELINE = [
  "APP_BASE_URL", "SETTERFI_AUTH_MODE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "SETTERFI_TAG_SECRET",
];

const BOOLEAN_FLAGS = [
  "SETTERFI_DEMO_LOGINS", "SETTERFI_PRODUCTION_DEMO_LOGINS", "SETTERFI_PLATFORM_PREVIEW_DATA",
  "SETTERFI_PHASE1_LIVE",
  "SETTERFI_PIPELINE_WRITE_LIVE", "SETTERFI_BOOKING_CONFIRM_LIVE",
  "SETTERFI_APPOINTMENT_LIFECYCLE_LIVE", "SETTERFI_INBOX_VERBS_LIVE", "SETTERFI_PHASE2_LIVE",
  "SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE", "SETTERFI_PHASE3_LIVE",
  "SETTERFI_SUPPRESSION_SYNC_LIVE", "SETTERFI_CONTACT_DELETE_LIVE", "SETTERFI_PHASE4_LIVE",
  "SETTERFI_CONTACT_MANAGEMENT_LIVE", "SETTERFI_WHATSAPP_EMBEDDED_SIGNUP",
  "SETTERFI_PHASE5_LIVE", "SETTERFI_SIGNUP_REPAIR_LIVE",
  "SETTERFI_PHASE6_LIVE", "SETTERFI_PHASE6_AFFILIATES_LIVE", "SETTERFI_PHASE6_STRIPE_LIVE",
  "SETTERFI_CHECKOUT_ATTEMPTS_LIVE", "SETTERFI_PHASE7_LIVE", "SETTERFI_PHASE7_ANALYTICS_LIVE",
  "SETTERFI_PHASE7_EVALS_LIVE", "SETTERFI_PHASE7_MEET_AGENT_LIVE", "SETTERFI_PHASE8_LIVE",
  "SETTERFI_PHASE8_ALERTS_LIVE", "SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE",
  "SETTERFI_PHASE8_SUPPORT_LIVE", "SETTERFI_PHASE8_EXPORTS_LIVE",
  "SETTERFI_PHASE8_ENGINE_EVAL_LIVE", "SETTERFI_PHASE9_LIVE", "SETTERFI_PHASE9_GHL_OAUTH_LIVE",
  "SETTERFI_BRAIN_OBJECTIONS_LIVE", "SETTERFI_ACCOUNT_SECURITY_LIVE", "SETTERFI_ACCOUNT_MFA_LIVE",
  "SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE", "SETTERFI_TENANT_MEMBERSHIP_LIVE",
  "SETTERFI_TENANT_OWNERSHIP_LIVE", "SETTERFI_ACCOUNT_TERMS_LIVE",
  "SETTERFI_TIER_OFFER_TERMS_LIVE", "SETTERFI_OFFER_LAYER_ENGINE_INPUT_LIVE",
  "SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE",
];

const PARENT_FLAGS = {
  SETTERFI_PIPELINE_WRITE_LIVE: ["SETTERFI_PHASE1_LIVE"],
  SETTERFI_BOOKING_CONFIRM_LIVE: ["SETTERFI_PHASE1_LIVE"],
  SETTERFI_APPOINTMENT_LIFECYCLE_LIVE: ["SETTERFI_PHASE1_LIVE", "SETTERFI_BOOKING_CONFIRM_LIVE"],
  SETTERFI_INBOX_VERBS_LIVE: ["SETTERFI_PHASE1_LIVE"],
  SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE: ["SETTERFI_PHASE2_LIVE"],
  SETTERFI_BRAIN_OBJECTIONS_LIVE: ["SETTERFI_PHASE2_LIVE"],
  SETTERFI_SUPPRESSION_SYNC_LIVE: ["SETTERFI_PHASE3_LIVE"],
  SETTERFI_CONTACT_DELETE_LIVE: ["SETTERFI_PHASE3_LIVE"],
  SETTERFI_CONTACT_MANAGEMENT_LIVE: ["SETTERFI_PHASE4_LIVE"],
  SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: ["SETTERFI_PHASE4_LIVE"],
  SETTERFI_SIGNUP_REPAIR_LIVE: ["SETTERFI_PHASE5_LIVE"],
  SETTERFI_PHASE6_AFFILIATES_LIVE: ["SETTERFI_PHASE6_LIVE"],
  SETTERFI_PHASE6_STRIPE_LIVE: ["SETTERFI_PHASE6_LIVE"],
  SETTERFI_CHECKOUT_ATTEMPTS_LIVE: ["SETTERFI_PHASE6_LIVE", "SETTERFI_PHASE6_STRIPE_LIVE"],
  SETTERFI_PHASE7_ANALYTICS_LIVE: ["SETTERFI_PHASE7_LIVE"],
  SETTERFI_PHASE7_EVALS_LIVE: ["SETTERFI_PHASE7_LIVE"],
  SETTERFI_PHASE7_MEET_AGENT_LIVE: ["SETTERFI_PHASE7_LIVE"],
  SETTERFI_PHASE8_ALERTS_LIVE: ["SETTERFI_PHASE8_LIVE"],
  SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE: ["SETTERFI_PHASE8_LIVE", "SETTERFI_PHASE8_ALERTS_LIVE"],
  SETTERFI_PHASE8_SUPPORT_LIVE: ["SETTERFI_PHASE8_LIVE"],
  SETTERFI_PHASE8_EXPORTS_LIVE: ["SETTERFI_PHASE8_LIVE"],
  SETTERFI_PHASE8_ENGINE_EVAL_LIVE: ["SETTERFI_PHASE8_LIVE"],
  SETTERFI_PHASE9_GHL_OAUTH_LIVE: ["SETTERFI_PHASE9_LIVE"],
  SETTERFI_ACCOUNT_MFA_LIVE: ["SETTERFI_ACCOUNT_SECURITY_LIVE"],
  SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE: ["SETTERFI_ACCOUNT_SECURITY_LIVE"],
  SETTERFI_TENANT_OWNERSHIP_LIVE: ["SETTERFI_TENANT_MEMBERSHIP_LIVE"],
};

function value(environment, name) {
  const candidate = environment[name]?.trim();
  return candidate || undefined;
}
function enabled(environment, name) {
  return value(environment, name) === "true";
}
function envNames(text) {
  return text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));
}
function sourceArrayNames(source, constantName) {
  const match = source.match(new RegExp(`(?:export )?const ${constantName} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) throw new Error(`ENV_CONTRACT_SOURCE_ARRAY_MISSING:${constantName}`);
  return [...match[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((entry) => entry[1]);
}
function assertSameNames(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`ENV_CONTRACT_REQUIRED_NAMES_MISMATCH:${label}`);
  }
}
function assertExampleOrder(names, expected, label) {
  assertSameNames(names.filter((name) => expected.includes(name)), expected, label);
}
function addRequirement(required, ...names) {
  for (const name of names) required.add(name);
}
function requireRealSelector(required, selectors, selector, names) {
  selectors.add(selector);
  addRequirement(required, selector, ...names);
}
function isHttpsUrl(candidate) {
  try {
    return new URL(candidate).protocol === "https:";
  } catch {
    return false;
  }
}

export function firstCustomerRequirements(environment = process.env) {
  const required = new Set(FIRST_CUSTOMER_BASELINE);
  const realSelectors = new Set();
  if (enabled(environment, "SETTERFI_PRODUCTION_DEMO_LOGINS")) {
    addRequirement(
      required,
      "SETTERFI_ACCESS_PASSWORD",
      "SETTERFI_DEMO_LOGIN_PASSWORD",
      "SETTERFI_DEMO_LOGINS",
    );
  }
  if (enabled(environment, "SETTERFI_PHASE1_LIVE") || enabled(environment, "SETTERFI_PHASE3_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_GHL_DRIVER", SELECTORS.SETTERFI_GHL_DRIVER);
  }
  if (enabled(environment, "SETTERFI_PHASE1_LIVE")
    || enabled(environment, "SETTERFI_PHASE7_EVALS_LIVE")
    || enabled(environment, "SETTERFI_PHASE8_ENGINE_EVAL_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_OPENROUTER_DRIVER", SELECTORS.SETTERFI_OPENROUTER_DRIVER);
  }
  if (enabled(environment, "SETTERFI_PHASE2_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_EMBEDDINGS_DRIVER", SELECTORS.SETTERFI_EMBEDDINGS_DRIVER);
    required.add("SETTERFI_NOTION_DRIVER");
  }
  if (enabled(environment, "SETTERFI_PHASE4_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_META_DRIVER", SELECTORS.SETTERFI_META_DRIVER);
  }
  if (enabled(environment, "SETTERFI_WHATSAPP_EMBEDDED_SIGNUP")) {
    addRequirement(required, ...META_OAUTH_REQUIREMENTS, ...META_WHATSAPP_REQUIREMENTS);
  }
  if (enabled(environment, "SETTERFI_PHASE5_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_GHL_PROVISIONING_DRIVER", SELECTORS.SETTERFI_GHL_PROVISIONING_DRIVER);
  }
  if (enabled(environment, "SETTERFI_PHASE6_STRIPE_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_STRIPE_DRIVER", SELECTORS.SETTERFI_STRIPE_DRIVER);
  }
  if (enabled(environment, "SETTERFI_PHASE9_GHL_OAUTH_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_GHL_DRIVER", SELECTORS.SETTERFI_GHL_DRIVER);
    addRequirement(required, ...GHL_AGENT_OAUTH_REQUIREMENTS, ...GHL_AGENCY_OAUTH_REQUIREMENTS);
  }
  if (enabled(environment, "SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE")) {
    addRequirement(required, ...GOOGLE_CALENDAR_OAUTH_REQUIREMENTS);
  }
  if (enabled(environment, "SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE")) {
    requireRealSelector(required, realSelectors, "SETTERFI_EMAIL_DRIVER", [
      "RESEND_API_KEY", "RESEND_WEBHOOK_SIGNING_SECRET", "SETTERFI_EMAIL_FROM",
    ]);
  }
  if (value(environment, "SETTERFI_EMAIL_DRIVER") === "real") {
    addRequirement(required, "RESEND_API_KEY", "RESEND_WEBHOOK_SIGNING_SECRET", "SETTERFI_EMAIL_FROM");
    realSelectors.add("SETTERFI_EMAIL_DRIVER");
  }
  if (value(environment, "SETTERFI_SLACK_DRIVER") === "real") {
    addRequirement(required, "SLACK_WEBHOOK_URL");
    realSelectors.add("SETTERFI_SLACK_DRIVER");
  }
  const notionMode = value(environment, "SETTERFI_NOTION_DRIVER");
  if (notionMode === "real") addRequirement(required, "NOTION_API_KEY", "NOTION_KB_ROOT_ID");
  if (notionMode === "offline") addRequirement(required, "NOTION_EXPORT_PATH");
  return { requiredNames: [...required].sort(), realSelectors: [...realSelectors].sort() };
}

export function validateFirstCustomerEnvironment(environment = process.env) {
  const { requiredNames, realSelectors } = firstCustomerRequirements(environment);
  const missingNames = requiredNames.filter((name) => !value(environment, name));
  const invalidNames = new Set();
  if (value(environment, "SETTERFI_AUTH_MODE") !== "supabase") invalidNames.add("SETTERFI_AUTH_MODE");
  const productionDemoOverride = enabled(environment, "SETTERFI_PRODUCTION_DEMO_LOGINS");
  const demoLogins = value(environment, "SETTERFI_DEMO_LOGINS");
  if (demoLogins && demoLogins !== "false" && !productionDemoOverride) {
    invalidNames.add("SETTERFI_DEMO_LOGINS");
  }
  if (productionDemoOverride && demoLogins !== "true") {
    invalidNames.add("SETTERFI_PRODUCTION_DEMO_LOGINS");
  }
  const previewData = value(environment, "SETTERFI_PLATFORM_PREVIEW_DATA");
  if (previewData && previewData !== "false") invalidNames.add("SETTERFI_PLATFORM_PREVIEW_DATA");
  for (const name of BOOLEAN_FLAGS) {
    const configured = value(environment, name);
    if (configured && configured !== "true" && configured !== "false") invalidNames.add(name);
  }
  for (const [child, parents] of Object.entries(PARENT_FLAGS)) {
    if (enabled(environment, child) && parents.some((parent) => !enabled(environment, parent))) invalidNames.add(child);
  }
  const selectorModes = {
    SETTERFI_GHL_DRIVER: ["real"], SETTERFI_OPENROUTER_DRIVER: ["real"],
    SETTERFI_META_DRIVER: ["real"], SETTERFI_EMBEDDINGS_DRIVER: ["real"],
    SETTERFI_GHL_PROVISIONING_DRIVER: ["real"], SETTERFI_STRIPE_DRIVER: ["real"],
    SETTERFI_EMAIL_DRIVER: ["real"], SETTERFI_SLACK_DRIVER: ["real"],
    SETTERFI_NOTION_DRIVER: ["real", "offline"],
  };
  for (const [selector, allowed] of Object.entries(selectorModes)) {
    const configured = value(environment, selector);
    if (configured && !allowed.includes(configured)) invalidNames.add(selector);
  }
  for (const selector of realSelectors) {
    if (value(environment, selector) !== "real") invalidNames.add(selector);
  }
  if (requiredNames.includes("SETTERFI_NOTION_DRIVER")
    && !["real", "offline"].includes(value(environment, "SETTERFI_NOTION_DRIVER"))) {
    invalidNames.add("SETTERFI_NOTION_DRIVER");
  }
  for (const name of ["APP_BASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    const configured = value(environment, name);
    if (configured && !isHttpsUrl(configured)) invalidNames.add(name);
  }
  return {
    ok: missingNames.length === 0 && invalidNames.size === 0,
    requiredNames,
    missingNames,
    invalidNames: [...invalidNames].sort(),
  };
}

function profileFromArgs(argv) {
  let profile = null;
  let ifVercelProduction = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--if-vercel-production") ifVercelProduction = true;
    else if (argument.startsWith("--profile=")) profile = argument.slice("--profile=".length);
    else if (argument === "--profile") profile = argv[++index];
    else throw new Error(`ENV_CONTRACT_ARGUMENT_INVALID:${argument}`);
  }
  if (profile && profile !== "first-customer") throw new Error(`ENV_CONTRACT_PROFILE_INVALID:${profile}`);
  if (ifVercelProduction && !profile) throw new Error("ENV_CONTRACT_PROFILE_REQUIRED");
  return { profile, ifVercelProduction };
}

export async function verifyEnvContract(environment = process.env, argv = []) {
  const [example, source, selectorSource, stripeSelectorSource, packageText] = await Promise.all([
    readFile(new URL(".env.example", ROOT), "utf8"),
    readFile(new URL("src/lib/env-contract.ts", ROOT), "utf8"),
    readFile(new URL("src/lib/integrations/selector.ts", ROOT), "utf8"),
    readFile(new URL("src/lib/integrations/stripe/selector.ts", ROOT), "utf8"),
    readFile(new URL("package.json", ROOT), "utf8"),
  ]);
  const names = envNames(example);
  const sourceNames = sourceArrayNames(source, "ENV_CONTRACT_NAMES");
  const selectors = {
    ...SELECTORS,
    SETTERFI_EMAIL_DRIVER: sourceArrayNames(selectorSource, "EMAIL_CONFIGURATION_NAMES"),
    SETTERFI_SLACK_DRIVER: sourceArrayNames(selectorSource, "SLACK_CONFIGURATION_NAMES"),
  };
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) throw new Error(`ENV_CONTRACT_DUPLICATE_NAMES:${[...new Set(duplicates)].join(",")}`);
  for (const name of names) if (!source.includes(`"${name}"`)) throw new Error(`ENV_CONTRACT_SOURCE_MISSING:${name}`);
  for (const name of sourceNames) if (!names.includes(name)) throw new Error(`ENV_CONTRACT_EXAMPLE_MISSING:${name}`);
  assertSameNames(sourceNames, names, "ENV_CONTRACT_NAMES");
  for (const [constantName, expected] of [
    ["GHL_CONFIGURATION_NAMES", SELECTORS.SETTERFI_GHL_DRIVER],
    ["META_CONFIGURATION_NAMES", SELECTORS.SETTERFI_META_DRIVER],
    ["META_OAUTH_CONFIGURATION_NAMES", META_OAUTH_REQUIREMENTS],
    ["META_WHATSAPP_CONFIGURATION_NAMES", META_WHATSAPP_REQUIREMENTS],
    ["GHL_PROVISIONING_CONFIGURATION_NAMES", SELECTORS.SETTERFI_GHL_PROVISIONING_DRIVER],
    ["GHL_AGENT_OAUTH_CONFIGURATION_NAMES", GHL_AGENT_OAUTH_REQUIREMENTS],
    ["GHL_AGENCY_OAUTH_CONFIGURATION_NAMES", GHL_AGENCY_OAUTH_REQUIREMENTS],
  ]) assertSameNames(sourceArrayNames(selectorSource, constantName), expected, constantName);
  assertSameNames(sourceArrayNames(stripeSelectorSource, "STRIPE_CONFIGURATION_NAMES"), SELECTORS.SETTERFI_STRIPE_DRIVER, "STRIPE_CONFIGURATION_NAMES");
  for (const selector of ["SETTERFI_EMAIL_DRIVER", "SETTERFI_SLACK_DRIVER"]) {
    const constantName = selector === "SETTERFI_EMAIL_DRIVER" ? "EMAIL_CONFIGURATION_NAMES" : "SLACK_CONFIGURATION_NAMES";
    assertSameNames(sourceArrayNames(selectorSource, constantName), selectors[selector], constantName);
    assertExampleOrder(names, selectors[selector], `${constantName}_EXAMPLE_ORDER`);
  }
  if (!names.includes("SETTERFI_AUTH_MODE")) throw new Error("ENV_CONTRACT_SOURCE_MISSING:SETTERFI_AUTH_MODE");
  const scripts = JSON.parse(packageText).scripts ?? {};
  for (const name of [
    "demo:env-check", "demo:seed", "demo:run", "demo:reset", "demo:seed-phase6", "demo:run-phase6",
    "demo:reset-phase6", "demo:seed-phase7", "demo:run-phase7", "demo:reset-phase7",
  ]) if (typeof scripts[name] !== "string") throw new Error(`DEMO_NPM_SCRIPT_MISSING:${name}`);

  console.log("Environment contract: names-only inventory verified");
  for (const [selector, required] of Object.entries(selectors)) {
    const selection = value(environment, selector);
    if (!selection || selection === "mock") {
      console.log(`${selector}: Mock`);
      continue;
    }
    if (selection !== "real") throw new Error(`${selector}_INVALID`);
    const missing = required.filter((name) => !value(environment, name));
    console.log(`${selector}: ${missing.length === 0 ? "Real" : `SKIPPED (${missing.join(", ")} missing)`}`);
  }
  const metaReal = value(environment, "SETTERFI_META_DRIVER") === "real";
  const oauthMissing = META_OAUTH_REQUIREMENTS.filter((name) => !value(environment, name));
  console.log(`META_OAUTH: ${metaReal
    ? oauthMissing.length === 0 ? "Real" : `SKIPPED (${oauthMissing.join(", ")} missing)`
    : "Mock"}`);
  const embedded = enabled(environment, "SETTERFI_WHATSAPP_EMBEDDED_SIGNUP")
    && enabled(environment, "SETTERFI_PHASE4_LIVE");
  const whatsappMissing = META_WHATSAPP_REQUIREMENTS.filter((name) => !value(environment, name));
  console.log(`SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: ${embedded
    ? whatsappMissing.length === 0 ? "Real" : `SKIPPED (${whatsappMissing.join(", ")} missing)`
    : "Mock"}`);
  const { profile, ifVercelProduction } = profileFromArgs(argv);
  if (profile === "first-customer") {
    if (ifVercelProduction && value(environment, "VERCEL_ENV") !== "production") {
      console.log("First-customer profile: skipped outside Vercel Production");
    } else {
      const result = validateFirstCustomerEnvironment(environment);
      if (!result.ok) {
        const findings = [];
        if (result.missingNames.length > 0) findings.push(`missing=${result.missingNames.join(",")}`);
        if (result.invalidNames.length > 0) findings.push(`invalid=${result.invalidNames.join(",")}`);
        // "false" is the only value that disarms the gate, and it downgrades the failure to a
        // report rather than silencing it: every missing and invalid name still prints in the
        // build log on every deploy, so the debt cannot become invisible. Any other value —
        // including the variable being unset — keeps the original fail-the-build behaviour.
        // Authorized by Ayman 2026-09-02; delete SETTERFI_FIRST_CUSTOMER_ENFORCE to re-arm.
        if (value(environment, "SETTERFI_FIRST_CUSTOMER_ENFORCE") === "false") {
          console.log(`First-customer profile: DISARMED (SETTERFI_FIRST_CUSTOMER_ENFORCE=false); outstanding ${findings.join(";")}`);
        } else {
          throw new Error(`FIRST_CUSTOMER_ENV_INVALID:${findings.join(";")}`);
        }
      } else {
        console.log(`First-customer profile: verified ${result.requiredNames.length} required names`);
      }
    }
  }
  return {
    names, selectors, metaOAuth: META_OAUTH_REQUIREMENTS, metaWhatsapp: META_WHATSAPP_REQUIREMENTS,
    ghlAgentOAuth: GHL_AGENT_OAUTH_REQUIREMENTS, ghlAgencyOAuth: GHL_AGENCY_OAUTH_REQUIREMENTS,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyEnvContract(process.env, process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "ENV_CONTRACT_CHECK_FAILED");
    process.exitCode = 1;
  });
}
