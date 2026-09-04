import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { STEP_LABELS } from "@/components/onboarding/view-models";
import {
  CoachSetup,
  CoachSetupRows,
  coachSetupBlockedNames,
  coachSetupChannels,
  coachSetupOpenRow,
  coachSetupRows,
  coachSetupSentence,
  coachSetupSteps,
  coachSetupYours,
  type CoachSetupChannelRead,
  type CoachSetupRead,
} from "@/components/workspace/rehaul/coach-setup";

/*
 * The connect button opens its sheet through the app router's `refresh`, and the test renderer
 * mounts no router. The mock is the same shape `coach-inbox.test.tsx` uses.
 */
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

const NOW = new Date("2026-09-04T15:00:00.000Z");

const NOT_CONNECTED: CoachSetupChannelRead = {
  accountLabel: null,
  changedAt: null,
  checked: true,
  liveSince: null,
  state: null,
};

function channel(overrides: Partial<CoachSetupChannelRead> = {}): CoachSetupChannelRead {
  return { ...NOT_CONNECTED, ...overrides };
}

/**
 * The demo coach mid-provisioning: business details filed, the carriers still deciding, the safe
 * test and go-live ahead, Messenger answering, Instagram's token expired, no calendar yet and no
 * offer yet.
 */
function read(overrides: Partial<CoachSetupRead> = {}): CoachSetupRead {
  return {
    blocked: { checked: true, steps: [] },
    business: { checked: true, completedAt: "2026-08-28T14:00:00.000Z" },
    calendar: { checked: true, connected: false, name: null, needsReconnect: false },
    carrier: { kind: "in-review", submittedAt: "2026-08-21T14:00:00.000Z" },
    goLive: { checked: true, completedAt: null },
    instagram: channel({ changedAt: "2026-09-01T14:00:00.000Z", state: "expired" }),
    messenger: channel({
      accountLabel: "Reid Funding (demo)",
      liveSince: "2026-08-29T14:00:00.000Z",
      state: "live",
    }),
    metaConnect: "ready",
    offer: { checked: true, published: false },
    record: {
      checked: true,
      rows: [
        { label: "Filed by", value: "SetterFi, on your behalf" },
        { label: "Campaign hash", value: "a1b2c3" },
      ],
    },
    sms: channel(),
    test: { checked: true, completedAt: null },
    ...overrides,
  };
}

/** Everything done: the state the demo override presents and the state a live coach is in. */
function finished(): CoachSetupRead {
  return read({
    calendar: { checked: true, connected: true, name: "Coaching calls", needsReconnect: false },
    carrier: { kind: "live" },
    goLive: { checked: true, completedAt: "2026-09-03T14:00:00.000Z" },
    instagram: channel({ accountLabel: "reid.funding", liveSince: "2026-08-29T14:00:00.000Z", state: "live" }),
    offer: { checked: true, published: true },
    sms: channel({ accountLabel: "+1 555 0100", state: "live" }),
    test: { checked: true, completedAt: "2026-09-02T14:00:00.000Z" },
  });
}

function rowsOnScreen() {
  return [...document.querySelectorAll("[data-slot='coach-setup-row']")] as HTMLElement[];
}

function accentFills() {
  return [...document.querySelectorAll("a, button")].filter((node) =>
    node.className.includes("[background:var(--accent-fill)]")
  );
}

