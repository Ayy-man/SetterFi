import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  firstCustomerRequirements,
  validateFirstCustomerEnvironment,
  verifyEnvContract,
} from "../../scripts/verify-env-contract.mjs";

const SCRIPT = resolve(process.cwd(), "scripts/verify-env-contract.mjs");
const MINIMUM_GHL_ENV = {
  NODE_ENV: "test",
  APP_BASE_URL: "https://app.example.test",
  SETTERFI_AUTH_MODE: "supabase",
  NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key",
  CRON_SECRET: "synthetic-cron-secret",
  SETTERFI_TAG_SECRET: "synthetic-tag-secret",
  SETTERFI_DEMO_LOGINS: "false",
  SETTERFI_PLATFORM_PREVIEW_DATA: "false",
  SETTERFI_PHASE1_LIVE: "true",
  SETTERFI_GHL_DRIVER: "real",
  GHL_CLIENT_ID: "synthetic-client-id",
  GHL_CLIENT_SECRET: "synthetic-client-secret",
  GHL_WEBHOOK_PUBLIC_KEY: "synthetic-public-key",
  SETTERFI_OPENROUTER_DRIVER: "real",
  OPENROUTER_API_KEY: "synthetic-openrouter-key",
} as const;

const CHILD_PARENTS = {
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
} as const;

