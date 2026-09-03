import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Preference } from "@/app/api/notification-preferences/handler";
import { AlertSettings } from "@/components/workspace/live/alert-settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const destinations = ["bell", "email"] as const;

const preferences: Preference[] = destinations.map((destination) => ({
  ruleId: "rule-booked",
  event: "appointment.booked",
  scope: "tenant",
  name: "Appointment booked",
  description: "A lead booked an appointment.",
  category: "booking",
  audience: "coach",
  defaultDestinations: ["bell", "email"],
  defaultEnabled: true,
  destination,
  enabled: true,
  locked: false,
}));

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function renderSettings(
  surface: "admin-alerts" | "coach-settings",
  affiliateAccess = false,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ preferences })),
  );
  render(
    <AlertSettings
      affiliateAccess={affiliateAccess}
      enabled
      surface={surface}
    />,
  );
}

/**
 * Every checkbox is nameable, whether or not it carries visible text of its own.
 *
 * The admin surface is a permission matrix, so its column header is the destination's only visible
 * name and each cell is a bare checkbox with an `aria-label` pairing the destination to its row.
 * The coach surface is a stacked list with no column headers, so each control keeps its own
 * visible `<label>`. Asserting the accessible name covers both shapes, and is the thing that
 * actually matters: the old assertion forced ninety-six words of duplicated visible text.
 */
async function expectEveryCheckboxIsNamed(expectedCount: number) {
  await waitFor(() => {
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      expectedCount,
    );
  });

  const checkboxes = screen.getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(expectedCount);
  for (const checkbox of checkboxes) {
    expect(checkbox).toBeVisible();
    expect(computeAccessibleName(checkbox)).not.toBe("");
  }
}

function computeAccessibleName(element: HTMLElement) {
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = element.getAttribute("aria-labelledby")?.trim();
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
  }
  const labels = Array.from((element as HTMLInputElement).labels ?? []);
  return labels
    .map((label) => label.textContent?.trim() ?? "")
    .join(" ")
    .trim();
}

describe("AlertSettings", () => {
  it("names every admin checkbox by destination and rule, without repeating the column header", async () => {
    renderSettings("admin-alerts");

    await expectEveryCheckboxIsNamed(3);
    for (const destination of ["Bell", "Email"]) {
      expect(
        screen.getByRole("checkbox", {
          name: `${destination} for Appointment booked`,
        }),
      ).toBeVisible();
      // The destination is named once, by the column header, and never again in the cell.
      expect(
        screen.queryAllByText(destination, { selector: "td *" }),
      ).toHaveLength(0);
    }
  });

  /**
   * The coach's two destinations are named in the coach's own words.
   *
   * "Bell" is the console's column header for a cell in a permission matrix; a coach's question is
   * where the notice turns up, so the same destination reads "In the app" here. The "Slack" absence
   * below is a regression guard: the destination was removed in
   * `20261012000001_remove_slack_alert_destination.sql` and must not return through this surface.
   */
  it("names the coach destinations in the coach's words", async () => {
    renderSettings("coach-settings");

    await expectEveryCheckboxIsNamed(2);
    expect(screen.getAllByText("In the app").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Email").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("checkbox", { name: "In the app for Appointment booked" }),
    ).toBeVisible();
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
    expect(screen.queryByText("appointment.booked")).not.toBeInTheDocument();
    expect(
      document.querySelector('a[href="/affiliate"]'),
    ).not.toBeInTheDocument();
  });

  it("keeps affiliate navigation conditional on the coach capability", async () => {
    renderSettings("coach-settings", true);

    await waitFor(() => {
      expect(
        document.querySelectorAll('a[href="/affiliate"]').length,
      ).toBeGreaterThan(0);
    });
  });

  it("serializes writes until the current preference is read back", async () => {
    let resolveWrite: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ preferences }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveWrite = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<AlertSettings enabled surface="admin-alerts" />);

    const bell = await screen.findByRole("checkbox", {
      name: "Bell for Appointment booked",
    });
    fireEvent.click(bell);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "Email for Appointment booked" }),
      ).toHaveAttribute("aria-disabled", "true");
    });
    const email = screen.getByRole("checkbox", {
      name: "Email for Appointment booked",
    });
    fireEvent.click(email);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveWrite?.(
        jsonResponse({
          preference: {
            ruleId: "rule-booked",
            destination: "bell",
            enabled: false,
            locked: false,
          },
        }),
      );
    });

    expect(
      await screen.findByText(
        "Saved after the stored preference was read back.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Bell for Appointment booked" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Email for Appointment booked" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("reports a write without read-back as unconfirmed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ preferences }))
      .mockRejectedValueOnce(new TypeError("connection closed"));
    vi.stubGlobal("fetch", fetchMock);
    render(<AlertSettings enabled surface="admin-alerts" />);

    const bell = await screen.findByRole("checkbox", {
      name: "Bell for Appointment booked",
    });
    fireEvent.click(bell);

    expect(
      await screen.findByText(
        "We could not confirm this change. Reload to read the saved preference before trying again.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Bell for Appointment booked" }),
    ).toBeChecked();
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("signal");
  });

  it("carries the write's outcome on a callout dot, with no coloured edge", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ preferences }))
      .mockRejectedValueOnce(new TypeError("connection closed"));
    vi.stubGlobal("fetch", fetchMock);
    render(<AlertSettings enabled surface="admin-alerts" />);

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Bell for Appointment booked",
      }),
    );

    const callout = await screen.findByText("Change not confirmed");
    const card = callout.closest('[data-slot="callout"]');
    expect(card).toHaveAttribute("data-tone", "critical");
    expect(
      card?.querySelector('[data-slot="callout-dot"]')?.className,
    ).toContain("--critical");
    // The tone reaches the dot and nothing else: no left stripe, no tinted rail.
    expect(card?.className).not.toMatch(/border-l-|border-s-/u);
    expect(screen.getByRole("status")).toContainElement(card as HTMLElement);
  });
});

