import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { STEP_LABELS } from "@/components/onboarding/view-models";
import type { ProvisioningStep } from "@/lib/onboarding/contracts";
import {
  CoachSetup,
  coachSetupAccentRow,
  coachSetupBlockedNames,
  coachSetupChannels,
  coachSetupSteps,
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
 * The demo coach mid-provisioning, which is the state the artboard draws: business details filed,
 * the carriers still deciding, the safe test and go-live ahead, Messenger answering, Instagram's
 * token expired and no calendar yet.
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

describe("CoachSetup, the four steps", () => {
  it("draws the artboard's four steps in the runner's order and no others", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const rows = document.querySelectorAll('[data-slot="coach-setup-step"]');
    expect([...rows].map((row) => row.querySelector("h3")?.textContent)).toEqual([
      "Business details",
      "Carrier review",
      "Safe test",
      "Go live",
    ]);
  });

  /*
   * The rule the whole page turns on. A registration that is `running` with a submission date is
   * filed and waiting, not approved, and every earlier version of this screen had a state that
   * could read finished while the carriers were still deciding.
   */
  it("never reads done while the carriers are still deciding", () => {
    const steps = coachSetupSteps(read(), NOW);
    expect(steps.filter((step) => step.done).map((step) => step.key)).toEqual(["business"]);
    render(<CoachSetup now={NOW} read={read()} />);
    const carrier = document.querySelector('[data-step="carrier"]')!;
    expect(within(carrier as HTMLElement).queryByText("Done")).toBeNull();
  });

  it("counts the carrier wait in real days elapsed, never a percentage or a predicted date", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const carrier = document.querySelector('[data-step="carrier"]') as HTMLElement;
    // 21 August to 4 September in the workspace zone is fourteen whole days.
    expect(carrier.textContent).toContain("Day");
    expect(carrier.querySelector(".mono")?.textContent).toBe("14");
    expect(carrier.textContent).toContain("of about 21");
    expect(carrier.textContent).not.toMatch(/%/u);
    // The only date on the row is the one we filed on, which happened, not one we predicted.
    expect(carrier.textContent).toContain("Sent August 21");
    expect(carrier.textContent).not.toMatch(/(?:by|expect|estimated|due)\s/iu);
  });

  it("counts nothing when the filing date was never recorded", () => {
    const steps = coachSetupSteps(read({ carrier: { kind: "in-review", submittedAt: null } }), NOW);
    const carrier = steps.find((step) => step.key === "carrier")!;
    expect(carrier.pill.label).toBe("In review");
    expect(carrier.receipt).toBe("The filing date was not recorded, so no day count is shown.");
  });

  it("keeps a failed read distinct from a filing that was never made", () => {
    const unchecked = coachSetupSteps(read({ carrier: { kind: "unchecked" } }), NOW);
    const notFiled = coachSetupSteps(read({ carrier: { kind: "not-filed" } }), NOW);
    expect(unchecked.find((step) => step.key === "carrier")!.pill.label).toBe("Not checked");
    expect(notFiled.find((step) => step.key === "carrier")!.pill.label).toBe("Not filed");
  });

  it("says what go-live is waiting on rather than counting it", () => {
    const waitingOnCalendar = coachSetupSteps(read(), NOW).find((step) => step.key === "live")!;
    expect(waitingOnCalendar.receipt).toBe("Waiting on your calendar");
    const waitingOnTest = coachSetupSteps(
      read({ calendar: { checked: true, connected: true, name: "Reid", needsReconnect: false } }),
      NOW,
    ).find((step) => step.key === "live")!;
    expect(waitingOnTest.receipt).toBe("Waiting on the safe test");
  });
});

