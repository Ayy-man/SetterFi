/**
 * The four demo accounts `scripts/seed-staging-users.mjs` creates, and the gate that
 * decides whether /login offers them as one-click buttons.
 *
 * Offering them puts a live, working password into the page's server-rendered HTML,
 * which is the whole reason the gate exists and defaults off: without
 * SETTERFI_DEMO_LOGINS set to exactly "true" there is nothing here to render, so the
 * absent case and the nothing-to-show case are the same code path.
 *
 * The emails and the password are duplicated in the seeder, so
 * `demo-logins.test.ts` asserts the two lists against its source text — a button must
 * never come to offer an account nobody created.
 */
import {
  demoLoginsEnabled,
  productionDemoLoginsEnabled,
  type EnvironmentSource,
} from "@/lib/env-contract";
import { isProductionDeployment } from "@/lib/auth/mode";

import type { UserRole } from "./claims";

/**
 * The password is read from the environment and never written here. The previous literal was
 * committed, so it has to be treated as disclosed forever regardless of what the accounts are set
 * to now; a rotated value in source would only restart that clock. With the variable unset there is
 * no password to offer, which collapses into the same nothing-to-render path as the gate being off.
 */
export function demoLoginPassword(environment: EnvironmentSource = process.env): string | null {
  const value = environment.SETTERFI_DEMO_LOGIN_PASSWORD;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export type DemoLoginAccount = {
  readonly role: UserRole;
  readonly email: string;
  readonly label: string;
  readonly password: string;
};

/** Button order, which is also the order the seeder prints its credential block in. */
const DEMO_LOGIN_ACCOUNT_IDENTITIES: readonly Omit<DemoLoginAccount, "password">[] = [
  {
    role: "owner",
    email: "support+owner@livelegacystrong.com",
    label: "Sign in as owner",
  },
  {
    role: "admin",
    email: "support+admin@livelegacystrong.com",
    label: "Sign in as admin",
  },
  {
    role: "coach",
    email: "support+coach@livelegacystrong.com",
    label: "Sign in as coach",
  },
  {
    role: "affiliate",
    email: "support+affiliate@livelegacystrong.com",
    label: "Sign in as affiliate",
  },
] as const;

export function demoLoginAccounts(
  environment: EnvironmentSource = process.env,
): readonly DemoLoginAccount[] {
  const password = demoLoginPassword(environment);
  const productionBlocked = isProductionDeployment(environment)
    && !productionDemoLoginsEnabled(environment);
  if (!demoLoginsEnabled(environment) || productionBlocked || password === null) {
    return [];
  }

  return DEMO_LOGIN_ACCOUNT_IDENTITIES.map((account) => ({ ...account, password }));
}
