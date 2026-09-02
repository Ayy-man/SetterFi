import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/coach/contacts",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  CoachContacts,
  deletionImpact,
} from "@/components/workspace/live/coach-contacts";
import type { DeletionPreview } from "@/lib/deletion/contracts";
import type { ContactRead } from "@/lib/repositories/contacts";

function contact(overrides: Partial<ContactRead> = {}): ContactRead {
  return {
    channels: [{ address: "@nadia.builds", channel: "instagram" }],
    credit: "680 to 719",
    goal: "$40,000",
    id: "lead-1",
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-24T09:00:00.000Z",
    name: "Nadia Farouk",
    outcome: null,
    pipelineStage: "new_lead",
    timeline: "This month",
    ...overrides,
  };
}

/**
 * The table's accessible handle. `DataTable` labels the scrolling region rather than the `<table>`
 * element, so a query for a named table finds nothing even when the table is on screen.
 */
function leadsTable() {
  return screen.getByRole("region", { name: "Leads table" });
}

/**
 * Turns the three qualification columns back on. They ship behind Display because 6b's default
 * view is the identity stack, one piece of evidence and the answer; the columns still exist and
 * the export still carries them, so the absence idiom still has to hold in every one.
 */
async function showQualificationColumns(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Display" }));
  for (const column of ["Credit", "Wants", "Timeline"]) {
    await user.click(await screen.findByRole("menuitemcheckbox", { name: column }));
  }
  await user.keyboard("{Escape}");
}

function props(contacts: ContactRead[]) {
  return {
    contacts,
    onContactDeleted: vi.fn(),
    onContactMerged: vi.fn(),
    onContactUnmerged: vi.fn(),
    onSelectedChange: vi.fn(),
    selectedId: null,
  };
}

/** The identity payload the drawer fetches, so a drawer test can assert what it renders. */
function identityResponse(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [],
    contactId: "lead-1",
    identities: [{
      address: "+1 (312) 555 4471",
      channel: "sms",
      channelLabel: "Text messages (SMS)",
      consentState: "opted_in",
      id: "identity-1",
      normalizedEmail: null,
      normalizedPhone: "+13125554471",
    }],
    isDemo: false,
    isTest: false,
    mergeState: { mergedAt: null, mergedIntoContactId: null, status: "active" },
    name: "Nadia Farouk",
    undo: null,
    ...overrides,
  };
}