describe("CoachSetup, the four channels", () => {
  it("draws Instagram, Messenger, texting and the calendar, in that order", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const rows = document.querySelectorAll('[data-slot="coach-setup-channel"]');
    expect([...rows].map((row) => row.getAttribute("data-channel"))).toEqual([
      "instagram",
      "messenger",
      "sms",
      "calendar",
    ]);
  });

  it("names the account on a connected row and offers nothing to press", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const messenger = document.querySelector('[data-channel="messenger"]') as HTMLElement;
    // `displayText` strips the seeder's marker where a human reads the name, and only there.
    expect(messenger.textContent).toContain("Answering messages for Reid Funding since August 29.");
    expect(messenger.textContent).not.toContain("(demo)");
    expect(within(messenger).queryByRole("button")).toBeNull();
    expect(within(messenger).queryByRole("link")).toBeNull();
  });

  it("offers a reconnect, in those words, when the coach's own permission ran out", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const instagram = document.querySelector('[data-channel="instagram"]') as HTMLElement;
    expect(instagram.textContent).toContain("Its permission ran out, and reconnecting brings it back.");
    expect(within(instagram).getByRole("button").textContent).toBe("Reconnect Instagram");
  });

  it("says an outage is ours and presses nothing, because it is not the coach's to fix", () => {
    render(
      <CoachSetup
        now={NOW}
        read={read({
          instagram: channel({ changedAt: "2026-09-01T14:00:00.000Z", state: "error" }),
        })}
      />,
    );
    const instagram = document.querySelector('[data-channel="instagram"]') as HTMLElement;
    expect(instagram.textContent).toContain("Instagram stopped answering on Tuesday. We’re fixing it.");
    expect(within(instagram).queryByRole("button")).toBeNull();
  });

  it("presses nothing on texting in any state, and never repeats the day count", () => {
    for (const state of ["live", "error", null] as const) {
      const rows = coachSetupChannels(read({ sms: channel({ state }) }));
      const sms = rows.find((row) => row.key === "sms")!;
      expect(sms.action).toBeNull();
      expect(sms.sentence).not.toMatch(/day \d/iu);
    }
  });

  it("offers no Meta sign-in when Meta has not approved our app, and says whose wait it is", () => {
    const rows = coachSetupChannels(read({ metaConnect: "awaiting_meta" }));
    const instagram = rows.find((row) => row.key === "instagram")!;
    expect(instagram.action).toBeNull();
    expect(instagram.sentence).toContain("ours to chase");
  });

  it("spends the page's one accent fill on the first connection, not on a repair", () => {
    expect(coachSetupAccentRow(coachSetupChannels(read()))).toBe("calendar");
    const { container } = render(<CoachSetup now={NOW} read={read()} />);
    const filled = [...container.querySelectorAll("a, button")].filter((element) =>
      element.className.includes("var(--accent-fill)"),
    );
    expect(filled).toHaveLength(1);
    expect(filled[0].textContent).toBe("Connect calendar");
  });

  it("falls back to the repair when nothing is waiting to be connected for the first time", () => {
    const rows = coachSetupChannels(
      read({ calendar: { checked: true, connected: true, name: "Reid", needsReconnect: false } }),
    );
    expect(coachSetupAccentRow(rows)).toBe("instagram");
  });
});

describe("CoachSetup, what the page says and what it no longer carries", () => {
  it("counts only the coach's own work in the sentence under the title", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    expect(
      screen.getByText("2 things are waiting on you. Everything else is with us or the carriers."),
    ).toBeTruthy();
  });

  it("says nothing is waiting when nothing is", () => {
    render(
      <CoachSetup
        now={NOW}
        read={read({
          calendar: { checked: true, connected: true, name: "Reid", needsReconnect: false },
          instagram: channel({ liveSince: "2026-08-29T14:00:00.000Z", state: "live" }),
        })}
      />,
    );
    expect(
      screen.getByText("Nothing is waiting on you. Everything here is with us or the carriers."),
    ).toBeTruthy();
  });

  it("says the read failed rather than reporting an empty setup", () => {
    render(
      <CoachSetup
        now={NOW}
        read={read({
          business: { checked: false, completedAt: null },
          calendar: { checked: false, connected: false, name: null, needsReconnect: false },
          carrier: { kind: "unchecked" },
          instagram: channel({ checked: false }),
          messenger: channel({ checked: false }),
          sms: channel({ checked: false }),
          test: { checked: false, completedAt: null },
        })}
      />,
    );
    expect(
      screen.getByText(
        "We could not read your setup just now. Nothing has changed while we could not read it.",
      ),
    ).toBeTruthy();
  });

  it("keeps the technical record closed, and holds the evidence inside it", () => {
    render(<CoachSetup now={NOW} read={read()} />);
    const record = document.querySelector('[data-slot="coach-setup-record"]') as HTMLDetailsElement;
    expect(record.open).toBe(false);
    expect(record.querySelector("summary")?.textContent).toContain("Show the technical record");
    expect(record.textContent).toContain("SetterFi, on your behalf");
    expect(record.textContent).toContain("a1b2c3");
  });

  it("says a record is absent rather than drawing an empty drawer", () => {
    render(<CoachSetup now={NOW} read={read({ record: { checked: true, rows: [] } })} />);
    expect(document.querySelector('[data-slot="coach-setup-record"]')).toBeNull();
    expect(screen.getByText("No filing record has been stored yet.")).toBeTruthy();
  });

  /*
   * `docs/SIMPLIFICATION-SPEC.md` 2.6 sent all of these to admin. The check is on the rendered
   * page rather than on the source so that re-adding one through a helper still fails.
   */
  it("carries none of the diagnostics the spec moved to admin", () => {
    const { container } = render(<CoachSetup now={NOW} read={read()} />);
    for (const banned of [
      "reply window",
      "connection history",
      "last error",
      "message template",
      "what to try",
      "last message event",
      "check again",
    ]) {
      expect(container.textContent?.toLowerCase()).not.toContain(banned);
    }
  });

  it("holds the coach type floor: no rendered size under 14px", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/workspace/rehaul/coach-setup.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//gu, " ");
    const sizes = [...source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/gu)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(4);
    expect(sizes.filter((size) => size < 14)).toEqual([]);
  });
});

