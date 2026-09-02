import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  INSTALL_EVENT_ACTIONS,
  installAttempts,
  installAttemptsAccess,
  installAppFromAction,
  installAppLabel,
  installEventGloss,
  type InstallEventRow,
} from "./install-attempts-view-models";

const REF_A = "aaaaaaaaaaaa";
const REF_B = "bbbbbbbbbbbb";

function row(
  id: string,
  action: string,
  createdAt: string,
  after: Record<string, unknown> = {},
): InstallEventRow {
  return {
    id,
    action,
    actorId: null,
    tenantId: null,
    reason: typeof after.error_code === "string" ? after.error_code : null,
    payload: { before: null, after: { app: "provisioning", ...after } },
    createdAt,
  };
}

describe("INSTALL_EVENT_ACTIONS", () => {
  it("names the eight actions an install attempt can be made of", () => {
    expect([...INSTALL_EVENT_ACTIONS].sort()).toEqual([
      "channel.messaging_install.completed",
      "channel.messaging_install.declined",
      "channel.messaging_install.failed",
      "channel.messaging_install.start_refused",
      "channel.messaging_install.started",
      "platform.provisioning_install.completed",
      "platform.provisioning_install.declined",
      "platform.provisioning_install.failed",
    ]);
  });

  it("leaves token lifecycle out, because a reauthorization has no attempt to belong to", () => {
    for (const key of INSTALL_EVENT_ACTIONS) {
      expect(key).not.toContain("reauthorization_required");
    }
  });
});

describe("installAttempts", () => {
  it("groups an issued link and its callback into one attempt, oldest event first", () => {
    const attempts = installAttempts([
      row("2", "platform.provisioning_install.failed", "2026-08-19T14:03:00.000Z", {
        state_ref: REF_A,
        error_code: "GHL_OAUTH_STATE_EXPIRED",
      }),
      row("1", "channel.messaging_install.started", "2026-08-19T14:02:00.000Z", { state_ref: REF_A }),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].stateRef).toBe(REF_A);
    expect(attempts[0].events.map((event) => event.id)).toEqual(["1", "2"]);
    expect(attempts[0].outcome).toBe("failed");
  });

  it("puts the newest attempt first, ordered by when each one started", () => {
    const attempts = installAttempts([
      row("3", "channel.messaging_install.started", "2026-08-19T15:00:00.000Z", { state_ref: REF_B }),
      row("2", "platform.provisioning_install.failed", "2026-08-19T14:03:00.000Z", { state_ref: REF_A }),
      row("1", "channel.messaging_install.started", "2026-08-19T14:02:00.000Z", { state_ref: REF_A }),
    ]);
    expect(attempts.map((attempt) => attempt.stateRef)).toEqual([REF_B, REF_A]);
  });

  it("keeps a stateless callback visible on its own rather than folding it into someone else's", () => {
    const attempts = installAttempts([
      row("2", "platform.provisioning_install.failed", "2026-08-19T14:03:00.000Z", {
        error_code: "GHL_OAUTH_STATE_MISSING",
      }),
      row("1", "channel.messaging_install.started", "2026-08-19T14:02:00.000Z", { state_ref: REF_A }),
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].stateRef).toBeNull();
    expect(attempts[0].events).toHaveLength(1);
  });

  it("reads the outcome off the last event of the attempt", () => {
    const outcomes = [
      ["platform.provisioning_install.completed", "linked"],
      ["platform.provisioning_install.declined", "declined"],
      ["platform.provisioning_install.failed", "failed"],
      ["channel.messaging_install.start_refused", "failed"],
    ] as const;
    for (const [action, outcome] of outcomes) {
      const attempts = installAttempts([
        row("2", action, "2026-08-19T14:03:00.000Z", { state_ref: REF_A }),
        row("1", "channel.messaging_install.started", "2026-08-19T14:02:00.000Z", { state_ref: REF_A }),
      ]);
      expect(attempts[0].outcome).toBe(outcome);
    }
  });

  it("reads an issued link with nothing back yet as pending, never as done", () => {
    const attempts = installAttempts([
      row("1", "channel.messaging_install.started", "2026-08-19T14:02:00.000Z", { state_ref: REF_A }),
    ]);
    expect(attempts[0].outcome).toBe("pending");
  });

  it("calls an action we have no outcome mapping for unknown, never pending", () => {
    const attempts = installAttempts([
      row("2", "channel.messaging_install.something_the_server_lane_added", "2026-08-19T14:03:00.000Z", { state_ref: REF_A }),
      row("1", "channel.messaging_install.started", "2026-08-19T14:02:00.000Z", { state_ref: REF_A }),
    ]);
    // "pending" renders as "Approval not back yet", which is a false claim about an event that
    // plainly did come back.
    expect(attempts[0].outcome).toBe("unknown");
    expect(attempts[0].events[1].step).toBe("event");
  });

  it("leaves the mapped actions reading exactly as they do today", () => {
    for (const [action, outcome] of [
      ["platform.provisioning_install.completed", "linked"],
      ["platform.provisioning_install.declined", "declined"],
      ["channel.messaging_install.failed", "failed"],
      ["channel.messaging_install.started", "pending"],
    ] as const) {
      const attempts = installAttempts([row("1", action, "2026-08-19T14:02:00.000Z", { state_ref: REF_A })]);
      expect(attempts[0].outcome).toBe(outcome);
    }
  });

  it("is pure, so the same rows twice give the same answer", () => {
    const rows = [
      row("2", "platform.provisioning_install.failed", "2026-08-19T14:03:00.000Z", { state_ref: REF_A }),
      row("1", "channel.messaging_install.started", "2026-08-19T14:02:00.000Z", { state_ref: REF_A }),
    ];
    expect(installAttempts(rows)).toEqual(installAttempts(rows));
    expect(readFileSync("src/components/onboarding/install-attempts-view-models.ts", "utf8"))
      .not.toContain("Date.now");
  });

  it("returns at most ten attempts", () => {
    const rows = Array.from({ length: 25 }, (_, index) => row(
      `${index}`,
      "channel.messaging_install.started",
      `2026-08-19T14:${String(index).padStart(2, "0")}:00.000Z`,
      { state_ref: `${index}`.padStart(12, "0") },
    ));
    expect(installAttempts(rows)).toHaveLength(10);
  });
});

