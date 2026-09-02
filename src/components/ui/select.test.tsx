import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

describe("Select", () => {
  it("mounts its options when opened outside the agent shell", async () => {
    // Base UI's FloatingPortal treats an explicit null container as "wait for a container",
    // so a null default keeps the popup from ever mounting (regression from W3-DELETE-CSS).
    render(
      <Select
        label="Choose client"
        options={[
          { label: "Harbor Credit", value: "a" },
          { label: "Summit Funding", value: "b" },
        ]}
        placeholder="Choose a client"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Choose client" }));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Harbor Credit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Summit Funding" })).toBeInTheDocument();
  });
});

/**
 * The composed API -- a trigger, a value and hand-written items -- against the value it is bound to.
 *
 * Base UI resolves a trigger's text from the root's `items` prop, not from the `<Select.Item>`s in
 * the tree, and falls through to `String(value)` when it cannot. Every composed call site in this
 * codebase passed no `items`, so six of them printed a stored key at a reader: a success owner's
 * UUID in the admin client drawer, a billable-event UUID under "Which booked call" to a coach,
 * `provider_asserted`, `tenant_specific`, `one_time`.
 *
 * These render the primitive rather than any one of those screens on purpose. The fix is in this
 * component, so this is where a regression would happen, and a per-screen snapshot would have said
 * nothing about the seventh call site. `select.test.ts` carries the other half -- that no surface
 * reaches the Base UI primitive directly and so nothing can opt out of what is asserted here.
 */
describe("the composed Select's trigger", () => {
  const ASSIGNEE = "88000000-0000-4000-8000-000000000001";

  function renderTrigger(value: string | null, options: readonly { value: string; label: string }[]) {
    return render(
      <Select onValueChange={() => {}} value={value}>
        <SelectTrigger aria-label="Assignee">
          <SelectValue placeholder="Choose a named success owner" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );
  }

  it("names the selected item instead of printing the id it is bound to", () => {
    renderTrigger(ASSIGNEE, [{ value: ASSIGNEE, label: "Dana Whitfield" }]);

    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    expect(trigger).toHaveTextContent("Dana Whitfield");
    expect(
      trigger.textContent ?? "",
      "the trigger printed the stored value; a reader is being shown a key",
    ).not.toContain(ASSIGNEE);
  });

  it("resolves an enum key to the sentence written beside it", () => {
    renderTrigger("provider_asserted", [
      { value: "provider_asserted", label: "The connected service confirmed it" },
      { value: "lead_asserted", label: "The lead confirmed it" },
    ]);

    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    expect(trigger).toHaveTextContent("The connected service confirmed it");
    expect(trigger.textContent ?? "").not.toContain("provider_asserted");
  });

  it("asks again rather than printing a value nothing in the list explains", () => {
    // The options arriving after the value does, or a stored id whose row has gone. Base UI's own
    // fallback here is String(value), which is the defect wearing a different cause.
    renderTrigger(ASSIGNEE, [{ value: "someone-else", label: "Marcus Reid" }]);

    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    expect(trigger).toHaveTextContent("Choose a named success owner");
    expect(trigger.textContent ?? "").not.toContain(ASSIGNEE);
  });

  it("shows the placeholder for an empty selection, including the empty string", () => {
    renderTrigger("", [{ value: ASSIGNEE, label: "Dana Whitfield" }]);
    expect(screen.getByRole("combobox", { name: "Assignee" }))
      .toHaveTextContent("Choose a named success owner");
  });

  it("still opens to the items it resolved the label from", async () => {
    // The positive control for the three above: a trigger that says "Dana Whitfield" while the
    // list it came from is empty would be resolving against something other than the options.
    renderTrigger(ASSIGNEE, [{ value: ASSIGNEE, label: "Dana Whitfield" }]);

    fireEvent.click(screen.getByRole("combobox", { name: "Assignee" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Dana Whitfield" })).toBeInTheDocument();
    });
  });
});
