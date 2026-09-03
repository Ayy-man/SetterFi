import { render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Preference } from "@/app/api/notification-preferences/handler";
import {
  AccountSheet,
  accountSheetSection,
  type AccountSheetTerms,
} from "@/components/workspace/rehaul/account-sheet";
import { WorkspaceEnvProvider } from "@/components/workspace/workspace-env";
import { ADMIN_GUIDES } from "@/lib/admin-help-guides";
import { demoViewTargets } from "@/lib/workspace-navigation";

/**
 * The sentences the four replaced surfaces printed under their headings. The rehaul's hard rule is
 * that none of them survives onto a screen -- they belong to the context eye or to nothing -- so
 * they are asserted absent rather than merely not written.
 */
const RETIRED_EXPLAINERS = [
  "The contract a coach accepts at signup. SetterFi stores the approved copy and the hash of it; it never writes the copy.",
  "Review signed-in devices, replace your password, and manage the extra checks supported for sensitive changes.",
  "Task-based runbooks for platform operations and incident checks.",
];

function preference(overrides: Partial<Preference> & { ruleId: string; destination: Preference["destination"] }): Preference {
  return {
    event: "phase8.booking.created",
    scope: "tenant",
    name: "Appointment booked",
    description: "A lead booked a call with you.",
    category: "booking",
    audience: "coach",
    defaultDestinations: ["bell"],
    defaultEnabled: true,
    enabled: overrides.destination === "bell",
    locked: false,
    ...overrides,
  };
}

function ruleFixture(ruleId: string, name: string, locked = false): Preference[] {
  return (["bell", "email", "slack"] as const).map((destination) =>
    preference({ ruleId, destination, name, locked: locked && destination === "bell" }));
}

const PREFERENCES = [
  ...ruleFixture("rule-booking", "Appointment booked"),
  ...ruleFixture("rule-safety", "Safety escalation", true),
];

const TERMS: AccountSheetTerms = {
  acceptanceLive: false,
  drafts: [{
    versionKey: "2026-09-01",
    contentHash: "4b81de03c5a9ffff",
    createdAt: "2026-08-28T10:00:00.000Z",
    publishedAt: null,
  }],
  published: {
    versionKey: "2026-06-01",
    contentHash: "9f2c41ab77d0ffff",
    createdAt: "2026-05-20T10:00:00.000Z",
    publishedAt: "2026-06-01T10:00:00.000Z",
  },
  readError: null,
};

