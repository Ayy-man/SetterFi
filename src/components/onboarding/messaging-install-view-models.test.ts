import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agencyFutureLocationsFact,
  agencyGrantFacts,
  agencyInstallSummaryLine,
  agencyInstallReadLabel,
  agencyInstallStateLabel,
  INSTALL_START_TIMEOUT_MS,
  messagingInstallOutcome,
  MESSAGING_INSTALL_APPS,
  openInstallPopup,
  startMessagingInstall,
} from "./messaging-install-view-models";

function responder(status: number, body: unknown = {}) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

function rejecting() {
  return vi.fn(async () => { throw new Error("network"); });
}

function unparseable(status: number) {
  return vi.fn(async () => ({ ok: true, status, json: async () => { throw new SyntaxError("not json"); } }));
}

async function start(fetch: ReturnType<typeof responder>, assign = vi.fn()) {
  const result = await startMessagingInstall({
    app: "agent",
    returnPath: "/admin/provisioning",
    fetch,
    assign,
  });
  return { result, assign };
}

describe("startMessagingInstall", () => {
  it("assigns the issued authorization URL exactly once on 201", async () => {
    const { result, assign } = await start(responder(201, { authorizationUrl: "https://provider.example/oauth", expiresAt: "2026-08-19T00:10:00.000Z" }));
    expect(result).toEqual({ status: "redirecting" });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://provider.example/oauth");
  });

  it("POSTs JSON carrying only the app and the return path", async () => {
    const fetch = responder(201, { authorizationUrl: "https://provider.example/oauth" });
    await startMessagingInstall({ app: "provisioning", returnPath: "/admin/provisioning", fetch, assign: vi.fn() });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("/api/channels/ghl/install-start");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ app: "provisioning", returnPath: "/admin/provisioning" });
  });

  it("names every refusal the route can return and never assigns for one", async () => {
    const cases = [
      [404, "not-enabled"],
      [401, "signed-out"],
      [403, "not-allowed"],
      [400, "refused"],
      [503, "error"],
    ] as const;
    for (const [status, expected] of cases) {
      const { result, assign } = await start(responder(status, { error: "refused" }));
      expect(result.status).toBe(expected);
      expect(assign).not.toHaveBeenCalled();
    }
  });

  it("treats a 201 without a usable authorization URL as an error", async () => {
    for (const body of [{}, { authorizationUrl: "" }, { authorizationUrl: 12 }, null]) {
      const { result, assign } = await start(responder(201, body));
      expect(result.status).toBe("error");
      expect(assign).not.toHaveBeenCalled();
    }
  });

  it("swallows a rejected fetch and an unreadable body into the error status", async () => {
    const thrown = await startMessagingInstall({ app: "agent", returnPath: "/admin/provisioning", fetch: rejecting(), assign: vi.fn() });
    expect(thrown.status).toBe("error");
    const unreadable = await startMessagingInstall({ app: "agent", returnPath: "/admin/provisioning", fetch: unparseable(201), assign: vi.fn() });
    expect(unreadable.status).toBe("error");
  });

  it("gives every failure a message that never reads as a connection", async () => {
    for (const status of [404, 401, 403, 400, 503, 500]) {
      const { result } = await start(responder(status));
      if (result.status === "redirecting") throw new Error(`status ${status} should not redirect`);
      expect(result.message.trim().length).toBeGreaterThan(0);
      expect(result.message).not.toMatch(/connected|linked|success/i);
    }
  });
});