describe("coachSetupRows, one list in journey order", () => {
  it("draws the coach's four rows, then the timeline, and gives every row an owner", () => {
    const rows = coachSetupRows(read(), NOW);
    expect(rows.map((row) => row.key)).toEqual([
      "business", "channels", "calendar", "offer", "carrier", "test", "live",
    ]);
    expect(rows.map((row) => row.owner)).toEqual([
      "you", "you", "you", "you", "carriers", "us", "you",
    ]);
  });

  it("puts a button only on a row the coach owns", () => {
    for (const row of coachSetupRows(read(), NOW)) {
      if (row.owner !== "you") expect(row.action, row.key).toBeNull();
    }
  });

  it("opens the first row the coach can move that is not done, never a repair on a finished row", () => {
    const rows = coachSetupRows(read(), NOW);
    // Messenger answers, so the pair is done and Instagram's reconnect is a repair, not the gap.
    expect(rows.find((row) => row.key === "channels")?.done).toBe(true);
    expect(rows.find((row) => row.key === "channels")?.action?.label).toBe("Reconnect Instagram");
    expect(coachSetupOpenRow(rows)).toBe("calendar");
    expect(coachSetupYours(rows).map((row) => row.key)).toEqual(["channels", "calendar", "offer"]);
  });

  it("never reads done while the carriers are still deciding", () => {
    const rows = coachSetupRows(read(), NOW);
    expect(rows.find((row) => row.key === "carrier")?.done).toBe(false);
    expect(rows.find((row) => row.key === "test")?.done).toBe(false);
    expect(rows.find((row) => row.key === "live")?.done).toBe(false);
  });

  it("counts the carrier wait in real days elapsed, never a percentage or a predicted date", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const carrier = rowsOnScreen().find((row) => row.dataset.row === "carrier")!;
    expect(carrier.textContent).toContain("Day 14 of about 21");
    expect(carrier.textContent).toContain("Sent August 21");
    expect(carrier.textContent).not.toMatch(/%/u);
    expect(carrier.textContent).not.toMatch(/finish(es|ed)? on/u);
  });

  it("counts nothing when the filing date was never recorded", () => {
    const rows = coachSetupRows(read({ carrier: { kind: "in-review", submittedAt: null } }), NOW);
    const carrier = rows.find((row) => row.key === "carrier")!;
    expect(carrier.pill.label).toBe("In review");
    expect(carrier.receipt).toContain("not recorded");
  });

  it("offers go live only once every row above it is done, and says what it waits on until then", () => {
    const waiting = coachSetupRows(read(), NOW).find((row) => row.key === "live")!;
    expect(waiting.action).toBeNull();
    expect(waiting.receipt).toBe("After your calendar, your offer, and then the safe test.");

    const readyRead = finished();
    readyRead.goLive = { checked: true, completedAt: null };
    const ready = coachSetupRows(readyRead, NOW).find((row) => row.key === "live")!;
    expect(ready.action).toEqual({ href: "/onboarding/go-live", kind: "link", label: "Go live" });
    expect(coachSetupOpenRow(coachSetupRows(readyRead, NOW))).toBe("live");
  });

  it("keeps a failed read distinct from a step that was never done", () => {
    const rows = coachSetupRows(read({ offer: { checked: false, published: false } }), NOW);
    const offer = rows.find((row) => row.key === "offer")!;
    expect(offer.action).toBeNull();
    expect(offer.pill.label).toBe("Not checked");
  });
});

describe("the sentence both surfaces print", () => {
  it("counts only the coach's own work, in words, and says where the carriers are", () => {
    const rows = coachSetupRows(read(), NOW);
    expect(coachSetupSentence(rows, read(), NOW)).toBe(
      "Three things are yours to do. Text messages are on day 14 of about 21.",
    );
  });

  it("says nothing is waiting when nothing is", () => {
    const done = finished();
    expect(coachSetupSentence(coachSetupRows(done, NOW), done, NOW)).toBe(
      "Nothing is waiting on you. Everything here is with us or the carriers.",
    );
  });

  it("says the read failed rather than reporting an empty setup", () => {
    const unread = read({
      business: { checked: false, completedAt: null },
      calendar: { checked: false, connected: false, name: null, needsReconnect: false },
      carrier: { kind: "unchecked" },
      instagram: channel({ checked: false }),
      messenger: channel({ checked: false }),
      sms: channel({ checked: false }),
      test: { checked: false, completedAt: null },
    });
    expect(coachSetupSentence(coachSetupRows(unread, NOW), unread, NOW)).toContain("could not read your setup");
  });
});

