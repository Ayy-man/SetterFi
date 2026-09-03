import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminMoneyCorrections,
  CorrectionQueue,
} from "@/components/workspace/live/admin-money-corrections";
import type { CorrectionEvidence } from "@/components/workspace/live/view-models";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// The shared UI setup installs these observer stubs once with vi.stubGlobal, so
// unstubbing per test would strip them for every later test in this file.
class ObserverStub {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("IntersectionObserver", ObserverStub);
  vi.stubGlobal("ResizeObserver", ObserverStub);
});

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

const correction: CorrectionEvidence = {
  requestId: "8e4b0c42-59f7-4d63-91ef-2ef5638c3350",
  tenantId: "2ab32433-5fe0-4cd9-9813-7d9c9ea1f36d",
  businessName: "Northstar Capital Coaching (demo)",
  billableEventId: "0df6d7fc-5389-45a0-aac1-914309f44aad",
  quantityDelta: -2,
  reason: "Two test appointments were included in the booked call count.",
  requestedAt: "2026-08-24T09:30:00.000Z",
  requestAuditId: 42,
  decision: null,
  decisionId: null,
  decisionAuditId: null,
  offsetEventId: null,
};

const decided: CorrectionEvidence = {
  ...correction,
  requestId: "b1d0f6a2-4d1e-4f8c-90a7-2b1c6f0e9c11",
  businessName: "Clearpath Credit (demo)",
  quantityDelta: 1,
  decision: "approved",
  decisionId: "4711ad8c-d458-42b7-b272-dabdb3667170",
  decisionReason: "The device-overlap flag corroborates the test claim.",
  decisionAuditId: 73,
  offsetEventId: "56f28a48-6fbe-4b3b-98f7-9aa6e6313306",
};