describe("openInstallPopup", () => {
  function handle(log: string[], options: { severingThrows?: boolean } = {}) {
    const popup = {
      closed: false,
      close() { log.push("close"); popup.closed = true; },
      location: { href: "" },
    } as { closed: boolean; opener: unknown; close(): void; location: { href: string } };
    Object.defineProperty(popup, "opener", {
      get: () => null,
      set: (value: unknown) => {
        log.push(`opener=${String(value)}`);
        if (options.severingThrows) throw new Error("cross-origin");
      },
    });
    return popup;
  }

  function opener(log: string[], popup: ReturnType<typeof handle> | null) {
    return vi.fn((url: string, target: string) => {
      log.push(`open ${url} ${target}`);
      return popup;
    });
  }

  it("opens one blank tab and severs its opener before it hands the handle back", () => {
    const log: string[] = [];
    const popup = handle(log);
    const open = opener(log, popup);
    const returned = openInstallPopup(open);
    expect(open).toHaveBeenCalledTimes(1);
    // One shared log, so this is the real order rather than two independent presence checks: by
    // the time the caller holds the handle, the sever has already happened.
    expect(log).toEqual(["open about:blank _blank", "opener=null"]);
    expect(returned).toBe(popup);
  });

  it("returns null without throwing when the blocker ate the tab", () => {
    const log: string[] = [];
    expect(openInstallPopup(opener(log, null))).toBeNull();
    expect(log).toEqual(["open about:blank _blank"]);
  });

  it("closes the tab and returns null when the opener cannot be severed", () => {
    const log: string[] = [];
    const popup = handle(log, { severingThrows: true });
    expect(openInstallPopup(opener(log, popup))).toBeNull();
    expect(log).toEqual(["open about:blank _blank", "opener=null", "close"]);
    expect(popup.closed).toBe(true);
  });
});