describe("installAttemptsAccess", () => {
  const ALLOWED = ["owner", "admin", "success", "build"];
  const REFUSED = ["coach", "affiliate", "", "OWNER", "superuser"];

  it("renders nothing at all when the install flow is switched off, whatever the role", () => {
    for (const actorRole of [...ALLOWED, ...REFUSED, null]) {
      expect(installAttemptsAccess({ installEnabled: false, actorRole })).toBe("off");
    }
  });

  it("refuses a viewer with no platform actor - signed out, no role, or viewing as a client", () => {
    expect(installAttemptsAccess({ installEnabled: true, actorRole: null })).toBe("refused");
  });

  it("refuses every role outside the platform read set", () => {
    for (const actorRole of REFUSED) {
      expect(installAttemptsAccess({ installEnabled: true, actorRole })).toBe("refused");
    }
  });

  it("allows the four roles the provisioning route reads for", () => {
    for (const actorRole of ALLOWED) {
      expect(installAttemptsAccess({ installEnabled: true, actorRole })).toBe("allowed");
    }
  });

  it("refuses an allowed role when the tracker route already answered 403", () => {
    for (const actorRole of ALLOWED) {
      expect(installAttemptsAccess({ installEnabled: true, actorRole, trackerRefused: true })).toBe("refused");
    }
  });

  it("keeps the switched-off answer ahead of the tracker refusal", () => {
    expect(installAttemptsAccess({ installEnabled: false, actorRole: "owner", trackerRefused: true })).toBe("off");
  });

  it("is pure: same inputs, same answer, and it reads neither the clock nor a database", () => {
    const input = { installEnabled: true, actorRole: "success" };
    expect(installAttemptsAccess(input)).toBe(installAttemptsAccess(input));
    const viewModels = readFileSync("src/components/onboarding/install-attempts-view-models.ts", "utf8");
    expect(viewModels).not.toContain("Date.now");
    expect(viewModels).not.toContain("createSupabaseServiceClient");
  });
});

