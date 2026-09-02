import { describe, expect, it, vi } from "vitest";

import {
  completeGhlAgencyInstall,
  createGhlAgencyCallbackHandler,
} from "@/app/api/channels/messaging/agency-callback/handler";
import {
  completeGhlAgentInstall,
  createGhlCallbackHandler,
} from "@/app/api/channels/messaging/callback/handler";
import { createGhlInstallStartHandler } from "@/app/api/channels/ghl/install-start/handler";
import {
  consumeGhlOAuthState,
  issueGhlOAuthState,
  type GhlOAuthApp,
  type GhlOAuthStateRecord,
  type GhlOAuthStateStore,
  type GhlTokenGrant,
} from "@/lib/integrations/ghl-oauth";
import type { GhlInstallCallbackEvent } from "@/lib/integrations/install-events";

/**
 * The whole install, walked once per app, in the order the browser walks it on the call:
 * an admin clicks Connect → install-start issues a single-use state inside the provider link →
 * the provider redirects back with that state and a code → the callback consumes the state,
 * exchanges the code (injected here; the real exchange is a network call), stores the Company
 * grant, and records the completion receipt with the three install flags.
 *
 * `routes.test.ts` pins every one of those steps in isolation, and each pin has proved a real
 * defect. This exists because none of them proves the steps agree with each other: that the state
 * the starter puts in the URL is the state the callback can consume, on the app the callback
 * serves, and that what lands on the row is what the provider said. The stored links are
 * synthetic — nothing here reads the environment — and the pass condition is the same one the
 * install-day runbook (`docs/SETUP.md`, GoHighLevel chapter) tells the driver to look for in the database.
 */

const APP_BASE_URL = "https://setterfi.test";
const ACTOR = "00000000-0000-4000-8000-000000000001";
const INSTALL_URLS: Readonly<Record<GhlOAuthApp, string>> = {
  agent: "https://marketplace.example.test/v2/oauth/chooselocation?client_id=agent-client&version_id=agent-app",
  provisioning: "https://marketplace.example.test/v2/oauth/chooselocation?client_id=agency-client&version_id=agency-app",
};

function memoryStateStore() {
  const rows = new Map<string, GhlOAuthStateRecord & { consumedAt: string | null }>();
  const store: GhlOAuthStateStore = {
    save: async (record) => void rows.set(record.stateHash, { ...record, consumedAt: null }),
    consume: async (stateHash, consumedAt, app) => {
      const row = rows.get(stateHash);
      if (!row || row.consumedAt || row.app !== app) return null;
      row.consumedAt = consumedAt;
      return { ...row };
    },
    describe: async (stateHash) => {
      const row = rows.get(stateHash);
      return row ? { app: row.app, consumedAt: row.consumedAt } : null;
    },
  };
  return { store, rows };
}

function companyGrant(): GhlTokenGrant {
  return {
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    userType: "Company",
    companyId: "company-1",
    locationId: null,
    isBulkInstallation: true,
    approveAllLocations: true,
    // The one value tomorrow's call exists to flip. The Aug 21 install stored `false`.
    installToFutureLocations: true,
  };
}

function auditClient() {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ table, ...row });
        return { error: null };
      },
    }),
  };
  return { client: client as never, inserts };
}