describe("a step the runner stopped", () => {
  const stopped = () => read({
    blocked: { checked: true, steps: [{ key: "optin_artifact", stoppedAt: "2026-09-02T14:00:00.000Z" }] },
  });

  it("becomes a row of ours, under the name Home used to give it, with nothing to press", () => {
    const rows = coachSetupRows(stopped(), NOW);
    const row = rows.find((entry) => entry.key === "blocked:optin_artifact")!;
    expect(row.name).toBe(STEP_LABELS.optin_artifact);
    expect(row.owner).toBe("us");
    expect(row.action).toBeNull();
    expect(row.pill.label).toBe("Stopped");
    expect(row.receipt).toBe("Stopped September 2");
  });

  it("changes the row a stopped step already has rather than drawing that step twice", () => {
    const rows = coachSetupRows(read({
      blocked: { checked: true, steps: [{ key: "a2p_brand", stoppedAt: null }] },
    }), NOW);
    expect(rows.filter((row) => row.key.startsWith("blocked:"))).toHaveLength(0);
    const carrier = rows.find((row) => row.key === "carrier")!;
    expect(carrier.pill.label).toBe("Stopped");
    expect(carrier.owner).toBe("us");
    expect(carrier.receipt).toBe("The day it stopped was not recorded.");
  });

  it("names the stopped step in the sentence and never counts it as the coach's", () => {
    const rows = coachSetupRows(stopped(), NOW);
    const sentence = coachSetupSentence(rows, stopped(), NOW);
    expect(sentence).toContain(`${STEP_LABELS.optin_artifact} stopped, and it is ours to fix, not yours.`);
    expect(sentence).toContain("Three things are yours to do.");
    expect(coachSetupBlockedNames(stopped())).toEqual([STEP_LABELS.optin_artifact]);
  });
});

describe("the channels, folded into the journey", () => {
  it("names the account on a connected row and offers nothing to press for it", () => {
    render(<CoachSetup now={NOW} read={finished()} />);
    const pair = rowsOnScreen().find((row) => row.dataset.row === "channels")!;
    expect(pair.textContent).toContain("Answering messages for Reid Funding since August 29.");
    expect(pair.textContent).not.toContain("(demo)");
    expect(pair.querySelectorAll("a, button")).toHaveLength(0);
  });

  it("offers a reconnect, in those words, when the coach's own permission ran out", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const pair = rowsOnScreen().find((row) => row.dataset.row === "channels")!;
    expect(within(pair).getByRole("button", { name: "Reconnect Instagram" })).toBeTruthy();
    expect(pair.textContent).toContain("Its permission ran out, and reconnecting brings it back.");
  });

  it("says an outage is ours and presses nothing, because it is not the coach's to fix", () => {
    const rows = coachSetupRows(read({
      instagram: channel({ changedAt: "2026-09-01T14:00:00.000Z", state: "error" }),
    }), NOW);
    const pair = rows.find((row) => row.key === "channels")!;
    expect(pair.action).toBeNull();
    expect(pair.facts.find((fact) => fact.name === "Instagram")?.sentence)
      .toBe("Instagram stopped answering on Tuesday. We’re fixing it.");
  });

  it("offers no Facebook sign-in when Facebook has not approved our app, and says whose wait it is", () => {
    const rows = coachSetupRows(read({
      instagram: channel(),
      messenger: channel(),
      metaConnect: "awaiting_meta",
    }), NOW);
    const pair = rows.find((row) => row.key === "channels")!;
    expect(pair.action).toBeNull();
    expect(pair.pill.label).toBe("Not ready yet");
    expect(pair.body).toContain("ours to chase");
  });

  it("presses nothing on texting in any state and says it on the carrier row only once", () => {
    expect(coachSetupChannels(finished()).find((row) => row.key === "sms")?.action).toBeNull();
    const rows = coachSetupRows(finished(), NOW);
    expect(rows.find((row) => row.key === "carrier")?.receipt).toBe("Your leads can text you at +1 555 0100.");
    expect(rows.filter((row) => row.receipt?.includes("+1 555 0100"))).toHaveLength(1);
  });

  it("keeps the four per-channel derivations in order for the read that composes them", () => {
    expect(coachSetupChannels(read()).map((row) => row.key)).toEqual([
      "instagram", "messenger", "sms", "calendar",
    ]);
    expect(coachSetupSteps(read(), NOW).map((row) => row.key)).toEqual([
      "business", "carrier", "test", "live",
    ]);
  });
});