describe("installEventGloss", () => {
  const named = [
    "GHL_OAUTH_STATE_EXPIRED",
    "GHL_OAUTH_STATE_MISSING",
    "GHL_OAUTH_STATE_INVALID_OR_REPLAYED",
    "GHL_OAUTH_GRANT_REVOKED",
    "GHL_OAUTH_TOKEN_ENVELOPE_INVALID",
    "GHL_OAUTH_TOKEN_EXCHANGE_FAILED_NETWORK",
    "GHL_OAUTH_PROVIDER_DECLINED",
    // Codes the panel used to print bare. The two lease-lost codes are separate keys on purpose:
    // losing the agency connection's refresh is a different loss from losing one client's, and the
    // uniqueness assertion below is what stops them borrowing one sentence.
    "GHL_INSTALL_TENANT_UNRESOLVED",
    "GHL_INSTALL_LOCATION_BOUND_ELSEWHERE",
    "GHL_INSTALL_START_TENANT_FORBIDDEN",
    "GHL_AGENCY_INSTALL_USER_TYPE_UNEXPECTED",
    "GHL_OAUTH_STATE_ALREADY_COMPLETED",
    "GHL_AGENCY_INSTALL_LEASE_LOST",
    "GHL_INSTALL_LEASE_LOST",
    "GHL_INSTALL_SECRET_WRITE_FAILED",
  ];

  it("gives every named code its own sentence", () => {
    const sentences = named.map((code) => installEventGloss(code));
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
    expect(new Set(sentences).size).toBe(named.length);
  });

  it("does not claim nothing was stored for the one code where something was", () => {
    // The metadata row was written and reads `installed`; only the credential failed. Borrowing
    // "Nothing was stored" here would send someone looking for a row that exists.
    const sentence = installEventGloss("GHL_INSTALL_SECRET_WRITE_FAILED");
    expect(sentence).not.toMatch(/nothing was stored/i);
    expect(sentence).toMatch(/stored|written/i);
  });

  it("names the missing variables when configuration is the answer", () => {
    const sentence = installEventGloss("DRIVER_CONFIGURATION_ERROR", {
      missingEnv: ["GHL_AGENCY_CLIENT_SECRET"],
    });
    expect(sentence).toContain("GHL_AGENCY_CLIENT_SECRET");
  });

  it("says no sentence has been written for the code yet, rather than echoing it back", () => {
    const code = "SOMETHING_WE_DID_NOT_WRITE_A_SENTENCE_FOR";
    const sentence = installEventGloss(code);
    // The component already prints the raw code beside the gloss, so echoing it renders the
    // identifier twice and reads like a broken row rather than an unnamed one.
    expect(sentence).not.toBe(code);
    expect(sentence).not.toContain(code);
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence).toMatch(/no explanation has been written/i);
    // And it claims nothing either way: we do not know whether this event stored anything.
    expect(sentence).not.toMatch(/nothing was stored/i);
    expect(sentence).not.toMatch(/connected|linked|success/i);
    expect(sentence.replace(/[A-Z][A-Z0-9_]{2,}/g, ""))
      .not.toMatch(/GoHighLevel|GHL |HighLevel|LeadConnector/i);
  });

  it("leaves every named code and the configuration case exactly as they were", () => {
    expect(installEventGloss("GHL_OAUTH_STATE_EXPIRED")).toMatch(/expired/i);
    expect(installEventGloss("DRIVER_CONFIGURATION_ERROR", { missingEnv: ["A_NAMED_VAR"] }))
      .toContain("A_NAMED_VAR");
    for (const code of [...named, "DRIVER_CONFIGURATION_ERROR"]) {
      expect(installEventGloss(code)).not.toMatch(/no explanation has been written/i);
    }
  });

  it("never names the provider in prose, only in the identifier", () => {
    for (const code of [...named, "DRIVER_CONFIGURATION_ERROR"]) {
      const sentence = installEventGloss(code, { missingEnv: ["GHL_CLIENT_ID"] });
      expect(sentence.replace(/[A-Z][A-Z0-9_]{2,}/g, ""))
        .not.toMatch(/GoHighLevel|GHL |HighLevel|LeadConnector/i);
    }
  });
});