async function walk(app: GhlOAuthApp) {
  const { store, rows } = memoryStateStore();
  const audit = auditClient();
  const persisted: unknown[] = [];
  const persistAgency = vi.fn(async (grant: GhlTokenGrant, forApp: GhlOAuthApp) => {
    persisted.push({ grant, forApp });
    return { id: `agency-install-${forApp}`, companyId: grant.companyId ?? "company-1", locationId: null, tenantId: null };
  }) as unknown as typeof import("@/lib/integrations/ghl-oauth-store").persistGhlAgencyInstall;

  // 1. The admin's click. `begin` is the real issuer over the in-memory store, with a synthetic
  //    link in place of the configured one, so the URL the browser would open is the real shape.
  const start = createGhlInstallStartHandler({
    enabled: () => true,
    session: async () => ({ userId: ACTOR, role: "owner", tenantId: null }),
    begin: async (input) => {
      const issued = await issueGhlOAuthState({
        app: input.app,
        actorId: input.actorId,
        tenantId: input.tenantId,
        returnPath: input.returnPath,
        appBaseUrl: APP_BASE_URL,
        installUrl: INSTALL_URLS[input.app],
        clientId: `${input.app}-client`,
      }, { states: store });
      return { authorizationUrl: issued.authorizationUrl, expiresAt: issued.expiresAt };
    },
    record: async () => {},
  });
  const startResponse = await start(new Request(`${APP_BASE_URL}/api/channels/ghl/install-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app }),
  }));
  expect(startResponse.status).toBe(201);
  const { authorizationUrl } = await startResponse.json() as { authorizationUrl: string };
  const opened = new URL(authorizationUrl);
  const state = opened.searchParams.get("state");
  expect(state, "the link the browser opens carries our state").toBeTruthy();
  expect(opened.searchParams.get("redirect_uri"), "and points the provider back at the right callback")
    .toBe(`${APP_BASE_URL}/api/channels/messaging/${app === "agent" ? "callback" : "agency-callback"}`);
  expect([...rows.values()][0]?.consumedAt, "nothing is consumed by merely issuing").toBeNull();

  // 2. The provider's redirect, signed out, carrying the state back with a code.
  const record = vi.fn<(event: GhlInstallCallbackEvent) => Promise<void>>(async () => {});
  const callback = app === "agent"
    ? createGhlCallbackHandler({
        enabled: () => true,
        consumeState: (value) => consumeGhlOAuthState({ app: "agent", state: value }, { states: store }),
        complete: (input) => completeGhlAgentInstall(input, {
          exchange: async () => companyGrant(),
          client: () => audit.client,
          persistAgency,
          persistSubAccount: vi.fn() as never,
        }),
        record,
      })
    : createGhlAgencyCallbackHandler({
        enabled: () => true,
        consumeState: (value) => consumeGhlOAuthState({ app: "provisioning", state: value }, { states: store }),
        complete: (input) => completeGhlAgencyInstall(input, {
          exchange: async () => companyGrant(),
          client: () => audit.client,
          persistAgency,
        }),
        record,
      });
  const returned = new URL(`${APP_BASE_URL}/api/channels/messaging/${app === "agent" ? "callback" : "agency-callback"}`);
  returned.searchParams.set("state", state!);
  returned.searchParams.set("code", "provider-code");
  const callbackResponse = await callback(new Request(returned.toString()));

  return { callbackResponse, rows, persisted, persistAgency, inserts: audit.inserts, record, state: state! };
}

describe("the agency install, walked end to end per app", () => {
  it.each(["agent", "provisioning"] as const)("%s: click → link → callback → stored Company grant with the receipt flags", async (app) => {
    const result = await walk(app);

    // The browser lands where the panel expects, with the outcome it reads.
    expect(result.callbackResponse.status).toBe(303);
    expect(result.callbackResponse.headers.get("Location")).toBe(
      app === "agent" ? "/coach/integrations?messaging=linked" : "/admin/provisioning?provisioning=linked",
    );

    // Pass condition 1: the state row is consumed exactly once.
    const [row] = [...result.rows.values()];
    expect(row.consumedAt).not.toBeNull();

    // Pass condition 2: the grant landed on the app's own agency row, as a Company grant.
    expect(result.persistAgency).toHaveBeenCalledTimes(1);
    expect(result.persisted[0]).toMatchObject({ forApp: app, grant: { userType: "Company", installToFutureLocations: true } });

    // Pass condition 3: the completed audit row carries the three flags an operator reads.
    const completion = result.inserts.find((insert) =>
      insert.action === (app === "agent" ? "channel.messaging_install.completed" : "platform.provisioning_install.completed"));
    expect(completion).toBeDefined();
    expect((completion!.payload as { after: Record<string, unknown> }).after).toMatchObject({
      install_target: "company",
      install_to_future_locations: true,
      approve_all_locations: true,
      is_bulk_installation: true,
    });

    // And no failure was recorded on the path that worked.
    expect(result.record).not.toHaveBeenCalled();
  });

  it("a second visit with the same link is refused as already completed, not re-stored", async () => {
    const result = await walk("agent");
    // Replay: the same state, consumed already. The consume predicate returns null, the callback
    // names it, and nothing is persisted twice. This is the Aug 27 failure shape, on purpose.
    const replayed = new URL(`${APP_BASE_URL}/api/channels/messaging/callback`);
    replayed.searchParams.set("state", result.state);
    replayed.searchParams.set("code", "provider-code-again");
    const again = await createGhlCallbackHandler({
      enabled: () => true,
      consumeState: (value) => consumeGhlOAuthState({ app: "agent", state: value }, {
        states: {
          save: async () => {},
          consume: async () => null,
          describe: async () => ({ app: "agent", consumedAt: "2026-09-02T00:00:00.000Z" }),
        },
      }),
      complete: async () => { throw new Error("must not be reached"); },
      record: result.record,
    })(new Request(replayed.toString()));
    expect(again.status).toBe(303);
    expect(again.headers.get("Location")).toBe("/coach/integrations?messaging=error");
    expect(result.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", code: "GHL_OAUTH_STATE_ALREADY_COMPLETED" }));
    expect(result.persistAgency).toHaveBeenCalledTimes(1);
  });
});