describe("CoachSetup, the page", () => {
  it("spends its one accent fill on the open row's button and none when nothing is the coach's", () => {
    const view = render(<CoachSetup now={NOW} read={read()} />);
    const fills = accentFills();
    expect(fills).toHaveLength(1);
    expect(fills[0].textContent).toBe("Connect your calendar");
    expect((fills[0].closest("[data-slot='coach-setup-row']") as HTMLElement | null)?.dataset.open).toBe("true");
    view.unmount();

    render(<CoachSetup now={NOW} read={finished()} />);
    expect(accentFills()).toHaveLength(0);
    expect(rowsOnScreen().filter((row) => row.dataset.open === "true")).toHaveLength(0);
  });

  it("opens exactly one row and keeps every other row to a line", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const open = rowsOnScreen().filter((row) => row.dataset.open === "true");
    expect(open).toHaveLength(1);
    expect(open[0].dataset.row).toBe("calendar");
    expect(open[0].textContent).toContain("Your agent needs somewhere to put the calls it books.");
    const offer = rowsOnScreen().find((row) => row.dataset.row === "offer")!;
    expect(offer.textContent).not.toContain("Your agent uses this to answer questions");
    expect(offer.querySelectorAll("a, button")).toHaveLength(0);
  });

  it("draws the timeline with a spine that stops at go live", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const timeline = rowsOnScreen().filter((row) => row.dataset.owner !== "you" || row.dataset.row === "live");
    expect(timeline.map((row) => row.dataset.row)).toEqual(["carrier", "test", "live"]);
    expect(document.querySelectorAll("[data-slot='coach-setup-spine']")).toHaveLength(2);
    expect(timeline[2].querySelector("[data-slot='coach-setup-spine']")).toBeNull();
  });

  it("prints the sentence under the title from the same rows it draws", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Getting you live");
    expect(document.querySelector("[data-slot='coach-setup-sentence']")?.textContent).toBe(
      "Three things are yours to do. Text messages are on day 14 of about 21.",
    );
    expect(document.querySelector("[data-slot='coach-setup-count']")?.textContent).toBe("2 of 4 done");
  });

  it("keeps the technical record closed, and holds the evidence inside it", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const details = document.querySelector("[data-slot='coach-setup-record']") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("a1b2c3");
    expect(details.textContent).toContain("SetterFi, on your behalf");
  });

  it("says a record is absent rather than drawing an empty drawer", () => {
    render(<CoachSetup now={NOW} read={read({ record: { checked: true, rows: [] } })} />);
    expect(document.querySelector("[data-slot='coach-setup-record']")).toBeNull();
    expect(document.body.textContent).toContain("No filing record has been stored yet.");
  });

  it("carries none of the diagnostics the spec moved to admin", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    for (const phrase of ["Reply window", "Connection history", "Last error", "What to try", "Check again", "Message templates"]) {
      expect(document.body.textContent).not.toContain(phrase);
    }
    expect(screen.queryByRole("button", { name: /check again/iu })).toBeNull();
  });

  it("holds the coach type floor: no rendered size under 14px", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    for (const node of document.body.querySelectorAll("*")) {
      for (const match of (node.className.toString()).matchAll(/text-\[(\d+)px\]/gu)) {
        expect(Number(match[1]), node.className.toString()).toBeGreaterThanOrEqual(14);
      }
    }
  });
});

describe("CoachSetupRows, compact, which is what Home draws", () => {
  it("draws the same rows, opens the same one, and keeps the closed rows to their line", () => {
    const rows = coachSetupRows(read(), NOW);
    render(<CoachSetupRows compact headingId="home-setup" rows={rows} />);
    expect(rowsOnScreen().map((row) => row.dataset.row)).toEqual(rows.map((row) => row.key));
    expect(rowsOnScreen().filter((row) => row.dataset.open === "true").map((row) => row.dataset.row)).toEqual(["calendar"]);
    expect(accentFills()).toHaveLength(1);
    const carrier = rowsOnScreen().find((row) => row.dataset.row === "carrier")!;
    expect(carrier.textContent).toContain("Day 14 of about 21");
    expect(carrier.textContent).not.toContain("nobody is told a finish date");
  });
});

describe("both demoted routes still render Setup", () => {
  const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("mounts CoachSetup from /coach/get-started and /coach/integrations off one read", () => {
    for (const page of [
      "src/app/(workspace)/coach/get-started/page.tsx",
      "src/app/(workspace)/coach/integrations/page.tsx",
    ]) {
      expect(source(page)).toContain("loadCoachSetup(context.tenantId");
      expect(source(page)).toContain("<CoachSetup");
    }
  });
});