describe("AdminMoneyCorrections", () => {
  it("renders the correction strip without page chrome when embedded", () => {
    render(
      <CorrectionQueue
        actorRole="admin"
        chrome="embedded"
        initialCorrections={[correction]}
      />,
    );

    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Coach disputes against billable call evidence, and the receipt-backed decision.")).toBeNull();
    expect(screen.getByLabelText("Open correction summary")).toBeInTheDocument();
  });

  it("keeps the correction page heading by default", () => {
    render(<CorrectionQueue actorRole="admin" initialCorrections={[correction]} />);

    expect(screen.getByRole("heading", { level: 1, name: "Corrections" })).toBeInTheDocument();
  });

  it("never renders a UUID-shaped select option label", () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[correction]}
      />,
    );

    const optionLabels = [
      ...screen.queryAllByRole("option"),
      ...Array.from(document.querySelectorAll("option")),
    ].map((option) => option.textContent ?? "");

    expect(optionLabels).toHaveLength(0);
    expect(optionLabels.some((label) => UUID_PATTERN.test(label))).toBe(false);
    // The coach is the identity of a dispute, so the row opens under the coach's name.
    expect(
      screen.getByRole("button", { name: "Northstar Capital Coaching (demo)" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Decrease by 2 booked calls")).toBeInTheDocument();
  });

  it("shows the open request count in the page summary", () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[correction]}
      />,
    );

    const summary = within(screen.getByLabelText("Open correction summary"));
    // A tile is a deck panel since the console port: the label is the panel's heading and the
    // figure is in the panel body, so the element that holds both is the panel's `<section>`.
    expect(
      summary.getByText("Open requests").closest("section"),
    ).toHaveTextContent("1");
    expect(
      summary.getByText("Coaches waiting").closest("section"),
    ).toHaveTextContent("1");
    // "Increases requested 0" spent a third of the strip saying nothing; it is gone.
    expect(summary.queryByText("Increases requested")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Corrections" }),
    ).toBeVisible();
  });

  it("shows the request receipt as neutral logged microcopy, not a green verdict", () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[correction]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Northstar Capital Coaching (demo)" }),
    );

    const pill = document.querySelector('[data-slot="logged-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.className).not.toContain("good");
    expect(
      document.querySelector('[data-slot="state-badge"][data-tone="good"]'),
    ).toBeNull();
  });

  // The flow crosses two portalled overlays, so allow for full-suite worker contention.
  it("records an approval only after the mock driver returns a matching receipt", async () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        result: {
          state: "approved",
          requestId: correction.requestId,
          decisionId: "4711ad8c-d458-42b7-b272-dabdb3667170",
          offsetEventId: "56f28a48-6fbe-4b3b-98f7-9aa6e6313306",
          requestAuditId: correction.requestAuditId,
          decisionAuditId: 73,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[correction]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Northstar Capital Coaching (demo)" }),
    );
    // Scoped to the record sheet: the disputed figure is now a visible table column too, so an
    // unscoped query matches the row and the sheet and stops proving the sheet carries it.
    const record = screen.getByRole("dialog");
    expect(within(record).getByText("Disputed figure")).toBeInTheDocument();
    expect(within(record).getByText("2 booked calls removed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Approve/ }));
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "The event evidence confirms the duplicate count." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /^Approve correction/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Correction approval logged."),
      ).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/billing",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("offers the same decision from the row kebab as from the record sheet", async () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[correction]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Actions for Northstar Capital Coaching (demo)",
      }),
    );

    expect(
      await screen.findByRole("menuitem", { name: /^Approve/ }),
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /^Reject/ })).toBeVisible();
  });

  it("keeps decided requests on the page, banded and closed to a second decision", () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[correction, decided]}
      />,
    );

    // The queue used to drop a request the moment it was decided, which left "what did we decide,
    // and when" answerable only from the audit log. Both bands are on the page now.
    const bands = [
      ...document.querySelectorAll('[data-slot="data-table-group-row"]'),
    ].map((band) => band.getAttribute("data-group-id"));
    expect(bands).toEqual(["Needs decision", "Approved"]);

    // The open request still offers its decision; the decided one is evidence, not work.
    expect(
      screen.getByRole("button", {
        name: "Actions for Northstar Capital Coaching (demo)",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "Actions for Clearpath Credit (demo)",
      }),
    ).toBeNull();

    const summary = within(screen.getByLabelText("Open correction summary"));
    expect(
      summary.getByText("Open requests").closest("section"),
    ).toHaveTextContent("1");
    expect(summary.getByText("Decided").closest("section")).toHaveTextContent("1");
  });

  it("carries the decision receipts into the decided request's record", () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[decided]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Clearpath Credit (demo)" }),
    );
    const panel = within(screen.getByRole("dialog"));
    expect(panel.getByText("Decision ID").parentElement).toHaveTextContent(
      "4711ad8c-d458-42b7-b272-dabdb3667170",
    );
    expect(
      panel.getByText("Decision audit receipt").parentElement,
    ).toHaveTextContent("73");
    // A settled request offers no second decision from the sheet either.
    expect(panel.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  /**
   * `billing_correction_decisions.reason` is `not null` with a non-blank check, and it was stored
   * from the first decision this product ever took -- but `projectCorrections` never selected it,
   * so the queue could show that a request was approved and not one word about why. The words are
   * the whole point of a dispute decision.
   */
  it("reads back the deciding admin's own words, not just the verdict", () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[decided]}
      />,
    );

    expect(
      screen.getByText("Approved: The device-overlap flag corroborates the test claim."),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Clearpath Credit (demo)" }),
    );
    const panel = within(screen.getByRole("dialog"));
    expect(panel.getByText("Approved, and why")).toBeInTheDocument();
    expect(
      panel.getByText("The device-overlap flag corroborates the test claim."),
    ).toBeInTheDocument();
  });

  /**
   * Screen 4d labels the decision reason "goes to the coach verbatim". `coach_billing_projection`
   * returns correction candidates only and no coach surface reads the decision, so the field must
   * not promise delivery. This guard is the promise staying unmade.
   */
  it("does not claim the decision reason reaches the coach", async () => {
    render(
      <AdminMoneyCorrections
        actorRole="admin"
        enabled
        initialCorrections={[correction]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Northstar Capital Coaching (demo)" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Approve/ }));

    const hint = await screen.findByText(/No coach-facing screen shows it yet/);
    expect(hint).toBeInTheDocument();
    expect(screen.queryByText(/verbatim/i)).toBeNull();
  });

  it("gives a success reviewer a read-only queue with no decision control", () => {
    render(
      <AdminMoneyCorrections
        actorRole="success"
        enabled
        initialCorrections={[correction]}
      />,
    );

    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });
});