function stubIdentityFetch(payload: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(
    new Response(JSON.stringify(payload), { status: 200 }),
  )));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CoachContacts table", () => {
  /*
   * A real data table, and no export control of its own.
   *
   * Both leads artboards draw one Download, on the filter row above the card. `LeadsSurface` owns
   * it now and binds it to the same complete filtered rows this table is drawn from, so what this
   * asserts is the absence: a second Download inside the table would be the same action in two
   * places, and the one inside the thing being exported is the one a coach does not look for.
   * `leads-surface.test.tsx` holds the positive half.
   */
  it("keeps the data table, and leaves the export to the surface above it", () => {
    render(<CoachContacts {...props([contact()])} />);
    expect(leadsTable()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export|download/iu })).not.toBeInTheDocument();
  });

  /*
   * The footer `Leads.dc.html` draws: how many of the whole set are on screen, and two worded
   * buttons at the coach's 44px floor. The console's numbered range and chevron pager stayed
   * behind -- "Showing 1-50 of 51 leads" beside "Page 1 of 2" answers a question a coach reading
   * their own leads is not asking, and a 28px chevron is under the target size every other
   * control on this surface is held to.
   */
  it("pages the leads list in the coach's words, at the coach's target size", () => {
    const many = Array.from({ length: 51 }, (_unused, index) => contact({
      id: `lead-${index}`,
      name: `Lead ${index}`,
    }));
    render(<CoachContacts {...props(many)} />);

    const footer = document.querySelector('[data-slot="data-table-pagination"]');
    expect(footer).not.toBeNull();
    expect(footer).toHaveTextContent("Showing 50 of 51 leads");
    expect(footer?.textContent).not.toContain("Page 1 of");

    const back = within(footer as HTMLElement).getByRole("button", { name: "Back" });
    const more = within(footer as HTMLElement).getByRole("button", { name: "More leads" });
    expect(back).toBeDisabled();
    expect(more).toBeEnabled();
    for (const control of [back, more]) expect(control.className).toContain("h-[44px]");
    expect(within(footer as HTMLElement).queryByRole("button", { name: "Next page" })).toBeNull();
  });

  /*
   * A phone number is masked to its last four digits in the list. The table is the surface most
   * likely to be over a shoulder or in a screenshot, and four digits are enough to tell two leads
   * apart; the whole number is still in the drawer a coach opened on purpose.
   */
  /*
   * No address in the list at all now, masked or otherwise.
   *
   * `Leads.dc.html` stacks the funding goal under the name and heads a separate visible column
   * "Where they came from", so the handle-and-channel subline the masking existed for has no
   * cell to live in. The address itself is still on the record sheet, which is where a coach who
   * needs the digits goes, and the search still reads it -- what left the list is a phone number
   * printed on every row of a table a coach scrolls in public.
   */
  it("keeps a lead's contact address off the list entirely", () => {
    const table = (() => {
      render(<CoachContacts {...props([contact({
        channels: [{ address: "+1 (312) 555 4471", channel: "sms" }],
      })])} />);
      return leadsTable();
    })();
    expect(table.textContent).not.toContain("4471");
    expect(table.textContent).not.toContain("555");
    // The channel is a column of its own, in the artboard's words and at its full name.
    expect(within(table).getByText("Where they came from")).toBeInTheDocument();
    expect(within(table).getByText("Text messages (SMS)")).toBeInTheDocument();
  });

  /*
   * An absence is not a state and not a glyph: a cell with nothing in it says what did not happen.
   * `absentValue` throws on "—" and on "0", so this also pins that the cell never renders the
   * literal string "Not captured" as though it were the captured value.
   */
  it("says what was not captured instead of drawing an em dash", async () => {
    const user = userEvent.setup();
    render(<CoachContacts {...props([contact({ credit: null, goal: null, timeline: null })])} />);
    // The three qualification columns ship behind Display now that 6b's default view is the
    // identity stack, its evidence and the answer, so the test turns them on to read their cells.
    await showQualificationColumns(user);
    const table = leadsTable();
    // One per null field on the row, counted rather than sampled: with `getAllByText(...).length
    // > 0` the two other columns covered for a regression in the first one.
    expect(within(table).getAllByText("not captured")).toHaveLength(3);
    expect(table.textContent).not.toContain("—");
  });

  it("names the missing channel rather than leaving the cell blank", () => {
    render(<CoachContacts {...props([contact({ channels: [] })])} />);
    expect(screen.getByText("no channel saved")).toBeInTheDocument();
  });

  /*
   * One status treatment per list. Stage is the axis this table is read along, so it is the only
   * status in a row, and it is `bare` -- a column of tinted lozenges out-weighs the rows it is
   * meant to annotate. A decision chip beside a stage chip put two lozenge columns on one line and
   * neither read as the status.
   */
  it("spends exactly one bare status per row and no pill", () => {
    render(<CoachContacts {...props([contact(), contact({ id: "lead-2", name: "Omar Haddad" })])} />);
    const table = leadsTable();
    const statuses = table.querySelectorAll('[data-slot="status"]');
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status.getAttribute("data-treatment")).toBe("bare");
    }
  });

  /*
   * Never colour alone: the stage dot is decorative and the words carry the state, so the stage
   * label has to be readable text in the row.
   */
  it("carries the stage in words beside its dot", () => {
    render(<CoachContacts {...props([contact({ pipelineStage: "booked" })])} />);
    const status = leadsTable().querySelector('[data-slot="status"]');
    expect(status?.textContent).toContain("Call booked");
    expect(status?.getAttribute("data-tone")).toBe("good");
  });

  /*
   * An unrecognised stage is something a person has to go look at, so it is amber. Folding it into
   * the neutral resting tone would let a broken value sit in the table looking settled.
   */
  it("tones an unrecognised stage as attention, not as settled", () => {
    render(<CoachContacts {...props([contact({ pipelineStage: "not_a_stage" })])} />);
    const status = leadsTable().querySelector('[data-slot="status"]');
    expect(status?.textContent).toContain("Stage needs review");
    expect(status?.getAttribute("data-tone")).toBe("warning");
  });

  /*
   * The product has exactly one glow and it belongs to the attention dot, which is not on this
   * page. A halo on every stage dot down a table is the defect `docs/DESIGN.md` names.
   */
  it("draws no glow anywhere on the page", () => {
    const { container } = render(<CoachContacts {...props([contact({ pipelineStage: "no_show" })])} />);
    // Proves the page drew before the absence below is read as a claim about it. A bare
    // `toHaveLength(0)` on a `querySelectorAll` is equally true of a page with no glow and a page
    // with nothing on it -- confirmed by mutation, where stubbing `CoachContacts` to `return null`
    // left this test green.
    expect(container.querySelectorAll("[data-glow]")).toHaveLength(0);
    expect(screen.getByText("Nadia Farouk")).toBeInTheDocument();
  });

  /* The monogram is labelled with the same name printed beside it: the mark carries no meaning alone. */
  /*
   * The screen the artifact calls "search by anything a lead ever said" cannot do that: no message
   * text reaches this component, and nothing indexes message bodies for search. So the table states
   * the real scope beside the search that produced its rows, and it states it from the same list
   * `filterLeads` reads. A promise here costs a coach a false negative they would read as fact.
   */
  it("states what the search actually reads, and promises no transcript", () => {
    render(<CoachContacts {...props([contact()])} />);
    const scope = screen.getByText(/Search reads/);
    expect(scope).toHaveTextContent("credit range");
    expect(scope).toHaveTextContent("The conversation is not searched");
    expect(document.body.textContent).not.toMatch(/anything (a lead|they) (ever )?said/i);
  });

  /*
   * The inverse of the pin this replaces. 6b draws no monogram, and the reason is the budget: two
   * initials of a name printed beside that same name say nothing, and the width they took is what
   * the quiet treatment spends on the evidence line stacked under the lead.
   */
  it("spends the identity cell on the name and what the lead wants, not on a monogram", () => {
    render(<CoachContacts {...props([contact({ goal: "$50,000" })])} />);
    const identity = leadsTable().querySelector('[data-slot="cell-two-line"]');
    expect(identity).toHaveTextContent("Nadia Farouk");
    expect(identity).toHaveTextContent("Wants $50,000");
    expect(within(leadsTable()).queryByRole("img", { name: "Nadia Farouk" })).toBeNull();
  });

  /*
   * The drift this catches: a port that reaches for the ledger variant to get the card the canvas
   * draws, and silently drops the attention row with it.
   *
   * Two facts, and they used to be one. The table keeps the `quiet` variant, which is the half
   * that was always here -- `quiet` is the only variant `DataTable` applies `rowTone` under, so a
   * switch to `ledger` for the sake of a visible header band would take the tinted "Stage needs
   * review" row away without any test noticing. The second fact is the redesign canvas's: the
   * coach's lead list is drawn inside a card, so the frame is a `.coach-panel` wrapped around the
   * table rather than the `surface-card` face `ledger` gives the table itself. Nesting the ledger
   * face inside the panel would draw two boxes, which is what the `surface-card` assertion below
   * still refuses.
   */
  it("keeps the quiet treatment, inside the coach panel rather than a ledger card face", () => {
    render(<CoachContacts {...props([contact()])} />);
    const table = document.querySelector('[data-slot="data-table"]');
    expect(table).toHaveAttribute("data-variant", "quiet");
    expect(table?.className).not.toContain("surface-card");
    expect(table?.closest(".coach-panel")).not.toBeNull();
  });

  /*
   * The channel is the evidence for the name, so the taller quiet row carries the two stacked in
   * one cell. A column of its own is what the 36px row forced, and it cost the table a column to
   * say something only meaningful beside the name it belongs to.
   */
  /*
   * The four columns `Leads.dc.html` opens on: the name over the goal, where they came from, the
   * stage, and the last message. No selection column -- the artboard draws no checkbox and nothing
   * on this page ever read the selection.
   */
  it("opens on the four columns the artboard draws, with no selection column", () => {
    render(<CoachContacts {...props([contact({ goal: "$50,000" })])} />);
    const table = leadsTable();
    const subline = table.querySelector('[data-slot="cell-two-line-subline"]');
    expect(subline).toHaveTextContent("Wants $50,000");
    for (const header of ["Name", "Where they came from", "Last message", "Stage"]) {
      expect(within(table).getByText(header)).toBeInTheDocument();
    }
    expect(within(table).queryByText("Last activity")).not.toBeInTheDocument();
    expect(within(table).queryByRole("checkbox")).toBeNull();
  });

  /*
   * The whole row opens the lead, and the quiet treatment says so once with a chevron at the end
   * of the row rather than a kebab that only appears under the pointer.
   */
  it("gives every row one chevron standing for the whole row", () => {
    render(<CoachContacts {...props([contact(), contact({ id: "lead-2", name: "Omar Haddad" })])} />);
    expect(
      leadsTable().querySelectorAll('[data-slot="data-table-row-chevron"]'),
    ).toHaveLength(2);
  });

  /*
   * A reader who sees a sorted table assumes the top row is the one that needs them. This list is
   * ordered by last activity and nothing on it stores a reply promise, so the footer states both
   * the order and the claim the order is not making.
   */
  it("states the order under the rows and what that order cannot tell a coach", () => {
    render(<CoachContacts {...props([contact()])} />);
    const footer = document.querySelector('[data-slot="table-footer-note"]');
    expect(
      footer?.querySelector('[data-slot="table-footer-ordering"]'),
    ).toHaveTextContent("most recent activity first");
    expect(
      footer?.querySelector('[data-slot="data-table-footer-note"]'),
    ).toHaveTextContent("not a ranking of who is waiting on the coach");
  });

  /*
   * An empty cell in the quiet treatment goes muted rather than italic: italic reads as emphasis,
   * and a table where half the qualification cells are italic is a table shouting about the leads
   * who answered nothing.
   */
  it("says an uncaptured answer quietly rather than in italic filler", async () => {
    const user = userEvent.setup();
    render(<CoachContacts {...props([contact({ credit: null, goal: null, timeline: null })])} />);
    await showQualificationColumns(user);
    const quiet = leadsTable().querySelectorAll('[data-slot="cell-quiet"]');
    expect(quiet).toHaveLength(3);
    for (const cell of quiet) {
      expect(cell.className).not.toContain("italic");
    }
  });

  /*
   * The timestamp is the figure and stays mono; the age under it is what a coach actually reads
   * the column for, because nobody works out "eight days" from a date at a glance.
   */
  it("puts the age of the last activity under its timestamp", () => {
    render(<CoachContacts {...props([contact({
      lastActivityAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    })])} />);
    expect(within(leadsTable()).getByText("3 days ago")).toBeInTheDocument();
  });

  /* An unreadable stored time has no age, so the cell names the absence instead of printing one. */
  it("names a missing last activity rather than dating it", () => {
    render(<CoachContacts {...props([contact({ lastActivityAt: "not a timestamp" })])} />);
    expect(within(leadsTable()).getByText("no activity recorded")).toBeInTheDocument();
  });
});

