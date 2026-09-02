import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { RecordSheet } from "@/components/kit/record-sheet";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function assertNoUuidInSections(container: HTMLElement) {
  const sectionMarkup = container.querySelector('[data-slot="record-sheet-sections"]')?.innerHTML ?? "";
  if (UUID_PATTERN.test(sectionMarkup)) {
    throw new Error("Raw UUID found outside Technical detail");
  }
}

describe("RecordSheet", () => {
  it("renders the destructive action after the primary action", () => {
    render(
      <RecordSheet
        destructive={{ label: "Delete contact" }}
        onOpenChange={() => undefined}
        open
        primaryAction={{ label: "Open conversation" }}
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );

    const primary = screen.getByRole("button", { name: "Open conversation" });
    const destructive = screen.getByRole("button", { name: "Delete contact" });

    expect(primary.compareDocumentPosition(destructive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps technical values inside a closed details disclosure", () => {
    render(
      <RecordSheet
        onOpenChange={() => undefined}
        open
        sections={[{ title: "Summary", body: "A lead summary" }]}
        technical={[{ label: "Record ID", value: "d9428888-122b-11e1-b85c-61cd3cbb3210" }]}
        title="Jordan Lee"
      />,
    );

    const summary = screen.getByText("Technical detail");
    const details = summary.closest("details");

    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(details).toContainElement(screen.getByText("d9428888-122b-11e1-b85c-61cd3cbb3210"));
  });

  it("documents that a UUID in section markup fails the disclosure rule", () => {
    render(
      <RecordSheet
        onOpenChange={() => undefined}
        open
        sections={[
          {
            title: "Summary",
            body: "Record d9428888-122b-11e1-b85c-61cd3cbb3210",
          },
        ]}
        title="Jordan Lee"
      />,
    );

    expect(() => assertNoUuidInSections(document.body)).toThrow("Raw UUID found outside Technical detail");
  });

  it("requires confirmation before running a destructive action", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(
      <RecordSheet
        destructive={{ label: "Delete contact", onClick: onDelete }}
        onOpenChange={() => undefined}
        open
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete contact" }));
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm delete contact" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("disables actions that have no target", () => {
    render(
      <RecordSheet
        destructive={{ label: "Delete contact" }}
        onOpenChange={() => undefined}
        open
        primaryAction={{ label: "Open conversation" }}
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );

    expect(screen.getByRole("button", { name: "Open conversation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete contact" })).toBeDisabled();
  });

  it("preserves callbacks on link actions", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDelete = vi.fn();

    render(
      <RecordSheet
        destructive={{ href: "#delete", label: "Delete contact", onClick: onDelete }}
        onOpenChange={() => undefined}
        open
        primaryAction={{ href: "#conversation", label: "Open conversation", onClick: onOpen }}
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(onOpen).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Delete contact" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete contact" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("renders the full-record link beside identity content before Close", () => {
    render(
      <RecordSheet
        fullRecordHref="#record"
        onOpenChange={() => undefined}
        open
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );

    const identity = document.querySelector('[data-slot="record-sheet-identity"]');
    const link = screen.getByRole("link", { name: "Open full record" });
    const close = screen.getByRole("button", { name: "Close" });

    expect(link.parentElement).toBe(identity?.parentElement);
    expect(identity?.nextElementSibling).toBe(link);
    expect(link.nextElementSibling).toBe(close);
  });

  it("cycles through the summary but skips controls in closed details", async () => {
    const user = userEvent.setup();

    render(
      <RecordSheet
        onOpenChange={() => undefined}
        open
        sections={[{ title: "Summary", body: "A lead summary" }]}
        technical={[{ label: "Record ID", value: "d9428888-122b-11e1-b85c-61cd3cbb3210" }]}
        title="Jordan Lee"
      />,
    );

    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    const close = screen.getByRole("button", { name: "Close" });
    const summary = screen.getByText("Technical detail");
    const copy = screen.getByRole("button", { name: "Copy Record ID", hidden: true });

    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(summary).toHaveFocus();
    expect(copy).not.toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it("keeps focus in place when the open callback changes", async () => {
    const firstOnOpenChange = vi.fn();
    const view = render(
      <RecordSheet
        onOpenChange={firstOnOpenChange}
        open
        primaryAction={{ label: "Open conversation", onClick: () => undefined }}
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );

    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const primary = screen.getByRole("button", { name: "Open conversation" });
    primary.focus();

    view.rerender(
      <RecordSheet
        onOpenChange={() => undefined}
        open
        primaryAction={{ label: "Open conversation", onClick: () => undefined }}
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(primary).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();

    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Open lead
          </button>
          <RecordSheet
            destructive={{ label: "Delete contact", onClick: () => undefined }}
            onOpenChange={setOpen}
            open={open}
            primaryAction={{ label: "Open conversation", onClick: () => undefined }}
            sections={[{ title: "Summary", body: "A lead summary" }]}
            title="Jordan Lee"
          />
        </>
      );
    }

    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Open lead" });
    await user.click(trigger);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    const close = screen.getByRole("button", { name: "Close" });
    const destructive = screen.getByRole("button", { name: "Delete contact" });

    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(destructive).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
  it("lines every group's values up on one fixed key column", () => {
    render(
      <RecordSheet
        onOpenChange={() => undefined}
        open
        sections={[
          {
            title: "Identity",
            aside: "2 of 3",
            fields: [
              { label: "Owner", value: "Alec Delpuech" },
              { label: "Registration", value: "Submitted" },
            ],
          },
        ]}
        title="Jordan Lee"
      />,
    );

    const grid = document.querySelector<HTMLElement>('[data-slot="record-sheet-fields"]');

    expect(grid).toBeInTheDocument();
    expect(grid?.style.getPropertyValue("--rs-key-w")).toBe("104px");
    expect(grid?.style.gridTemplateColumns).toBe("var(--rs-key-w) minmax(0, 1fr)");
    expect(document.querySelectorAll('[data-slot="record-sheet-key"]')).toHaveLength(2);
    expect(screen.getByText("2 of 3")).toHaveAttribute("data-slot", "record-sheet-aside");
  });

  it("copies a mono value and says in words when one is missing", () => {
    render(
      <RecordSheet
        onOpenChange={() => undefined}
        open
        sections={[
          {
            title: "Channels",
            fields: [
              { label: "SMS number", value: "+1 512 555 0134", mono: true },
              { label: "Instagram", absence: "not connected" },
            ],
          },
        ]}
        title="Jordan Lee"
      />,
    );

    expect(screen.getByRole("button", { name: "Copy SMS number" })).toBeInTheDocument();

    const absence = screen.getByText("not connected");
    expect(absence).toHaveAttribute("data-slot", "record-sheet-absence");
    expect(absence.className).toContain("italic");
  });

  it("prints who created the record and who last changed it", () => {
    render(
      <RecordSheet
        created={{ when: "12 Aug", who: "alec@livelegacystrong.com" }}
        lastChange={{ when: "28 Aug", who: "success@setterfi.com" }}
        onOpenChange={() => undefined}
        open
        sections={[{ title: "Summary", body: "A lead summary" }]}
        title="Jordan Lee"
      />,
    );

    const audit = document.querySelector<HTMLElement>('[data-slot="record-sheet-audit"]');

    expect(audit).toHaveTextContent("created 12 Aug \u00b7 alec@livelegacystrong.com");
    expect(audit).toHaveTextContent("last change 28 Aug \u00b7 success@setterfi.com");

    const created = audit!.querySelector('[data-slot="record-sheet-created"]');
    const lastChange = audit!.querySelector('[data-slot="record-sheet-last-change"]');
    expect(created!.compareDocumentPosition(lastChange!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the lead state first in the header pill row", () => {
    render(
      <RecordSheet
        onOpenChange={() => undefined}
        open
        sections={[{ title: "Summary", body: "A lead summary" }]}
        state={{ label: "Live", tone: "good" }}
        states={[
          { label: "SMS", tone: "warning" },
          { label: "Test data", tone: "neutral" },
        ]}
        title="Jordan Lee"
      />,
    );

    const row = document.querySelector<HTMLElement>('[data-slot="record-sheet-state"]');

    expect(row).toHaveTextContent("Live");
    expect(row).toHaveTextContent("SMS");
    expect(row).toHaveTextContent("Test data");
    expect(row?.textContent?.indexOf("Live")).toBe(0);
  });
});