describe("the install attempts surface", () => {
  const component = readFileSync("src/components/onboarding/install-attempts.tsx", "utf8");
  const page = readFileSync("src/app/(workspace)/admin/provisioning/page.tsx", "utf8");

  it("renders the attempts through the view models and nothing else", () => {
    expect(component).toContain("installAttempts");
    expect(component).toContain("installEventGloss");
    expect(component).not.toContain("accessCredentialEnvelope");
    expect(component).not.toContain("refreshCredentialEnvelope");
  });

  it("is mounted on the page behind the same flag as the buttons above it", () => {
    expect(page).toContain("InstallAttempts");
    expect(page).toContain("phase9GhlOAuthLive");
  });
  it("names the unknown outcome neutrally, rather than letting it read as pending", () => {
    const tones = component.slice(component.indexOf("const TONES"), component.indexOf("const OUTCOME_LABELS"));
    expect(tones).toMatch(/unknown: "neutral"/);
    const labels = component.slice(component.indexOf("const OUTCOME_LABELS"), component.indexOf("function clock"));
    const unknownLabel = /unknown: "([^"]+)"/.exec(labels)?.[1] ?? "";
    expect(unknownLabel).toMatch(/recorded/i);
    expect(unknownLabel).not.toMatch(/connected|linked|declined|not back yet|did not complete/i);
  });
  it("does not label historical completion as a current connection", () => {
    const labels = component.slice(component.indexOf("const OUTCOME_LABELS"), component.indexOf("function clock"));
    expect(labels).toMatch(/linked: "Stored at that time"/);
    expect(labels).not.toMatch(/linked: "Connected"/);
  });

  it("carries a refused branch, ahead of the unavailable and empty cases, that claims nothing about what was attempted", () => {
    const start = component.indexOf("refused ? (");
    expect(start).toBeGreaterThan(-1);
    // JSX wraps the copy across lines, so flatten before reading it as a sentence.
    const branch = component.slice(start, component.indexOf("unavailable ?", start)).replace(/\s+/g, " ");
    expect(branch).toContain('tone="neutral"');
    expect(branch).toMatch(/platform staff/i);
    expect(branch).toMatch(/not a claim that nothing was attempted/i);
    expect(branch).not.toMatch(/no install has been attempted|the list is empty/i);
  });
});

describe("naming the app an attempt belongs to", () => {
  function bare(
    id: string,
    action: string,
    createdAt: string,
    after: Record<string, unknown>,
  ): InstallEventRow {
    return { id, action, actorId: null, tenantId: null, reason: null, payload: { before: null, after }, createdAt };
  }

  it("reads the app off the action when the success callback did not write it", () => {
    expect(installAppFromAction("channel.messaging_install.completed")).toBe("agent");
    expect(installAppFromAction("platform.provisioning_install.completed")).toBe("provisioning");
    expect(installAppFromAction("something.else.happened")).toBeNull();
  });

  it("names a successful attempt instead of calling it Unnamed app", () => {
    // Exactly the production shape: rows arrive newest-first, and the completion
    // row -- the one seen first -- carries no app field at all.
    const attempts = installAttempts([
      bare("2", "channel.messaging_install.completed", "2026-08-20T10:05:00Z", { state_ref: REF_A, install_state: "stored" }),
      bare("1", "channel.messaging_install.started", "2026-08-20T10:00:00Z", { state_ref: REF_A, app: "agent" }),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe("linked");
    expect(installAppLabel(attempts[0].app)).toBe("Messaging app");
  });

  it("names a provisioning success the same way", () => {
    const attempts = installAttempts([
      bare("2", "platform.provisioning_install.completed", "2026-08-20T10:05:00Z", { state_ref: REF_B, install_target: "company" }),
    ]);
    expect(installAppLabel(attempts[0].app)).toBe("Provisioning app");
  });

  it("still says Unnamed app when nothing on the row can name one", () => {
    const attempts = installAttempts([
      bare("9", "some.unmapped.action", "2026-08-20T10:05:00Z", { state_ref: "cccccccccccc" }),
    ]);
    expect(installAppLabel(attempts[0].app)).toBe("Unnamed app");
  });
});
