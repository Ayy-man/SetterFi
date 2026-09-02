import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import {
  AdminCompliance,
  type ComplianceContact,
  type LiveSuppressionRow,
  type SuppressionTombstoneRow,
} from "@/components/workspace/live/admin-compliance";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";

const contacts: ComplianceContact[] = [
  {
    id: "contact-1",
    tenantId: "workspace-1",
    tenantName: "Reid Funding Group",
    name: "Priya Raghunathan",
    pipelineStage: "qualifying",
    lastSeenAt: "2026-08-24T10:30:00.000Z",
    isDemo: false,
    isTest: true,
  },
];

const suppressions: LiveSuppressionRow[] = [
  {
    id: "suppression-1",
    tenantName: "Legacy Lane Financial",
    contactName: "Terrence Boyd",
    channel: "sms",
    identifierLast4: "0142",
    source: "stop_keyword",
    reason: null,
    providerSyncState: "confirmed",
    providerSyncedAt: "2026-08-24T09:00:00.000Z",
    createdAt: "2026-08-24T09:00:00.000Z",
    isDemo: true,
    isTest: false,
  },
];

const tombstones: SuppressionTombstoneRow[] = [
  {
    id: "deleted-block-1",
    tenantName: "Elevate Funding Co.",
    channel: "sms",
    identifierLast4: "8821",
    deletionAuditId: 42,
    createdAt: "2026-08-23T16:45:00.000Z",
    isDemo: false,
  },
];

const actions = {
  preview: vi.fn(async () => ({
    ok: false as const,
    error: "The deletion preview could not be loaded.",
  })),
  remove: vi.fn(async () => ({
    ok: false as const,
    error: "The contact could not be deleted.",
  })),
};

const deletionPreview = {
  tenantId: "workspace-1",
  contactId: "contact-1",
  actorId: "admin-1",
  token: "preview-token",
  expiresAt: "2026-08-24T11:30:00.000Z",
  reasonRequired: true as const,
  counts: {
    mergedContacts: 0,
    contactNotes: 0,
    identities: 1,
    conversations: 1,
    messages: 2,
    messageTraces: 1,
    followups: 0,
    appointments: 0,
    unmatchedObjections: 0,
    mergeAuditsRedacted: 0,
    billableEventsDetached: 0,
    evalCasesSevered: 0,
  },
  providerEffects: [],
  receipt: {
    actionKey: "contact.delete.preview" as const,
    auditId: 41,
    previewedAt: "2026-08-24T10:30:00.000Z",
  },
};

function renderCompliance() {
  return render(
    <AdminCompliance
      actions={actions}
      initialContacts={contacts}
      suppressions={suppressions}
      tombstones={tombstones}
    />,
  );
}

function renderAllSeeded() {
  return render(
    <AdminCompliance
      actions={actions}
      initialContacts={contacts.map((row) => ({ ...row, isDemo: true }))}
      suppressions={suppressions.map((row) => ({ ...row, isDemo: true }))}
      tombstones={tombstones.map((row) => ({ ...row, isDemo: true }))}
    />,
  );
}

async function gotoTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("tab", { name }));
}

async function openDeleteMenu(user: ReturnType<typeof userEvent.setup>) {
  await gotoTab(user, "Contacts");
  await user.click(
    screen.getByRole("button", { name: "Actions for Priya Raghunathan" }),
  );
  return await screen.findByRole("menu");
}