describe("CoachContacts drawer", () => {
  /*
   * The stage is the record's own state pill in the drawer header. It used to be half of a muted
   * 12px subtitle while the pill slot above it sat empty, which buried the one fact the drawer is
   * opened to check.
   */
  it("shows the stage as the record's state and the address as the subtitle", async () => {
    stubIdentityFetch(identityResponse());
    render(<CoachContacts {...props([contact()])} selectedId="lead-1" />);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("New lead")).toBeInTheDocument();
    expect(within(sheet).getByText("@nadia.builds · Instagram")).toBeInTheDocument();
  });

  /*
   * The drawer's DETAILS grid prints a real absence in faint italic instead of putting the words
   * "Not captured" in ink where a value goes, which read as a captured value whose content was
   * the words "Not captured".
   */
  it("prints an absence rather than a value that says nothing was captured", async () => {
    stubIdentityFetch(identityResponse());
    render(
      <CoachContacts {...props([contact({ credit: null })])} selectedId="lead-1" />,
    );
    const sheet = await screen.findByRole("dialog");
    // The named row, not any absence on the sheet: the timezone row is also empty in this fixture
    // and was covering for the credit row, so the assertion walks from the key to its own value.
    const key = within(sheet).getByText("Credit", { exact: true });
    const value = key.nextElementSibling;
    expect(value?.textContent).toBe("not captured yet");
    expect(value?.querySelector('[data-slot="record-sheet-absence"]')).not.toBeNull();
  });

  /*
   * Consent decides whether a message is legal to send, so every channel row says it in words
   * beside the whole address. The list shows the last four digits; the drawer the coach opened
   * deliberately shows the number.
   */
  it("states each channel's consent in words beside the full address", async () => {
    stubIdentityFetch(identityResponse());
    render(<CoachContacts {...props([contact()])} selectedId="lead-1" />);
    const row = await screen.findByTestId("contact-channel-row");
    expect(within(row).getByText("+1 (312) 555 4471")).toBeInTheDocument();
    expect(within(row).getByText("opted in")).toBeInTheDocument();
  });

  /*
   * An unrecognised consent value says so rather than falling through to a permissive default. A
   * row that quietly reads as consent when the stored value is not one of the six known states is
   * the honest-states rule failing on the one field where it matters most.
   */
  it("refuses to read an unrecognised consent state as consent", async () => {
    stubIdentityFetch(identityResponse({
      identities: [{
        address: "@nadia.builds",
        channel: "instagram",
        channelLabel: "Instagram",
        consentState: "something_new",
        id: "identity-1",
        normalizedEmail: null,
        normalizedPhone: null,
      }],
    }));
    render(<CoachContacts {...props([contact()])} selectedId="lead-1" />);
    const row = await screen.findByTestId("contact-channel-row");
    expect(within(row).getByText("consent state unrecognised")).toBeInTheDocument();
  });

  /*
   * The opt-out row says which of the two facts it is reporting. "No opt-out recorded" is not the
   * same claim as consent to message, and the two used to share one label.
   */
  it("separates a recorded opt-out from the absence of one", async () => {
    stubIdentityFetch(identityResponse());
    const { rerender } = render(
      <CoachContacts {...props([contact({ optedOut: true })])} selectedId="lead-1" />,
    );
    expect(await within(await screen.findByRole("dialog"))
      .findByText("Yes, this lead opted out")).toBeInTheDocument();

    rerender(<CoachContacts {...props([contact({ optedOut: false })])} selectedId="lead-1" />);
    expect(await within(await screen.findByRole("dialog"))
      .findByText("No opt-out recorded")).toBeInTheDocument();
  });
});

