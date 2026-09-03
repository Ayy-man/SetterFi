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
    event: "appointment.booked",
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

/**
 * One rule, as the API sends it: one row per destination, which is what the sheet reads its
 * columns off. `destinations` is a parameter rather than a constant because the column set being
 * derived from the payload is the behaviour under test.
 */
function ruleFixture(
  ruleId: string,
  overrides: Partial<Preference>,
  destinations: readonly Preference["destination"][] = ["bell", "email"],
): Preference[] {
  return destinations.map((destination) =>
    preference({
      ruleId,
      destination,
      ...overrides,
      locked: overrides.locked === true && destination === "bell",
    }));
}

/**
 * Four rules over three categories, including the collision this redesign was reported for.
 *
 * `onboarding.stalled_external` is seeded twice, once platform-scoped for the console and once
 * tenant-scoped for the coach, and both halves were given the name "Setup waiting on provider".
 * They are two rules with two audiences and two stored preferences, so the panel has to draw both
 * and has to say which is which.
 */
const PREFERENCES = [
  ...ruleFixture("rule-booking", {}),
  ...ruleFixture("rule-safety", {
    event: "conversation.tripwire_escalated",
    name: "Conversation escalated",
    category: "safety",
    locked: true,
  }),
  ...ruleFixture("rule-stalled-platform", {
    event: "onboarding.stalled_external",
    scope: "platform",
    name: "Setup waiting on provider",
    category: "onboarding",
  }),
  ...ruleFixture("rule-stalled-tenant", {
    event: "onboarding.stalled_external",
    name: "Setup waiting on provider",
    category: "onboarding",
  }),
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

type Account = {
  fullName: string | null;
  firstName: string | null;
  business: string | null;
  isDemo?: boolean;
};

const ACCOUNT: Account = {
  fullName: "Delia Hartman",
  firstName: "Delia",
  business: "SetterFi platform",
};

function mountSheet(
  variant: "owner" | "coach",
  extra: {
    terms?: AccountSheetTerms;
    mode?: "open" | "password" | "supabase";
    account?: Account;
  } = {},
) {
  const { account = ACCOUNT, mode = "supabase", ...props } = extra;
  return render(
    <WorkspaceEnvProvider
      account={account}
      demoAccountSwitching={false}
      demoViews={demoViewTargets}
      mode={mode}
    >
      <AccountSheet onOpenChange={() => {}} open variant={variant} {...props} />
    </WorkspaceEnvProvider>,
  );
}

/** The preferences the stubbed API answers with. A test reassigns it before mounting. */
let servedPreferences: Preference[] = PREFERENCES;

beforeEach(() => {
  servedPreferences = PREFERENCES;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/notification-preferences")) {
      return { ok: true, json: async () => ({ preferences: servedPreferences }) } as Response;
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

  it("draws one checkbox per rule per destination the API returned", async () => {
    mountSheet("owner", { terms: TERMS });
    const panel = await sheetPanel();

    // `getAllBy`: the kit's checkbox is labelled twice on purpose -- the wrapping `<label>` and
    // the `aria-labelledby` span both name it -- so the pairing resolves to more than one node.
    await waitFor(() => {
      expect(within(panel).getAllByLabelText("Bell for Appointment booked").length).toBeGreaterThan(0);
    });
    expect(within(panel).getAllByLabelText("Email for Appointment booked").length).toBeGreaterThan(0);
  });

  /*
   * The column set is read off the preferences the route returned rather than listed in the
   * component, so the destinations the store holds are the destinations the panel draws. That is
   * the whole point: removing Slack from `notification_preferences.destination` had to be done in
   * four separate literals, one of them in this sheet, and adding one back would have to be done in
   * all four again.
   *
   * A third destination in the payload is drawn with no edit here, under a title-cased fallback
   * where nothing has given it a word yet, and its boxes carry the stored values for that
   * destination rather than a copy of another column's.
   */
  it("draws a column for every destination the API returned, and only those", async () => {
    servedPreferences = [
      ...PREFERENCES,
      preference({
        ruleId: "rule-booking",
        destination: "carrier_pigeon" as Preference["destination"],
        enabled: false,
      }),
    ];
    mountSheet("owner");
    const panel = await sheetPanel();

    await waitFor(() => {
      expect(within(panel).getAllByLabelText("Bell for Appointment booked").length)
        .toBeGreaterThan(0);
    });
    const head = panel.querySelector('[data-slot="account-sheet-matrix-head"]') as HTMLElement;
    expect(within(head).getByText("Bell")).toBeTruthy();
    expect(within(head).getByText("Email")).toBeTruthy();
    expect(within(head).getByText("Carrier pigeon")).toBeTruthy();

    // The one rule that carries a row for it gets a box; the three that do not get an empty cell
    // rather than a control over nothing.
    expect(
      within(panel).getAllByLabelText("Carrier pigeon for Appointment booked").length,
    ).toBeGreaterThan(0);
    expect(
      within(panel).queryAllByLabelText("Carrier pigeon for Conversation escalated"),
    ).toHaveLength(0);
  });

  /*
   * Around forty rows in a 520px panel. The column words used to be printed once at the top and
   * were gone by the second section, leaving thirty rows of unlabelled squares.
   */
  it("keeps the destination columns and their category band on screen while the rows scroll", async () => {
    mountSheet("owner");
    const panel = await sheetPanel();

    await waitFor(() => {
      expect(panel.querySelector('[data-slot="account-sheet-matrix-head"]')).not.toBeNull();
    });
    const head = panel.querySelector('[data-slot="account-sheet-matrix-head"]') as HTMLElement;
    expect(head.className).toContain("sticky");
    expect(head.className).toContain("top-0");

    const band = panel.querySelector('[data-slot="account-sheet-matrix-group"]') as HTMLElement;
    expect(band.className).toContain("sticky");
    // Under the head rather than over it, at the head's own height.
    expect(band.className).toContain("top-[34px]");
  });

  /*
   * The rules arrive as a flat list of around forty. They carry `alert_rules.category`, which is
   * what the console notifications page has always grouped by, so the sheet groups by the same
   * column rather than inventing sections of its own.
   */
  it("groups the rules under their own category headings", async () => {
    mountSheet("owner");
    const panel = await sheetPanel();

    await waitFor(() => {
      expect(panel.querySelectorAll('[data-slot="account-sheet-matrix-group"]').length).toBe(3);
    });
    for (const [category, heading] of [
      ["booking", "Bookings"],
      ["safety", "Safety"],
      ["onboarding", "Setup"],
    ]) {
      const section = panel.querySelector(`[data-category="${category}"]`) as HTMLElement;
      expect(section, category).not.toBeNull();
      expect(within(section).getByText(heading)).toBeTruthy();
    }
  });

  /*
   * The two rules named "Setup waiting on provider" are `onboarding.stalled_external` at both
   * scopes: different audiences, different suppressibility, their own stored preferences. They
   * read as one notification listed twice until the panel says which is which.
   */
  it("tells two rules that share a name apart by their scope", async () => {
    mountSheet("owner");
    const panel = await sheetPanel();

    await waitFor(() =>
      expect(within(panel).getAllByText("Setup waiting on provider")).toHaveLength(2));
    expect(within(panel).getByText("Platform")).toBeTruthy();
    expect(within(panel).getByText("Client account")).toBeTruthy();

    // A name nothing collides with takes no qualifier, so the word does the work where it is needed
    // and nowhere else.
    const booking = panel.querySelector('[data-category="booking"]') as HTMLElement;
    expect(within(booking).queryByText("Client account")).toBeNull();
  });

  /*
   * Sixteen "Required" pills and sixteen padlocks said one thing sixteen times. The control says
   * it now -- a checked box that cannot be changed -- and the sentence above the sections says why,
   * once, with both figures counted off the rules on screen.
   */
  it("says once that some notices are required, and locks their boxes rather than labelling them", async () => {
    mountSheet("owner");
    const panel = await sheetPanel();

    await waitFor(() => {
      expect(panel.querySelector('[data-slot="account-sheet-locked-note"]')).not.toBeNull();
    });
    expect(within(panel).getByText(/1 of the 4 notices below is required/u)).toBeTruthy();
    expect(within(panel).queryByText("Required")).toBeNull();
    expect(panel.querySelector('[data-slot="matrix-checkbox-lock"]')).toBeNull();

    // A required row reads as required through its own control: a checked box that cannot be
    // changed. The kit's checkbox is a composite widget, so "cannot be changed" is `aria-disabled`
    // rather than the `disabled` attribute of a native input.
    const locked = within(panel).getAllByRole("checkbox", {
      name: "Bell for Conversation escalated",
    })[0]!;
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.getAttribute("aria-checked")).toBe("true");

    const open = within(panel).getAllByRole("checkbox", { name: "Bell for Appointment booked" })[0]!;
    expect(open.getAttribute("aria-disabled")).not.toBe("true");
  });

  /*
   * The name as a person reads it, with the seeded marker carried by a pill. It used to print the
   * raw column beside a sign-out button and an uppercase audit badge, which truncated
   * "Theo Brightwell (demo)" to a name cut mid-word.
   */
  it("reads the person's name without the seeded marker, and says demo in a pill instead", async () => {
    mountSheet("owner", {
      account: {
        fullName: "Theo Brightwell (demo)",
        firstName: "Theo",
        business: "Brightwell Capital (demo)",
        isDemo: true,
      },
    });
    const panel = await sheetPanel();

    const name = panel.querySelector('[data-slot="account-sheet-person"]') as HTMLElement;
    expect(name.textContent).toBe("Theo Brightwell");
    expect(within(panel).getByText("Brightwell Capital")).toBeTruthy();
    expect(within(panel).getByText("Demo")).toBeTruthy();
    expect(panel.textContent).not.toContain("(demo)");
  });

  it("says nothing about demo for an account that is not seeded", async () => {
    mountSheet("owner");
    const panel = await sheetPanel();

    expect(within(panel).getByText("Delia Hartman")).toBeTruthy();
    expect(within(panel).queryByText("Demo")).toBeNull();
  });
});