/**
 * The correction queue's provenance, on the surface where the labelling rule costs money.
 *
 * "Test data is segregated and labelled as such on-screen" has no carve-out, and this was the one
 * Money surface that could not keep it: every sibling passes `testRow` off a `dataLabel`, and the
 * correction row carried no such field. What makes it the expensive one is what the screen does --
 * approving a correction credits a coach's bill, so an unlabelled seeded dispute is a row an admin
 * approves against a claim nobody made. The demo tenant files these requests, so the queue is
 * genuinely mixed rather than seeded-in-theory.
 *
 * Three places can drop the label independently and each is pinned below, because fixing one and
 * leaving another produces a screen that looks compliant and a file that is not:
 *
 *   1. the projection, which has to read `is_demo` off the `tenants` embed it already joined;
 *   2. the table, which has to mark the row;
 *   3. both export arms -- the server `columns` request and the locally-built success CSV.
 *
 * The export half is not the lesser half. A CSV without the marker turns a seeded dispute into an
 * indistinguishable real one the moment it leaves the product, and the file outlives the session
 * that would have explained it.
 */
describe("correction queue provenance", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/components/workspace/live/admin-money-corrections.tsx"),
    "utf8",
  );

  it("marks a seeded dispute per row rather than claiming the whole page", () => {
    expect(source).toContain("testRow={(row) => (row.dataLabel ?? null) !== null}");
    expect(source).toContain("testRowLabel={seededRowLabel(");
    /*
     * The queue is mixed, so a page-level claim is wrong in the other direction: it would tell a
     * reader that the real billing disputes beside the seeded ones are seeded too. This asserts
     * the shape the ruling chose, not merely that some provenance exists.
     */
    expect(source).not.toContain("provenanceKind=");
    expect(source).not.toContain("wholePageProvenanceKind");
  });

  it("carries the label out through both export arms", () => {
    // The server arm: this list becomes the export's `columns` parameter, and the resource has
    // supported `dataLabel` all along -- asking for a narrower set is what dropped it.
    // Anchored relative to the declaration: `CRUMBS` above it also ends in `] as const;`, so an
    // absolute `indexOf` for the terminator slices backwards and silently measures nothing.
    const declared = source.slice(source.indexOf("const EXPORT_COLUMNS"));
    const columns = declared.slice(0, declared.indexOf("] as const;"));
    expect(columns).toContain('"dataLabel"');

    // The success arm is built in the browser from the row, so it carries the label only if this
    // mapping does.
    const local = source.slice(source.indexOf("function localExportRows"));
    expect(local.slice(0, local.indexOf("\n}"))).toContain("dataLabel: row.dataLabel ?? null");
  });

  /**
   * The projection, read out of the repository. The field is worthless if the query never selects
   * the column, and this is the assertion that would have failed for the four audit rounds that
   * filed this as blocked on a join that was already there.
   */
  it("reads is_demo off the tenants embed the projection already joined", () => {
    const billing = readFileSync(resolve(process.cwd(), "src/lib/repositories/billing.ts"), "utf8");
    const select = billing.slice(billing.indexOf("billing_correction_requests"));

    expect(select.slice(0, select.indexOf("\n"))).toBeTruthy();
    expect(billing).toContain("tenants(name,is_demo)");
    expect(billing).toContain("dataLabel: correctionSeedLabel(request.tenants)");
    // Absent rather than false when the tenant row cannot be read: an unlabelled row reads as
    // real, so a failure to tell must not assert the dispute is genuine.
    expect(billing).toContain('is_demo === true ? "Demo" : null');
  });

  /**
   * The success narrowing drops decisions and economics on purpose. It must not drop provenance --
   * a seeded dispute misleads a reviewer exactly as much as it misleads an admin, and this is the
   * arm whose CSV is assembled from these very fields.
   */
  it("keeps the label through the success projection's narrowing", () => {
    const viewModels = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/view-models.ts"),
      "utf8",
    );
    const narrowed = viewModels.slice(viewModels.indexOf("export function deriveSuccessCorrectionQueue"));
    expect(narrowed.slice(0, narrowed.indexOf("\n}"))).toContain("dataLabel: row.dataLabel ?? null");
  });
});