/*
 * The preview endpoint answers 404 with "Not found." when lead deletion is not released, and a
 * coach reading "Deletion preview was refused." cannot tell an unreleased verb from a rejection.
 * These two pin the branch: the 404 names the off-state, everything else keeps the refusal.
 */
describe("the deletion preview off-state", () => {
  function stubPreviewStatus(status: number, body: Record<string, unknown>) {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(url.includes("/deletion-preview")
        ? new Response(JSON.stringify(body), { status })
        : new Response(JSON.stringify(identityResponse()), { status: 200 }));
    }));
  }

  // The record sheet puts its own confirm step in front of the destructive action, so the preview
  // request only leaves after both clicks.
  async function clickPreview() {
    fireEvent.click(await screen.findByRole("button", { name: /^Preview permanent deletion/ }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: /^Confirm preview permanent deletion/ }));
  }

  it("names the unreleased verb on a 404 rather than reporting a refusal", async () => {
    stubPreviewStatus(404, { error: "Not found." });
    render(<CoachContacts {...props([contact()])} selectedId="lead-1" />);
    await clickPreview();

    expect(await screen.findByText(
      "Deleting a lead is not enabled in this environment. Nothing was deleted, and no lead was messaged.",
    )).toBeVisible();
    expect(screen.queryByText("Deletion preview was refused.")).not.toBeInTheDocument();
    expect(screen.queryByText("Not found.")).not.toBeInTheDocument();
  });

  it("still reports a real refusal as a refusal", async () => {
    stubPreviewStatus(403, { error: "Refused." });
    render(<CoachContacts {...props([contact()])} selectedId="lead-1" />);
    await clickPreview();

    expect(await screen.findByText("Deletion preview was refused.")).toBeVisible();
    expect(screen.queryByText(/not enabled in this environment/)).not.toBeInTheDocument();
  });
});