/**
 * The coach surface's own invariants, separate from the write-path suite above.
 *
 * `CoachNotifications.dc.html` is the artboard this branch was ported to, and its claim is that a
 * notice is a name, a plain-English sentence saying what it tells you, and the controls under it --
 * never a row the coach has to infer from two ticked boxes. The guard is per row rather than per
 * page, because the row that loses its sentence is the row nobody notices.
 */
describe("AlertSettings coach surface, the ported canvas", () => {
  /*
   * The artboard's h1 is the question -- "Where should we tell you?" at 46px -- and the page also
   * carries a back chip, because it is reached from the account menu and the topbar bell and has
   * no other way out. Both were missing: the h1 said "Settings" and the question was a panel name
   * four blocks down.
   */
  it("asks the canvas's question as the page title rather than naming the box", async () => {
    renderSettings("coach-settings");

    const title = await screen.findByRole("heading", { level: 1 });
    expect(title).toHaveTextContent("Where should we tell you?");
    expect(title).toHaveClass("coach-page-title");
    // The question is the page now, so it must not also be a panel heading underneath.
    expect(screen.queryAllByRole("heading", { name: "Where should we tell you?" })).toHaveLength(1);
  });

  it("gives the page a way out, since nothing on the page led here", async () => {
    renderSettings("coach-settings");

    const back = document.querySelector('[data-slot="coach-settings-back"]');
    expect(back, "the coach reaches this from the account menu and the bell").not.toBeNull();
    expect(back).toHaveAttribute("href", "/coach/home");
    expect(back).toHaveTextContent("Back to Home");
  });

  it("gives every notice row a consequence line, and counts the notices off the rules", async () => {
    renderSettings("coach-settings");

    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="coach-notice-row"]')).toHaveLength(1);
    });
    for (const row of document.querySelectorAll('[data-slot="coach-notice-row"]')) {
      const sentence = row.querySelector('[data-slot="coach-notice-sentence"]');
      expect(sentence?.textContent?.trim(), "every notice row states its consequence").toBeTruthy();
    }
    // The artboard says "four things, and only these four". The rule set is a table the client's
    // own team edits, so the number is counted rather than written.
    expect(
      screen.getByText(/1 notice, and only these/u),
      "the panel counts its own notices instead of asserting a fixed four",
    ).toBeVisible();
  });

  /**
   * The consequence line has to be the sentence the platform authored for the rule, not one this
   * component inferred from two checkboxes. Asserting "some sentence rendered" would pass just as
   * happily on the fallback, so this asserts the authored words are present AND that the fallback's
   * wording is absent: with both destinations on, the derived line is a specific string, and seeing
   * it means the authored one was dropped somewhere between the column and here.
   */
  it("states the rule's own sentence rather than one derived from the checkboxes", async () => {
    renderSettings("coach-settings");

    expect(await screen.findByText("A lead booked an appointment.")).toBeVisible();
    expect(
      screen.queryByText("Appears here in the app and arrives by email."),
      "the derived line is the fallback for a blank description, never the first choice",
    ).not.toBeInTheDocument();
  });

  it("falls back to the derived line rather than drawing a blank consequence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({
        preferences: preferences.map((preference) => ({ ...preference, description: "  " })),
      })),
    );
    render(<AlertSettings enabled surface="coach-settings" />);

    expect(await screen.findByText("Appears here in the app and arrives by email.")).toBeVisible();
    for (const row of document.querySelectorAll('[data-slot="coach-notice-row"]')) {
      expect(row.querySelector('[data-slot="coach-notice-sentence"]')?.textContent?.trim()).toBeTruthy();
    }
  });

  /**
   * The page head is the coach's, not the console's.
   *
   * `PageHeader` sets its title with `.t-page-title`, the console's 20px, and no prop moves it, so
   * a coach page that keeps it is not ported however faithful the rest of the markup is. The 46px
   * `.coach-page-title` is the first thing a reader over 55 sees and it is the reason this whole
   * branch exists.
   */
  it("heads the page at the coach's 46px title rather than the console's", async () => {
    renderSettings("coach-settings");

    // The name moved to the canvas's question in the same pass that added the back chip; what
    // this test has always guarded is the scale, which is unchanged.
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Where should we tell you?",
    });
    expect(heading.className).toContain("coach-page-title");
    expect(document.querySelector('[data-page-head="coach-settings"]')).toContainElement(heading);
  });

  /**
   * No 9.5px uppercase overline reaches a coach's eyes.
   *
   * Round-1 demo feedback was explicit that coaches over 55 could not read them, and the kit's
   * `Overline` is exactly that role. The query is scoped to the panels rather than the document so
   * it guards this page's own markup and not the shell chrome around it, and it asserts the panels
   * exist first -- an empty NodeList is a pass for the wrong reason.
   */
  it("spends no uppercase overline on the coach panels", async () => {
    renderSettings("coach-settings");

    await waitFor(() => {
      expect(document.querySelectorAll(".coach-panel").length).toBe(2);
    });
    for (const panel of document.querySelectorAll(".coach-panel")) {
      expect(panel.querySelector('[data-slot="overline"]')).toBeNull();
    }
    // The eyebrow that replaced it is still there and still says which panel this is.
    expect(screen.getByText("Delivery")).toBeVisible();
    expect(screen.getByText("Notices")).toBeVisible();
  });

  it("spends no accent fill on a surface that saves on every click", async () => {
    renderSettings("coach-settings");

    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="coach-notice-row"]')).toHaveLength(1);
    });
    // Nothing here is a deferred save, so there is no single live action to light. Zero fills is
    // the correct resting state under the One Fill Rule, not an unfinished one.
    //
    // Scoped to #main, and the scoping is the rule rather than a narrowing of it. The One Fill
    // Rule is about *this page's* one live action; the shell mounts chrome that is not competing
    // for that read, and this query could only ever see part of it. `coach.css:247` has painted
    // the active pill-bar destination with `--accent-fill` on every coach page since the redesign
    // and this line never counted it, because a stylesheet rule carries no class to match -- so
    // the document-wide version was measuring "no class-spelled fill", not "no fill". The support
    // bubble's launcher is the same kind of object, identical on all eight coach routes, and it
    // simply arrived wearing a class.
    //
    // The boundary is one the code guarantees rather than one this line asserts into existence:
    // `app-shell.tsx` mounts the bubble outside <main> deliberately -- a fixed dialog should not
    // sit inside the landmark it floats over -- and `app-shell.test.tsx` pins that with "keeps the
    // bubble outside <main>". Move the bubble into the content region and that test goes red,
    // rather than this one quietly starting to count it.
    expect(
      document.querySelector("#main")!.querySelectorAll('[class*="--accent-fill"]'),
      "the coach settings surface has no Save, so it lights nothing",
    ).toHaveLength(0);
  });

  it("never nests a card inside a card", async () => {
    renderSettings("coach-settings");

    await waitFor(() => {
      expect(document.querySelectorAll(".coach-panel").length).toBe(2);
    });
    for (const card of document.querySelectorAll(".coach-panel, .surface-card")) {
      expect(
        card.querySelector(".coach-panel, .surface-card"),
        "a panel contains wells and rows, never another panel",
      ).toBeNull();
    }
  });

  /**
   * The row's three parts stack; identity and metadata never share a line.
   *
   * This is the inbox failure written down. There, a `shrink-0` mono timestamp shared a flex line
   * with a truncating 17px name in a 324px column and every lead rendered as "Jo...", "M..." --
   * and nothing went red, because `truncate` is invisible to jsdom. Pixels cannot be asserted here,
   * so placement is: the name, the sentence and the controls are three separate children of the
   * row's text column, in that order.
   */
  it("keeps the notice name, its sentence and its controls on separate lines", async () => {
    renderSettings("coach-settings");

    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="coach-notice-row"]')).toHaveLength(1);
    });
    const row = document.querySelector('[data-slot="coach-notice-row"]') as HTMLElement;
    const sentence = row.querySelector('[data-slot="coach-notice-sentence"]') as HTMLElement;
    const controls = row.querySelector('[data-slot="coach-notice-controls"]') as HTMLElement;
    const name = screen.getByText("Appointment booked");

    expect(sentence.parentElement).toBe(controls.parentElement);
    expect(sentence.contains(name)).toBe(false);
    expect(controls.contains(name)).toBe(false);
    expect(sentence.contains(controls)).toBe(false);
  });
});