function mountSheet(
  variant: "owner" | "coach",
  extra: { terms?: AccountSheetTerms; mode?: "open" | "password" | "supabase" } = {},
) {
  const { mode = "supabase", ...props } = extra;
  return render(
    <WorkspaceEnvProvider
      account={{ fullName: "Delia Hartman", firstName: "Delia", business: "SetterFi platform" }}
      demoAccountSwitching={false}
      demoViews={demoViewTargets}
      mode={mode}
    >
      <AccountSheet onOpenChange={() => {}} open variant={variant} {...props} />
    </WorkspaceEnvProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/notification-preferences")) {
      return { ok: true, json: async () => ({ preferences: PREFERENCES }) } as Response;
    }
    if (url.startsWith("/api/support/threads")) {
      return {
        ok: true,
        json: async () => ({
          threads: [
            { id: "t1", status: "open" },
            { id: "t2", status: "waiting_on_coach" },
            { id: "t3", status: "resolved" },
          ],
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sheetPanel() {
  let panel: HTMLElement | null = null;
  await waitFor(() => {
    panel = document.querySelector('[data-slot="account-sheet"]');
    expect(panel, "the account sheet did not open, so nothing below was checked").not.toBeNull();
  });
  return panel as unknown as HTMLElement;
}

describe("the owner's account sheet", () => {
  it("renders the four sections, the guide count, and no retired explainer", async () => {
    mountSheet("owner", { terms: TERMS });
    const panel = await sheetPanel();

    expect(within(panel).getByRole("heading", { name: "Account" })).toBeTruthy();
    expect(panel.getAttribute("data-variant")).toBe("owner");
    for (const section of ["account", "settings", "terms", "help"]) {
      expect(panel.querySelector(`[data-section="${section}"]`), section).not.toBeNull();
    }

    // The one figure on the panel is the size of the real catalogue, not a number typed here.
    expect(within(panel).getByText(`${ADMIN_GUIDES.length} guides`)).toBeTruthy();

    for (const sentence of RETIRED_EXPLAINERS) {
      expect(panel.textContent).not.toContain(sentence);
    }
  });

  it("states the registry it was handed, and arms nothing that is not armed", async () => {
    mountSheet("owner", { terms: TERMS });
    const panel = await sheetPanel();

    expect(within(panel).getByText("Acceptance not armed")).toBeTruthy();
    expect(within(panel).getByText("2026-06-01")).toBeTruthy();
    expect(within(panel).getByText("Published")).toBeTruthy();
    expect(within(panel).getByText("2026-09-01")).toBeTruthy();
    expect(within(panel).getByText("Draft")).toBeTruthy();
  });

  /*
   * The topbar mount has no server read behind it, and there is no GET on the terms API. Claiming
   * "nothing published" there would be the exact dishonest state the section exists to avoid, so
   * the section becomes a way through to the route that can answer.
   */
  it("says nothing about publication state when it was handed no registry", async () => {
    mountSheet("owner");
    const panel = await sheetPanel();

    expect(within(panel).queryByText("Acceptance not armed")).toBeNull();
    const link = within(panel).getByRole("link", { name: /account terms registry/u });
    expect(link.getAttribute("href")).toBe("/account?section=terms");
  });

  it("renders each notification rule against all three destinations", async () => {
    mountSheet("owner", { terms: TERMS });
    const panel = await sheetPanel();

    // `getAllBy`: the kit's checkbox is labelled twice on purpose -- the wrapping `<label>` and
    // the `aria-labelledby` span both name it -- so the pairing resolves to more than one node.
    await waitFor(() => {
      expect(within(panel).getAllByLabelText("Bell for Appointment booked").length).toBeGreaterThan(0);
    });
    expect(within(panel).getAllByLabelText("Email for Appointment booked").length).toBeGreaterThan(0);
    expect(within(panel).getAllByLabelText("Slack for Appointment booked").length).toBeGreaterThan(0);
    expect(within(panel).getByText("Required")).toBeTruthy();
  });
});

/*
 * `/auth/signout` writes an `auth.signed_out` row and refuses the sign-out when that write fails,
 * so the receipt beside the button is a fact. The open and password modes end no session and write
 * nothing, so they must not show one.
 */
/*
 * Every toggle under these headers fires a write that the handler records as
 * `notification.preference.changed`. One receipt over the group rather than one per row: the pill
 * is a statement about the control, and forty of them would be noise.
 */
describe("the notification receipt", () => {
  for (const variant of ["owner", "coach"] as const) {
    it(`states that a ${variant} notification change is logged`, async () => {
      mountSheet(variant);
      const panel = await sheetPanel();

      await waitFor(() =>
        expect(within(panel).getAllByText("Notification change logged")).toHaveLength(1));
    });
  }
});

describe("the sign-out receipt", () => {
  for (const variant of ["owner", "coach"] as const) {
    it(`states that sign out is logged on the ${variant} side`, async () => {
      mountSheet(variant);
      const panel = await sheetPanel();

      // The words come from the registry entry for `auth.signed_out`, which mirrors its migration.
      expect(within(panel).getByText("Sign-out logged")).toBeTruthy();
      expect(within(panel).getByText("Sign out")).toBeTruthy();
    });
  }

  it("claims no receipt where there is no session to end", async () => {
    mountSheet("owner", { mode: "open" });
    const panel = await sheetPanel();

    expect(within(panel).getByText("Switch view")).toBeTruthy();
    expect(panel.querySelector('[data-slot="account-sheet-signout-logged"]')).toBeNull();
  });
});

describe("the coach's account sheet", () => {
  it("renders its three sections and the open count", async () => {
    mountSheet("coach");
    const panel = await sheetPanel();

    expect(panel.getAttribute("data-variant")).toBe("coach");
    for (const section of ["account", "notifications", "help"]) {
      expect(panel.querySelector(`[data-section="${section}"]`), section).not.toBeNull();
    }
    expect(panel.querySelector('[data-section="terms"]')).toBeNull();

    // Two of the three fixture threads are unresolved; the resolved one is not open.
    await waitFor(() => expect(within(panel).getByText("2 open")).toBeTruthy());
    expect(within(panel).getByText("Being written")).toBeTruthy();

    // The tips row was an explainer sentence in the body of a panel. The eye carries it now.
    expect(panel.textContent).not.toContain("Tips now live behind the eye");

    for (const sentence of RETIRED_EXPLAINERS) {
      expect(panel.textContent).not.toContain(sentence);
    }
  });

  /*
   * Slack is a platform destination pointed at SetterFi's own channel. The console offers all
   * three; a coach must never be handed a control over it.
   */
  it("offers a coach the app and email, never Slack", async () => {
    mountSheet("coach");
    const panel = await sheetPanel();

    await waitFor(() => {
      expect(
        within(panel).getAllByLabelText("In the app for Appointment booked").length,
      ).toBeGreaterThan(0);
    });
    expect(panel.textContent).not.toContain("Slack");
  });
});

describe("the ?section= deep link", () => {
  it("takes only the sections its own variant draws", () => {
    expect(accountSheetSection("owner", "terms")).toBe("terms");
    expect(accountSheetSection("coach", "notifications")).toBe("notifications");
    // Owner-only sections, and nonsense, both open the sheet at the top rather than at nothing.
    expect(accountSheetSection("coach", "terms")).toBeNull();
    expect(accountSheetSection("owner", "notifications")).toBeNull();
    expect(accountSheetSection("owner", "unknown")).toBeNull();
    expect(accountSheetSection("owner", null)).toBeNull();
  });
});