/*
 * The two receipts, moved out of the header.
 *
 * They said the true thing: `/auth/signout` writes an `auth.signed_out` row and refuses the
 * sign-out when that write fails, and the preferences PUT records every change as
 * `notification.preference.changed`. They said it in two uppercase badges at the top of the panel,
 * one of them sitting where the destination columns belong. The words are the registry's, still,
 * in one line at the foot.
 */
describe("the audit line", () => {
  for (const variant of ["owner", "coach"] as const) {
    it(`names both records once, at the foot of the ${variant} sheet`, async () => {
      mountSheet(variant);
      const panel = await sheetPanel();

      const note = panel.querySelector('[data-slot="account-sheet-audit-note"]') as HTMLElement;
      expect(note).not.toBeNull();
      expect(within(note).getByText("Sign-out logged")).toBeTruthy();
      expect(within(note).getByText("Notification change logged")).toBeTruthy();
      expect(within(panel).getAllByText("Notification change logged")).toHaveLength(1);

      // It is the last thing in the panel, not the first.
      const body = note.parentElement as HTMLElement;
      expect(body.lastElementChild).toBe(note);
    });
  }

  it("claims no sign-out record where there is no session to end", async () => {
    mountSheet("owner", { mode: "open" });
    const panel = await sheetPanel();

    expect(within(panel).getByText("Switch view")).toBeTruthy();
    expect(panel.querySelector('[data-slot="account-sheet-audit-auth.signed_out"]')).toBeNull();
    // The preference write still happens in this mode, so its record is still named.
    expect(within(panel).getByText("Notification change logged")).toBeTruthy();
  });

  it("still offers the sign-out itself", async () => {
    mountSheet("owner");
    const panel = await sheetPanel();

    expect(within(panel).getByText("Sign out")).toBeTruthy();
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
   * The coach's picker options are the same payload-derived columns the console matrix draws,
   * under the coach's words for them. The `not.toContain` guard is kept as a regression check:
   * Slack was removed in `20261012000001_remove_slack_alert_destination.sql` and must not come
   * back through the UI.
   */
  it("offers a coach the app and email, grouped and unlabelled by any Required pill", async () => {
    mountSheet("coach");
    const panel = await sheetPanel();

    await waitFor(() => {
      expect(
        within(panel).getAllByLabelText("In the app for Appointment booked").length,
      ).toBeGreaterThan(0);
    });
    expect(panel.textContent).not.toContain("Slack");

    expect(panel.querySelectorAll('[data-slot="account-sheet-matrix-group"]').length).toBe(3);
    expect(within(panel).getByText("Bookings")).toBeTruthy();
    expect(within(panel).queryByText("Required")).toBeNull();
    expect(panel.querySelector('[data-slot="matrix-checkbox-lock"]')).toBeNull();
    expect(within(panel).getByText(/required/u)).toBeTruthy();
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