describe("a step the runner stopped, which is what Home links here to show", () => {
  /*
   * The defect this covers, found 2026-09-04: Home's status line said "1 step is waiting on you"
   * and drew an "Opt-in pages / Blocked / Fix this step" rung linking to `/coach/get-started`,
   * while Setup's header said nothing was waiting and carried no such row anywhere. A coach was
   * sent to fix a step the destination did not show. Both surfaces read `provisioning_steps` now,
   * and the names come from the same `STEP_LABELS` map Home names its rung from.
   */
  const blocked = (key: ProvisioningStep, stoppedAt: string | null = "2026-09-03T17:34:30.000Z") =>
    read({ blocked: { checked: true, steps: [{ key, stoppedAt }] } });

  it("shows the stopped step as a row, under the name Home gives it", () => {
    render(<CoachSetup now={NOW} read={blocked("optin_artifact")} />);
    const row = screen.getByText("Opt-in pages").closest("li");
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Blocked");
    expect(row?.textContent).toContain("Stopped September 3");
    expect(STEP_LABELS.optin_artifact).toBe("Opt-in pages");
  });

  it("names the stopped step in the header sentence instead of saying nothing is waiting", () => {
    render(
      <CoachSetup
        now={NOW}
        read={{
          ...blocked("optin_artifact"),
          calendar: { checked: true, connected: true, name: "Reid", needsReconnect: false },
          instagram: channel({ liveSince: "2026-08-29T14:00:00.000Z", state: "live" }),
        }}
      />,
    );
    expect(
      screen.getByText(
        "Opt-in pages stopped, and it is ours to fix, not yours. Nothing else is waiting on you.",
      ),
    ).toBeTruthy();
  });

  it("presses nothing on a stopped step, because a blocked step offers the coach no retry", () => {
    render(<CoachSetup now={NOW} read={blocked("optin_artifact")} />);
    const row = screen.getByText("Opt-in pages").closest("li");
    expect(row?.querySelectorAll("button, a").length).toBe(0);
  });

  it("changes the row a stopped step already has rather than drawing that step twice", () => {
    const rows = coachSetupSteps(blocked("business_profile"), NOW);
    expect(rows.map((row) => row.name)).toEqual([
      "Business details",
      "Carrier review",
      "Safe test",
      "Go live",
    ]);
    expect(rows[0].pill.label).toBe("Blocked");
    expect(rows[0].done).toBe(false);
    expect(coachSetupBlockedNames(blocked("business_profile"))).toEqual(["Business details"]);
  });

  it("says the day it stopped in words when the row carried no timestamp", () => {
    const rows = coachSetupSteps(blocked("optin_artifact", null), NOW);
    const stopped = rows.find((row) => row.key === "blocked:optin_artifact");
    expect(stopped?.receipt).toBe("The day it stopped was not recorded.");
  });

  it("draws no stopped row and says nothing about one when the table has none", () => {
    const rows = coachSetupSteps(read(), NOW);
    expect(rows).toHaveLength(4);
    expect(coachSetupBlockedNames(read())).toEqual([]);
    render(<CoachSetup now={NOW} read={read()} />);
    expect(screen.queryByText("Blocked")).toBeNull();
  });
});

describe("both demoted routes still render Setup", () => {
  /*
   * `src/lib/workspace-navigation.test.ts` pins that Get started and Connections stay reachable
   * outside the rail. Folding two pages into one component is exactly the change that could make
   * one of them stop rendering, and a Meta sign-in returns to `/coach/integrations` by name.
   */
  it.each([
    "src/app/(workspace)/coach/get-started/page.tsx",
    "src/app/(workspace)/coach/integrations/page.tsx",
  ])("%s mounts CoachSetup", (path) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source).toContain("<CoachSetup read={read} />");
    expect(source).toContain('activePath="/coach/home"');
  });
});