/**
 * The delivery panel, and the two rows of the artboard it deliberately does not draw.
 *
 * `notification_preferences.destination` is `bell | email`. There is no column an SMS
 * preference could be written to, and this page loads notification rules and nothing else, so it
 * holds no carrier-review start date to count elapsed days from. The artboard's "Text message" and
 * "Both" cards would therefore have been a control over nothing and a day counter over nothing,
 * which is the exact shape the honest-states rule forbids.
 */
describe("AlertSettings coach surface, the delivery panel", () => {
  it("offers only the destinations the store can hold, with no SMS row and no day counter", async () => {
    renderSettings("coach-settings");

    const cards = await waitFor(() => {
      const found = document.querySelectorAll('[data-slot="coach-delivery-card"]');
      expect(found).toHaveLength(2);
      return found;
    });
    expect([...cards].map((card) => card.getAttribute("data-destination"))).toEqual([
      "bell",
      "email",
    ]);
    expect(screen.queryByText(/Text message/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Both$/u)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/day \d+ of carrier review/u),
      "nothing on this page carries a provisioning date, so it cannot count days from one",
    ).not.toBeInTheDocument();
  });

  /**
   * A card states what the notices are doing; it is not a pick-one control.
   *
   * The stored preference is per notice and per destination, so a card that set a destination for
   * the whole account would be writing a setting the API does not have -- and would overwrite the
   * per-notice choices below it. The count is the honest thing a card can say, and it has to be
   * able to say a measured zero.
   */
  it("counts each destination off the rules rather than offering an account-level switch", async () => {
    renderCoachWith(
      preferencesFor([
        {
          ruleId: "rule-booked",
          name: "Appointment booked",
          category: "booking",
          defaultDestinations: ["bell", "email"],
          enabledDestinations: ["bell"],
        },
        {
          ruleId: "rule-needs-human",
          name: "Conversation needs a person",
          category: "conversation",
          defaultDestinations: ["bell"],
          enabledDestinations: ["bell"],
        },
      ]),
    );

    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="coach-delivery-card"]')).toHaveLength(2);
    });
    const [bellCard, emailCard] = [
      ...document.querySelectorAll('[data-slot="coach-delivery-card"]'),
    ];
    expect(bellCard?.textContent).toContain("2 of the 2 notices appear here in your bell.");
    expect(emailCard?.textContent).toContain("0 of the 2 notices arrive by email.");
    expect(emailCard?.textContent).toContain("Not in use");
    // No checkbox, radio or button lives in a card: the choosing happens in the rows below.
    for (const card of document.querySelectorAll('[data-slot="coach-delivery-card"]')) {
      expect(card.querySelector("input, button, [role=\"radio\"]")).toBeNull();
    }
  });
});