describe("AdminCompliance", () => {
  /**
   * A live block and the tombstone that outlives its contact are the same promise at two ages, so
   * they share one table under two band headings rather than sitting behind separate tabs. What
   * has to survive the merge is that the deleted-contact record is still visibly a *deletion* --
   * it has no contact to name, and the band says the block survived it.
   */
  it("renders blocks and deletion records as two bands of one table", async () => {
    const user = userEvent.setup();
    renderCompliance();

    const records = screen.getByRole("region", {
      name: "Contact blocks and deletion records",
    });
    expect(within(records).getByText("Current blocks")).toBeInTheDocument();
    expect(within(records).getByText("Deleted contacts")).toBeInTheDocument();
    // The claim the label used to carry in parentheses now rides the band's annotation, which is
    // where a standing fact about every row under a heading belongs.
    expect(
      within(records).getByText(
        "the contact record is gone, the block it left behind is not",
      ),
    ).toBeInTheDocument();
    expect(within(records).getByText("Terrence Boyd")).toBeInTheDocument();
    expect(within(records).getByText("Contact deleted")).toBeInTheDocument();
    expect(within(records).getByText("Elevate Funding Co.")).toBeInTheDocument();

    await gotoTab(user, "Contacts");
    expect(
      within(
        screen.getByRole("region", { name: "Contacts available for deletion" }),
      ).getByText("Priya Raghunathan"),
    ).toBeInTheDocument();
  });

  /** Every block states its cause. A block nobody can account for is one nobody can defend. */
  it("states why each block exists, from the source the row actually stores", async () => {
    renderCompliance();

    expect(
      screen.getByText("Replied STOP. Nothing sends to them again"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Permanent deletion, recorded as audit #42/),
    ).toBeInTheDocument();
  });

  it("says the whole page is seeded once every row is, rather than going silent", async () => {
    // CLAUDE.md requires test data to be labelled on screen. When every row across all three
    // tables is seeded the per-row chips stop distinguishing anything and are dropped, so this
    // single line is the ONLY thing making the claim. Nothing per-row can catch its removal --
    // which is exactly how a fully seeded page ends up saying nothing at all.
    renderAllSeeded();
    expect(
      screen.getByText(
        "Every row on this page is demo or test data, excluded from real analytics",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Demo, test data")).not.toBeInTheDocument();
  });

  /**
   * Seeded rows must say so on screen. The marker moved from StateBadge to the kit's Status, so
   * this asserts the rule -- the label is a real, worded status rather than loose muted text --
   * rather than the component that used to carry it. A test row that does not announce itself is
   * the test-data segregation rule broken, which is why this is worth a test at all.
   */
  it("labels a seeded row on screen, as a status rather than as quiet text", async () => {
    const user = userEvent.setup();
    renderCompliance();

    const demo = screen.getByText("Demo data").closest('[data-slot="status"]');
    expect(demo, "a seeded row must wear a real status").not.toBeNull();
    expect(demo?.querySelector('[data-slot="status-label"]')?.textContent).toContain("Demo");

    await gotoTab(user, "Contacts");
    expect(
      screen.getByText("Test data").closest('[data-slot="status"]'),
      "a test row must wear a real status",
    ).not.toBeNull();
  });

  it("exposes CSV and JSON export controls for every table", async () => {
    const user = userEvent.setup();
    renderCompliance();

    for (const tab of ["Blocks and deletion records", "Contacts"]) {
      await gotoTab(user, tab);
      await user.click(screen.getByRole("button", { name: "Export table" }));
      const menu = await screen.findByRole("menu");
      expect(
        within(menu).getByRole("menuitem", { name: /Download CSV/ }),
      ).toBeInTheDocument();
      expect(
        within(menu).getByRole("menuitem", { name: /Download JSON/ }),
      ).toBeInTheDocument();
      await user.keyboard("{Escape}");
    }
  });

  it("offers deletion from the row menu with registry-owned microcopy", async () => {
    const user = userEvent.setup();
    renderCompliance();

    const menu = await openDeleteMenu(user);
    expect(
      within(menu).getByRole("menuitem", { name: /Delete contact/i }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByText(AUDIT_ACTIONS["contact.delete"].microcopy),
    ).toBeInTheDocument();
  });

  it("renders an incomplete deletion as a partial outcome without claiming nothing changed", async () => {
    const user = userEvent.setup();
    const retryReceipt = {
      version: 1 as const,
      tenantId: "workspace-1",
      contactId: "contact-1",
      idempotencyDigest: "saved-digest",
      providerDeleteReceipts: [
        {
          providerOperationId: "provider-operation-1",
          acceptedAt: "2026-08-24T10:35:00.000Z",
        },
      ],
      providerEvidence: null,
    };
    const remove = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          kind: "incomplete" as const,
          stage: "local_delete" as const,
          reason: "local_delete_failed",
          retry: retryReceipt,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          kind: "deleted" as const,
          auditId: 42,
          providerEvidence: { kind: "not_applicable" as const },
          tombstoneCount: 1,
          replayed: true,
        },
      });
    render(
      <AdminCompliance
        actions={{
          preview: vi.fn(async () => ({
            ok: true as const,
            value: deletionPreview,
          })),
          remove,
        }}
        initialContacts={contacts}
        suppressions={suppressions}
        tombstones={tombstones}
      />,
    );

    const menu = await openDeleteMenu(user);
    await user.click(
      await within(menu).findByRole("menuitem", { name: /Delete contact/i }),
    );
    await user.type(
      await screen.findByLabelText("Privacy-request reason"),
      "Verified privacy request",
    );
    // A recorded reason is not the same as a deliberate one: the deletion is irreversible, so the
    // confirm stays disabled until the word is typed.
    expect(screen.getByRole("button", { name: /Delete permanently/i })).toBeDisabled();
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(
      screen.getByRole("button", { name: /Delete permanently/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Some steps completed before it stopped. The record shows what ran.",
    );
    expect(screen.queryByText(/Nothing changed/)).not.toBeInTheDocument();

    // The shared flow keeps its confirm control so the retry reuses the saved receipt.
    const firstIdempotencyKey = remove.mock.calls[0][0].idempotencyKey;
    const retry = await screen.findByRole(
      "button",
      { name: /Delete permanently/i },
      { timeout: 8000 },
    );
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[1][0]).toMatchObject({
      idempotencyKey: firstIdempotencyKey,
      retry: retryReceipt,
    });
    expect(await screen.findByText(/Audit receipt #42/)).toBeInTheDocument();
  });
});

describe("AdminCompliance page shape", () => {
  it("counts each registry on its own tab and leaves an empty one uncounted", () => {
    render(
      <AdminCompliance
        actions={actions}
        initialContacts={[]}
        suppressions={suppressions}
        tombstones={[]}
      />,
    );

    expect(
      screen.getByRole("tab", { name: "Blocks and deletion records" }),
    ).toHaveTextContent("1");
    // A zero count would read as a broken number; the empty tab says so in its own body instead.
    expect(screen.getByRole("tab", { name: "Contacts" }).textContent).toBe(
      "Contacts",
    );
  });

  /**
   * The deletion history goes back further than the 200 rows this page holds, so the full export
   * stays server-side and is named for what it is. Two controls both called "Export table" would
   * be the same as neither of them being named.
   */
  it("keeps a named server export for the whole deletion history", () => {
    renderCompliance();

    expect(
      screen.getByRole("button", { name: "Export every deletion record" }),
    ).toBeInTheDocument();
  });

  it("states the read-only constraint as a callout, with tone on the dot and no edge stripe", () => {
    render(
      <AdminCompliance
        actions={actions}
        impersonation={{ sessionId: "session-9", tenantId: "workspace-1" }}
        initialContacts={contacts}
        suppressions={suppressions}
        tombstones={tombstones}
      />,
    );

    const callout = screen
      .getByRole("status")
      .querySelector('[data-slot="callout"]');
    expect(callout).not.toBeNull();
    expect(callout).toHaveAttribute("data-tone", "warning");
    expect(callout?.querySelector('[data-slot="callout-dot"]')).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Read-only workspace view",
    );
  });

  it("names a missing provider confirmation instead of showing an empty row", async () => {
    const user = userEvent.setup();
    render(
      <AdminCompliance
        actions={actions}
        initialContacts={contacts}
        suppressions={[
          {
            ...suppressions[0],
            providerSyncState: "pending",
            providerSyncedAt: null,
          },
        ]}
        tombstones={tombstones}
      />,
    );

    await user.click(screen.getByRole("cell", { name: /Terrence Boyd/ }));

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("not confirmed yet")).toBeInTheDocument();
  });

it("puts both compliance tables on the ledger treatment", async () => {
    const user = userEvent.setup();
    const { container } = renderCompliance();

    expect(
      container.querySelector('[data-slot="data-table"]'),
    ).toHaveAttribute("data-variant", "ledger");
    expect(
      container.querySelector('[data-slot="data-table-footer-note"]')
        ?.textContent,
    ).toContain("two hundred most recently recorded");

    await gotoTab(user, "Contacts");
    expect(
      container.querySelector('[data-slot="data-table"]'),
    ).toHaveAttribute("data-variant", "ledger");
  });
  /**
   * The message-rules panel, and the two rows that are deliberately not on it.
   *
   * A compliance page is the one surface where a described control that does not exist is worse
   * than no page: somebody reads it, believes the platform is checking, and stops checking
   * themselves. So every rule here had to be a check in `src/lib/sends/send-to-lead.ts` or a
   * module it calls. The canvas draws two more -- sender identification, and prohibited content
   * categories -- and neither is enforced by the send path: identification is enforced nowhere,
   * and what the agent may claim is checked in the engine before a draft ever becomes a message.
   * They are absent, and the panel says the list is the send path's rather than a carrier's.
   */
  it("describes only rules the send path enforces, and names what it leaves out", async () => {
    const user = userEvent.setup();
    renderCompliance();

    await gotoTab(user, "Message rules");

    expect(screen.getByText("Stop means stop, on every channel")).toBeVisible();
    expect(screen.getByText("No consent basis, no message")).toBeVisible();
    expect(screen.getByText("Quiet hours defer, they do not drop")).toBeVisible();
    expect(
      screen.getByText("Carrier control replies are published copy, not defaults"),
    ).toBeVisible();

    // The two the code does not back. A row for either one is a claim about behaviour that would
    // have to be built before it could be printed.
    expect(screen.queryByText(/^Identification/)).toBeNull();
    expect(screen.queryByText(/prohibited categor/i)).toBeNull();
    expect(
      screen.getByText(/sender identification is not enforced here/),
    ).toBeVisible();

    // No counts on the rows. `send_refusals` is not read by this page, and "0 blocked this month"
    // arriving from nowhere is the invented figure the panel exists to avoid.
    const panel = screen.getByText("Stop means stop, on every channel").closest(
      '[data-slot="setting-group"]',
    );
    expect(panel?.textContent).not.toMatch(/\bthis month\b|\bblocked so far\b/);
  });

  /**
   * A number in UI copy, pinned to the array it describes.
   *
   * The stop row says fifteen keywords and eleven intent phrasings. Both come from
   * `src/lib/suppression/keywords.ts`, neither is exported, and a keyword added there would leave
   * the sentence quietly wrong on a compliance surface -- the exact drift the token-contrast file
   * has already been caught by twice for the same reason.
   */
  it("keeps the stop-keyword counts equal to the list the classifier actually matches", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/suppression/keywords.ts"),
      "utf8",
    );
    const block = (name: string) => {
      const start = source.indexOf(`const ${name} = [`);
      expect(start).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("] as const;", start));
    };

    expect(block("STOP_KEYWORDS").split('",').length - 1).toBe(15);
    expect(block("STOP_INTENTS").split('",').length - 1).toBe(11);
  });
});