describe("first-customer environment gate", () => {
  it("accepts the minimum GHL first-customer profile without optional providers", () => {
    const result = validateFirstCustomerEnvironment(MINIMUM_GHL_ENV);
    expect(result).toMatchObject({ ok: true, missingNames: [], invalidNames: [] });
    expect(result.requiredNames).toContain("SETTERFI_GHL_DRIVER");
    expect(result.requiredNames).toContain("SETTERFI_OPENROUTER_DRIVER");
    expect(result.requiredNames).not.toContain("SETTERFI_META_DRIVER");
    expect(result.requiredNames).not.toContain("SETTERFI_EMAIL_DRIVER");
    expect(result.requiredNames).not.toContain("SETTERFI_NOTION_DRIVER");
  });

  it("fails independently for every required name in the minimum profile", () => {
    const { requiredNames } = firstCustomerRequirements(MINIMUM_GHL_ENV);
    for (const name of requiredNames) {
      const environment = { ...MINIMUM_GHL_ENV, [name]: undefined };
      const result = validateFirstCustomerEnvironment(environment);
      expect(result.ok, name).toBe(false);
      expect(result.missingNames, name).toContain(name);
    }
  });

  it("rejects mock and unknown required selectors", () => {
    for (const selection of ["mock", "unknown-provider"]) {
      const result = validateFirstCustomerEnvironment({
        ...MINIMUM_GHL_ENV,
        SETTERFI_GHL_DRIVER: selection,
      });
      expect(result.ok).toBe(false);
      expect(result.invalidNames).toContain("SETTERFI_GHL_DRIVER");
    }
  });

  it("allows production demo review only with the explicit override and shared access gate", () => {
    const enabled = {
      ...MINIMUM_GHL_ENV,
      SETTERFI_DEMO_LOGINS: "true",
      SETTERFI_DEMO_LOGIN_PASSWORD: "synthetic-demo-password",
      SETTERFI_PRODUCTION_DEMO_LOGINS: "true",
      SETTERFI_ACCESS_PASSWORD: "synthetic-access-password",
    };
    expect(validateFirstCustomerEnvironment(enabled)).toMatchObject({
      ok: true,
      missingNames: [],
      invalidNames: [],
    });

    const withoutOverride = validateFirstCustomerEnvironment({
      ...enabled,
      SETTERFI_PRODUCTION_DEMO_LOGINS: "false",
    });
    expect(withoutOverride.invalidNames).toContain("SETTERFI_DEMO_LOGINS");

    for (const name of ["SETTERFI_ACCESS_PASSWORD", "SETTERFI_DEMO_LOGIN_PASSWORD"] as const) {
      const result = validateFirstCustomerEnvironment({ ...enabled, [name]: "" });
      expect(result.missingNames, name).toContain(name);
    }
  });

  it("rejects every enabled child whose parent chain is incoherent", () => {
    const baseline = Object.fromEntries(
      Object.entries(MINIMUM_GHL_ENV).filter(([name]) => !name.startsWith("SETTERFI_PHASE")),
    ) as NodeJS.ProcessEnv;
    for (const [child, parents] of Object.entries(CHILD_PARENTS)) {
      const result = validateFirstCustomerEnvironment({ ...baseline, [child]: "true" });
      expect(result.invalidNames, `${child} requires ${parents.join(",")}`).toContain(child);
    }
  });

  // The flag has no parent on purpose: it is not Phase 9 work, and Phase 5 already gates the
  // onboarding route at the handler level. A parentless flag needs no CHILD_PARENTS entry, and
  // this proves the absence is silence rather than a hole in the walk above.
  it("accepts a first-customer profile that never mentions the Google connect flag", () => {
    const result = validateFirstCustomerEnvironment(MINIMUM_GHL_ENV);
    expect(result.ok).toBe(true);
    expect(result.invalidNames).not.toContain("SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE");
    expect(result.requiredNames).not.toContain("GOOGLE_CALENDAR_CLIENT_ID");
    expect(result.requiredNames).not.toContain("GOOGLE_CALENDAR_CLIENT_SECRET");
  });

  it("refuses an armed Google connect flag with no credentials to arm it with", () => {
    const result = validateFirstCustomerEnvironment({
      ...MINIMUM_GHL_ENV,
      SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE: "true",
    });
    expect(result.ok).toBe(false);
    expect(result.missingNames).toEqual(
      expect.arrayContaining([
        "GOOGLE_CALENDAR_CLIENT_ID",
        "GOOGLE_CALENDAR_CLIENT_SECRET",
        "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
      ]),
    );
    expect(result.requiredNames).toContain("APP_BASE_URL");
  });

  it("requires optional providers only when their mode or owning capability enables them", () => {
    const baseline = Object.fromEntries(
      Object.entries(MINIMUM_GHL_ENV).filter(([name]) => ![
        "SETTERFI_PHASE1_LIVE", "SETTERFI_GHL_DRIVER", "GHL_CLIENT_ID", "GHL_CLIENT_SECRET",
        "GHL_WEBHOOK_PUBLIC_KEY", "SETTERFI_OPENROUTER_DRIVER", "OPENROUTER_API_KEY",
      ].includes(name)),
    ) as NodeJS.ProcessEnv;
    expect(validateFirstCustomerEnvironment(baseline).ok).toBe(true);
    expect(validateFirstCustomerEnvironment({
      ...baseline, SETTERFI_PHASE8_LIVE: "true", SETTERFI_PHASE8_ALERTS_LIVE: "true",
    }).ok).toBe(true);

    const email = validateFirstCustomerEnvironment({ ...baseline, SETTERFI_EMAIL_DRIVER: "real" });
    expect(email.missingNames).toEqual(expect.arrayContaining([
      "RESEND_API_KEY", "RESEND_WEBHOOK_SIGNING_SECRET", "SETTERFI_EMAIL_FROM",
    ]));

    const offlineNotion = validateFirstCustomerEnvironment({ ...baseline, SETTERFI_NOTION_DRIVER: "offline" });
    expect(offlineNotion.missingNames).toContain("NOTION_EXPORT_PATH");
    expect(offlineNotion.missingNames).not.toContain("NOTION_API_KEY");
    const realNotion = validateFirstCustomerEnvironment({ ...baseline, SETTERFI_NOTION_DRIVER: "real" });
    expect(realNotion.missingNames).toEqual(expect.arrayContaining(["NOTION_API_KEY", "NOTION_KB_ROOT_ID"]));
  });

  it("requires both GHL OAuth bundles when Phase 9 OAuth is enabled", () => {
    const environment = {
      ...MINIMUM_GHL_ENV,
      SETTERFI_PHASE9_LIVE: "true",
      SETTERFI_PHASE9_GHL_OAUTH_LIVE: "true",
      SETTERFI_CREDENTIAL_ENCRYPTION_KEY: "synthetic-encryption-key",
    };
    const result = validateFirstCustomerEnvironment(environment);
    expect(result.missingNames).toEqual(expect.arrayContaining([
      "GHL_INSTALL_URL", "GHL_AGENCY_CLIENT_ID", "GHL_AGENCY_CLIENT_SECRET", "GHL_AGENCY_INSTALL_URL",
    ]));
  });

  it("requires Meta only for Phase 4 and expands it for embedded signup", () => {
    const direct = validateFirstCustomerEnvironment({ ...MINIMUM_GHL_ENV, SETTERFI_PHASE4_LIVE: "true" });
    expect(direct.missingNames).toEqual(expect.arrayContaining([
      "SETTERFI_META_DRIVER", "META_APP_ID", "META_APP_SECRET", "META_SYSTEM_USER_TOKEN",
      "META_WEBHOOK_VERIFY_TOKEN", "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
    ]));
    expect(direct.missingNames).not.toContain("META_LOGIN_CONFIG_ID");
    const embedded = validateFirstCustomerEnvironment({
      ...MINIMUM_GHL_ENV,
      SETTERFI_PHASE4_LIVE: "true",
      SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: "true",
    });
    expect(embedded.missingNames).toEqual(expect.arrayContaining([
      "META_LOGIN_CONFIG_ID", "META_WHATSAPP_SYSTEM_USER_TOKEN", "META_WABA_ID",
      "META_WHATSAPP_PHONE_NUMBER_ID",
    ]));
  });

  it("skips strict values outside Vercel Production but fails them in Production", async () => {
    await expect(verifyEnvContract({ NODE_ENV: "test" }, ["--profile=first-customer", "--if-vercel-production"]))
      .resolves.toBeDefined();
    await expect(verifyEnvContract(
      { NODE_ENV: "production", VERCEL_ENV: "production" },
      ["--profile=first-customer", "--if-vercel-production"],
    )).rejects.toThrow("FIRST_CUSTOMER_ENV_INVALID");
  });

  /**
   * The disarm switch (Ayman, 2026-09-02): "false" — that exact string, nothing else — downgrades
   * an invalid first-customer environment from a failed build to a printed report. The three
   * assertions cover the three ways this could quietly rot: the disarmed build must still PRINT
   * the outstanding names (a silent pass would hide the launch debt), any value other than the
   * literal "false" must keep failing (so a typo like "FALSE" or "0" cannot disarm the gate), and
   * a VALID environment must not print the DISARMED banner (the switch only bites on failure).
   */
  it("disarms only on the literal string false, and still prints the outstanding names", async () => {
    const logs: string[] = [];
    const capture = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    try {
      await expect(verifyEnvContract(
        { NODE_ENV: "production", VERCEL_ENV: "production", SETTERFI_FIRST_CUSTOMER_ENFORCE: "false" },
        ["--profile=first-customer", "--if-vercel-production"],
      )).resolves.toBeDefined();
      const disarmed = logs.find((line) => line.includes("DISARMED"));
      expect(disarmed).toBeDefined();
      expect(disarmed).toContain("missing=");
      for (const wrongValue of ["FALSE", "0", "no", "true", ""]) {
        await expect(verifyEnvContract(
          { NODE_ENV: "production", VERCEL_ENV: "production", SETTERFI_FIRST_CUSTOMER_ENFORCE: wrongValue },
          ["--profile=first-customer", "--if-vercel-production"],
        )).rejects.toThrow("FIRST_CUSTOMER_ENV_INVALID");
      }
      logs.length = 0;
      await expect(verifyEnvContract(
        { ...MINIMUM_GHL_ENV, VERCEL_ENV: "production", SETTERFI_FIRST_CUSTOMER_ENFORCE: "false" },
        ["--profile=first-customer", "--if-vercel-production"],
      )).resolves.toBeDefined();
      expect(logs.some((line) => line.includes("DISARMED"))).toBe(false);
      expect(logs.some((line) => line.includes("verified"))).toBe(true);
    } finally {
      capture.mockRestore();
    }
  });

  it("prints configuration names without rendering secret values", () => {
    const sentinel = "SECRET_SENTINEL_MUST_NEVER_RENDER";
    const run = spawnSync(process.execPath, [SCRIPT, "--profile=first-customer"], {
      encoding: "utf8",
      env: {
        ...MINIMUM_GHL_ENV,
        GHL_CLIENT_SECRET: sentinel,
        GHL_WEBHOOK_PUBLIC_KEY: "",
      },
    });
    const output = `${run.stdout}${run.stderr}`;
    expect(run.status).toBe(1);
    expect(output).toContain("GHL_WEBHOOK_PUBLIC_KEY");
    expect(output).not.toContain(sentinel);
  });

  it("places the Production gate before Next build and exercises it before CI Build", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts.build).toMatch(
      /^node scripts\/verify-env-contract\.mjs --profile=first-customer --if-vercel-production && next build$/,
    );
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow.indexOf("First-customer environment contract (synthetic)"))
      .toBeLessThan(workflow.indexOf("- name: Build"));
    const buildStep = workflow.slice(workflow.indexOf("- name: Build"), workflow.indexOf("\n  rls:"));
    expect(buildStep).toContain("SETTERFI_AUTH_MODE: password");
    expect(buildStep).toContain("SETTERFI_ACCESS_PASSWORD: synthetic-ci-build-password");
  });
});