/**
 * The grouped notices, and the facts a group has to state without being opened.
 *
 * The console keeps its accordion; the coach side does not have one. The artboard draws every
 * notice as a visible sentence, and a coach who has to open four drawers to find out whether a
 * booking reaches their email is the reader this port exists for. The group summary is counted off
 * its own rules and has to be able to say a measured zero -- a summary that can express "some" but
 * not "none" sends the reader through every row anyway.
 */
function preferencesFor(
  rules: readonly {
    ruleId: string;
    name: string;
    category: string;
    defaultDestinations: readonly ("bell" | "email")[];
    enabledDestinations: readonly ("bell" | "email")[];
    locked?: boolean;
  }[],
): Preference[] {
  return rules.flatMap((rule) =>
    destinations.map((destination) => ({
      ruleId: rule.ruleId,
      event: `${rule.ruleId}.event`,
      scope: "tenant" as const,
      name: rule.name,
      description: `${rule.name} happened.`,
      category: rule.category,
      audience: "coach",
      defaultDestinations: [...rule.defaultDestinations],
      defaultEnabled: true,
      destination,
      enabled: rule.enabledDestinations.includes(destination),
      locked: rule.locked ?? false,
    })),
  );
}

function renderCoachWith(list: Preference[]) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ preferences: list })));
  render(<AlertSettings enabled surface="coach-settings" />);
}