describe("startMessagingInstall, when nothing answers", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function hanging(inits: { signal?: AbortSignal }[]) {
    return vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      inits.push(init);
      return new Promise<never>(() => {});
    });
  }

  async function hung() {
    const inits: { signal?: AbortSignal }[] = [];
    const assign = vi.fn();
    const pending = startMessagingInstall({
      app: "agent",
      returnPath: "/admin/provisioning",
      fetch: hanging(inits),
      assign,
    });
    await vi.advanceTimersByTimeAsync(INSTALL_START_TIMEOUT_MS);
    return { result: await pending, assign, inits };
  }

  it("gives up on its own and never navigates anywhere", async () => {
    const { result, assign } = await hung();
    expect(result.status).toBe("timeout");
    expect(assign).not.toHaveBeenCalled();
  });

  it("carries an abort signal into the fetch and aborts it when it gives up", async () => {
    const { inits } = await hung();
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
    expect(inits[0].signal?.aborted).toBe(true);
  });

  it("claims neither that a link was issued nor that nothing was started", async () => {
    const { result } = await hung();
    if (result.status === "redirecting") throw new Error("a hung request must not redirect");
    expect(result.message.trim().length).toBeGreaterThan(0);
    expect(result.message).not.toMatch(/issued/i);
    expect(result.message).not.toMatch(/nothing was started/i);
    expect(result.message).not.toMatch(/connected|linked|success/i);
  });

  it("leaves no timer running once the route answers normally", async () => {
    const assign = vi.fn();
    const result = await startMessagingInstall({
      app: "agent",
      returnPath: "/admin/provisioning",
      fetch: responder(201, { authorizationUrl: "https://provider.example/oauth" }),
      assign,
    });
    expect(result).toEqual({ status: "redirecting" });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer running when the fetch rejects", async () => {
    const result = await startMessagingInstall({
      app: "agent",
      returnPath: "/admin/provisioning",
      fetch: rejecting(),
      assign: vi.fn(),
    });
    expect(result.status).toBe("error");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("messagingInstallOutcome", () => {
  it("reads the agent callback key", () => {
    // Tone is deliberately no longer "good". Nothing on this page can corroborate a per-client
    // install, so the banner reports that the approval returned and nothing more. The old
    // assertion pinned the defect.
    expect(messagingInstallOutcome({ messaging: "linked" })).toMatchObject({ app: "agent", outcome: "linked", tone: "pending" });
  });

  it("reads the agency callback key", () => {
    expect(messagingInstallOutcome({ provisioning: "declined" })).toMatchObject({ app: "provisioning", outcome: "declined", tone: "bad" });
    expect(messagingInstallOutcome({ provisioning: "error" })).toMatchObject({ outcome: "error", tone: "bad" });
  });

  it("returns null for an absent, empty, or unrecognised value", () => {
    expect(messagingInstallOutcome({})).toBeNull();
    expect(messagingInstallOutcome({ messaging: "connected" })).toBeNull();
    expect(messagingInstallOutcome({ messaging: "" })).toBeNull();
  });

  it("takes the first entry of a repeated query parameter", () => {
    expect(messagingInstallOutcome({ messaging: ["linked", "declined"] })).toMatchObject({ outcome: "linked" });
  });

  it("resolves both keys to one banner, with the agent key winning", () => {
    const outcome = messagingInstallOutcome({ messaging: "linked", provisioning: "declined" });
    expect(Array.isArray(outcome)).toBe(false);
    expect(outcome).toMatchObject({ app: "agent", outcome: "linked" });
  });
});

describe("messagingInstallOutcome, current-state boundary", () => {
  const STORAGE_CLAIM = /is stored|was stored/i;

  it("never promotes a callback query into a current connection claim", () => {
    const outcome = messagingInstallOutcome({ provisioning: "linked" });
    expect(outcome?.outcome).toBe("linked");
    expect(outcome?.tone).not.toBe("good");
    expect(outcome?.headline).not.toMatch(/connected/i);
    expect(`${outcome?.headline} ${outcome?.detail}`).not.toMatch(STORAGE_CLAIM);
  });

  it("keeps the same evidence boundary for the messaging callback", () => {
    const outcome = messagingInstallOutcome({ messaging: "linked" });
    expect(outcome?.outcome).toBe("linked");
    expect(outcome?.tone).not.toBe("good");
    expect(outcome?.headline).not.toMatch(/connected/i);
    expect(`${outcome?.headline} ${outcome?.detail}`).not.toMatch(STORAGE_CLAIM);
  });

  it("points every linked banner at the separate current-state and historical surfaces", () => {
    const banners = [
      messagingInstallOutcome({ provisioning: "linked" }),
      messagingInstallOutcome({ messaging: "linked" }),
    ];
    for (const banner of banners) expect(banner?.detail).toMatch(/current stored state.*install attempts/i);
  });

  it("leaves declined and error exactly as they were", () => {
    for (const value of ["declined", "error"] as const) {
      const plain = messagingInstallOutcome({ provisioning: value });
      expect(plain?.tone).toBe("bad");
      expect(plain?.detail).toMatch(/nothing was stored/i);
    }
  });
});

describe("MESSAGING_INSTALL_APPS", () => {
  it("holds the two marketplace apps in install order with their button labels", () => {
    expect(MESSAGING_INSTALL_APPS.map((entry) => entry.app)).toEqual(["agent", "provisioning"]);
    expect(MESSAGING_INSTALL_APPS.map((entry) => entry.buttonLabel)).toEqual(["Connect messaging", "Connect provisioning"]);
  });

  it("names no provider anywhere in its copy", () => {
    expect(JSON.stringify(MESSAGING_INSTALL_APPS)).not.toMatch(/GoHighLevel|GHL|HighLevel|LeadConnector|Twilio/i);
  });
});

describe("agencyInstallStateLabel", () => {
  it("calls a missing row not connected", () => {
    expect(agencyInstallStateLabel(null)).toEqual({ label: "Not connected", tone: "neutral" });
  });

  it("calls a healthy token connected", () => {
    expect(agencyInstallStateLabel({ installState: "token_ok", reauthorizationRequiredAt: null }).tone).toBe("good");
  });

  it("refuses to call a token carrying a re-approval marker connected", () => {
    const state = agencyInstallStateLabel({ installState: "token_ok", reauthorizationRequiredAt: "2026-08-18T12:00:00.000Z" });
    expect(state.tone).toBe("bad");
    expect(state.label).toMatch(/re-approval/i);
  });

  it("calls an uninstalled or failed row bad", () => {
    expect(agencyInstallStateLabel({ installState: "uninstalled", reauthorizationRequiredAt: null }).tone).toBe("bad");
    expect(agencyInstallStateLabel({ installState: "failed", reauthorizationRequiredAt: null }).tone).toBe("bad");
  });
});

describe("agencyInstallReadLabel", () => {
  it("does not turn a failed custody read into a not-connected claim", () => {
    expect(agencyInstallReadLabel({ checked: false, row: null }))
      .toEqual({ label: "Could not check stored connection", tone: "neutral" });
  });

  it("delegates a completed empty read to the precise not-connected state", () => {
    expect(agencyInstallReadLabel({ checked: true, row: null }))
      .toEqual({ label: "Not connected", tone: "neutral" });
  });
});

describe("agencyFutureLocationsFact", () => {
  const connected = { installState: "token_ok", reauthorizationRequiredAt: null };

  it("says nothing at all when there is no install to describe", () => {
    expect(agencyFutureLocationsFact(null)).toBeNull();
  });

  it("reports a covered agency and an uncovered one as opposite answers", () => {
    expect(agencyFutureLocationsFact({ ...connected, installToFutureLocations: true }))
      .toEqual({ label: "Covers future sub-accounts: yes", tone: "good" });
    // Not a failure. The installer was offered this and said no. It is the reason a sub-account
    // created tomorrow will have no agent, which is worth an operator reading before they debug it.
    expect(agencyFutureLocationsFact({ ...connected, installToFutureLocations: false }))
      .toEqual({ label: "Covers future sub-accounts: no", tone: "neutral" });
  });

  it("distinguishes an install that never told us from one that said no", () => {
    const unrecorded = agencyFutureLocationsFact({ ...connected, installToFutureLocations: null });
    expect(unrecorded).toEqual({ label: "Covers future sub-accounts: not recorded", tone: "neutral" });
    // Every row stored before the flag was persisted reads this way, and it must not be mistaken
    // for the installer's answer.
    expect(unrecorded?.label).not.toMatch(/: no$/);
  });
});

describe("agencyGrantFacts", () => {
  const stored = {
    approveAllLocations: null,
    isBulkInstallation: null,
    installToFutureLocations: null,
  };

  function fact(row: Parameters<typeof agencyGrantFacts>[0], term: string) {
    return agencyGrantFacts(row).find((entry) => entry.term === term);
  }

  it("has nothing to say about a grant that is not there", () => {
    expect(agencyGrantFacts(null)).toEqual([]);
  });

  /**
   * `updated_at` defaults to `created_at`, so an untouched row carries a stamp that formats like
   * recent activity. Printing it is how a grant from August reads as current.
   */
  it("says a grant has never been refreshed rather than printing its install stamp twice", () => {
    const refreshed = fact(
      { ...stored, createdAt: "2026-08-21T14:05:00.000Z", updatedAt: "2026-08-21T14:05:00.000Z" },
      "Last refreshed",
    );
    expect(refreshed).toEqual({
      term: "Last refreshed",
      value: "Never refreshed since Aug 21, 2026",
      tone: "pending",
    });
    expect(refreshed?.value).not.toMatch(/\d:\d{2}/);
  });

  it("prints the actual instant once something has written the row again", () => {
    expect(fact(
      { ...stored, createdAt: "2026-08-21T14:05:00.000Z", updatedAt: "2026-09-01T18:30:00.000Z" },
      "Last refreshed",
    )).toEqual({
      term: "Last refreshed",
      value: "Sep 1, 2026, 2:30 PM",
      tone: "neutral",
    });
  });

  it("keeps the three consent answers three-valued", () => {
    const row = { createdAt: "2026-08-21T14:05:00.000Z", updatedAt: "2026-08-21T14:05:00.000Z" };
    expect(fact({ ...stored, ...row }, "All sub-accounts approved at install")?.value)
      .toBe("Not recorded");
    // False on this one is the state that leaves a sub-account without the messaging app, so it is
    // the one consent answer allowed to read as something to look at.
    expect(fact({ ...stored, ...row, approveAllLocations: false }, "All sub-accounts approved at install"))
      .toEqual({ term: "All sub-accounts approved at install", value: "No", tone: "pending" });
    expect(fact({ ...stored, ...row, isBulkInstallation: true }, "Installed in bulk")?.value).toBe("Yes");
  });
});

describe("agencyInstallSummaryLine", () => {
  const facts = agencyGrantFacts({
    approveAllLocations: null,
    isBulkInstallation: null,
    installToFutureLocations: null,
    createdAt: "2026-08-21T14:05:00.000Z",
    updatedAt: "2026-08-21T14:05:00.000Z",
  });

  it("withholds the connected claim from a grant nothing has touched since it was stored", () => {
    expect(agencyInstallSummaryLine({ state: { label: "Connected", tone: "good" }, facts }))
      .toEqual({ label: "Never refreshed since Aug 21, 2026", tone: "pending" });
  });

  it("never softens the stronger claim", () => {
    expect(agencyInstallSummaryLine({ state: { label: "Needs re-approval", tone: "bad" }, facts }))
      .toEqual({ label: "Needs re-approval", tone: "bad" });
  });

  it("leaves a state alone when there is no grant to date it", () => {
    expect(agencyInstallSummaryLine({ state: { label: "Not connected", tone: "neutral" }, facts: [] }))
      .toEqual({ label: "Not connected", tone: "neutral" });
  });
});