describe("the coach deletion dialog's impact bands", () => {
  const preview = {
    contactId: "lead-1",
    counts: {
      appointments: 1,
      billableEventsDetached: 2,
      contactNotes: 0,
      conversations: 3,
      evalCasesSevered: 4,
      followups: 1,
      identities: 2,
      mergeAuditsRedacted: 5,
      mergedContacts: 1,
      messages: 1204,
      messageTraces: 900,
      unmatchedObjections: 6,
    },
    expiresAt: "2026-08-31T10:00:00.000Z",
    providerEffects: [],
    receipt: { actionKey: "contact.delete.preview", auditId: 9, previewedAt: "2026-08-31T09:00:00.000Z" },
    token: "token",
  } as unknown as DeletionPreview;

  /*
   * A coach confirming an irreversible delete has to be told what does not go. The RPC keeps the
   * billable event and stamps `appointment_detached_at`, and keeps the eval case with every source
   * pointer nulled and `provenance_severed` set, so both survive the delete. Listing only the
   * cascade counts is accurate and half the story, which is the honest-states rule failing exactly
   * where it costs the most.
   */
  it("names what survives beside what it deletes, from the counts the preview carries", () => {
    const [deletes, survives] = deletionImpact(preview, "Nadia Farouk");
    expect(deletes?.title).toBe("What this deletes");
    expect(survives?.title).toBe("What survives, on purpose");

    const survivors = Object.fromEntries(
      (survives?.rows ?? []).map((row) => [row.label, row.value]),
    );
    expect(survivors["Billing already decided"]).toBe(
      "2 kept, detached from the deleted appointment",
    );
    expect(survivors["Test cases built from these messages"]).toBe(
      "4 kept, quarantined with every link back to this lead removed",
    );
    expect(survivors["Merge history in the audit log"]).toBe("5 kept, redacted");
    expect(survives?.note).toMatch(/cannot be undone|none of it can be undone/i);
  });

  it("counts every cascade the preview returned rather than the four it used to show", () => {
    const [deletes] = deletionImpact(preview, "Nadia Farouk");
    const rows = Object.fromEntries((deletes?.rows ?? []).map((row) => [row.label, row.value]));
    expect(rows["Messages"]).toBe("1,204 deleted");
    expect(rows["Records of how the agent answered"]).toBe("900 deleted");
    expect(rows["Objections logged from these messages"]).toBe("6 deleted");
    expect(deletes?.rows.length).toBe(10);
  });
});