describe("AlertSettings coach surface, the notice groups", () => {
  it("states a measured zero in a group summary rather than dropping the word", async () => {
    renderCoachWith(
      preferencesFor([
        {
          ruleId: "rule-booked",
          name: "Appointment booked",
          category: "booking",
          defaultDestinations: ["bell", "email"],
          enabledDestinations: ["bell"],
        },
      ]),
    );

    const summary = await screen.findByText(/in the app/u, {
      selector: '[data-slot="coach-notice-group-summary"]',
    });
    // "read it, and it is none" is a different fact from "could not read it", and only the first
    // one is true here. The summary has to say 0 out loud.
    expect(summary.textContent).toContain("0 by email");
    expect(summary.textContent).toContain("1 in the app");
  });

  it("shows every notice at once instead of hiding groups behind a toggle", async () => {
    renderCoachWith(
      preferencesFor([
        {
          ruleId: "rule-booked",
          name: "Appointment booked",
          category: "booking",
          defaultDestinations: ["bell", "email"],
          enabledDestinations: ["bell", "email"],
        },
        {
          ruleId: "rule-needs-human",
          name: "Conversation needs a person",
          category: "conversation",
          defaultDestinations: ["bell"],
          enabledDestinations: ["bell"],
        },
      ]),
    );

    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="coach-notice-group"]')).toHaveLength(2);
    });
    // Both groups' rows are on the screen with nothing clicked, and no drawer is left to open.
    expect(document.querySelectorAll('[data-slot="coach-notice-row"]')).toHaveLength(2);
    expect(screen.getByText("Appointment booked")).toBeVisible();
    expect(screen.getByText("Conversation needs a person")).toBeVisible();
    // Scoped to the notices panel: the shell's own chrome carries expandable buttons of its own,
    // and this is a claim about the rows rather than about the sidebar.
    const panel = document.querySelector('[data-slot="coach-notice-group"]')?.closest(".coach-panel");
    expect(panel).not.toBeNull();
    expect(panel?.querySelectorAll("[aria-expanded]")).toHaveLength(0);
  });

  /**
   * The Ownership Rule, made literal. The accent tile is the only mark on the page saying "you
   * moved this off our default", so it has to be absent from a row still on the default -- an
   * accent square on every row is decoration, and decoration that looks like a signal is worse
   * than no signal.
   */
  it("tints the row tile only where the coach has moved a notice off the default", async () => {
    renderCoachWith(
      preferencesFor([
        {
          ruleId: "rule-a-default",
          name: "On the default",
          category: "booking",
          defaultDestinations: ["bell", "email"],
          enabledDestinations: ["bell", "email"],
        },
        {
          ruleId: "rule-b-changed",
          name: "Changed by the coach",
          category: "booking",
          defaultDestinations: ["bell", "email"],
          enabledDestinations: ["bell"],
        },
      ]),
    );

    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="coach-notice-row"]')).toHaveLength(2);
    });
    const tones = [...document.querySelectorAll('[data-slot="coach-notice-row"]')].map((row) => [
      row.querySelector('[data-slot="coach-notice-sentence"]')?.textContent?.trim(),
      row.querySelector('[data-slot="icon-tile"]')?.getAttribute("data-tone"),
    ]);
    expect(tones).toEqual([
      ["On the default happened.", "neutral"],
      ["Changed by the coach happened.", "accent"],
    ]);
  });

  it("never renders an absence as a pill", async () => {
    // The admin table is where this can regress: it prints a control state in every row, so an
    // "Optional" lozenge there would out-weigh the handful of rows that genuinely cannot change.
    // The coach surface renders the marker only on required rows, so asserting it there proves
    // nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          preferences: preferencesFor([
            {
              ruleId: "rule-booked",
              name: "Appointment booked",
              category: "booking",
              defaultDestinations: ["bell", "email"],
              enabledDestinations: ["bell", "email"],
            },
            {
              ruleId: "rule-locked",
              name: "Tripwire escalation",
              category: "safety",
              defaultDestinations: ["bell"],
              enabledDestinations: ["bell"],
              locked: true,
            },
          ]),
        }),
      ),
    );
    render(<AlertSettings enabled surface="admin-alerts" />);

    expect(await screen.findByText("Required")).toBeVisible();
    expect(screen.queryByText("Optional")).not.toBeInTheDocument();
    expect(screen.getByText("Can be switched off")).toBeInTheDocument();
  });
});

/**
 * The console keeps its own density, and this is the guard that stops a later coach-side edit
 * dragging it across.
 *
 * The two branches of this component are two products: the console is a permission matrix for the
 * client's team, in it all day, and three other lanes own it. Everything the coach port introduced
 * -- the 46px page title, the deck panels, the coach's word for the bell -- has to be absent here,
 * and the table with its per-destination columns has to still be what an admin gets.
 */
describe("AlertSettings admin surface, console density", () => {
  it("keeps the admin branch on the console's table and out of the coach language", async () => {
    renderSettings("admin-alerts");

    // Positive control first: the console really rendered, so the absences below mean something.
    expect(
      await screen.findByRole("checkbox", { name: "Email for Appointment booked" }),
    ).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: /Bell/u })).toBeVisible();
    expect(screen.getByRole("region", { name: "Notification rules" })).toBeVisible();

    expect(document.querySelectorAll(".coach-panel")).toHaveLength(0);
    expect(document.querySelectorAll(".coach-page-title")).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="coach-notice-row"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="coach-delivery-card"]')).toHaveLength(0);
    expect(screen.queryByText("In the app")).not.toBeInTheDocument();
  });
});

/**
 * Test data is segregated AND labelled on-screen. The route hides `demo` rules from coaches and
 * deliberately leaves admins unfiltered, so the admin table is the one place a seeded rule reaches
 * a screen, and it is therefore the one place that has to say so.
 */
describe("AlertSettings admin surface, seeded rules", () => {
  it("labels a seeded rule as test data and leaves a real one unmarked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          preferences: preferencesFor([
            {
              ruleId: "rule-booked",
              name: "Appointment booked",
              category: "booking",
              defaultDestinations: ["bell", "email"],
              enabledDestinations: ["bell", "email"],
            },
            {
              ruleId: "rule-demo",
              name: "Phase 8 demo rule",
              category: "demo",
              defaultDestinations: ["email"],
              enabledDestinations: ["email"],
            },
          ]),
        }),
      ),
    );
    render(<AlertSettings enabled surface="admin-alerts" />);

    const marks = await screen.findAllByText("Test data");
    expect(marks).toHaveLength(1);
    const row = marks[0]!.closest("tr");
    expect(row?.textContent).toContain("Phase 8 demo rule");
    expect(screen.getByText("Appointment booked").closest("tr")?.textContent).not.toContain(
      "Test data",
    );
  });
});
