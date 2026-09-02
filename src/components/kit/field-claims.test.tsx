/**
 * The duplicate-id audit counts controls, and a control is not the same thing as a render.
 *
 * `Field`'s dev-time audit exists for a real hazard: on the context path -- the branch taken when
 * children cross an RSC boundary and cannot be cloned -- every control under the field is handed
 * the same id, so a second one would put a duplicate id on the page and break the label
 * association silently. That warning is worth having.
 *
 * What it was doing instead was firing on `/login`, whose served HTML has exactly one
 * `id="login-email"` and one `id="login-password"`. The audit tallied *calls* to `claim()` against
 * an object rebuilt per parent render, and in dev StrictMode React invokes a child twice inside a
 * single parent pass, so one control claiming once counted as two. The comment said it counted
 * what claimed "in this pass", and "this pass" was standing in for "this mount".
 *
 * A warning that cries wolf on the most-visited screen in the product is worse than no warning,
 * because it teaches people to stop reading the console -- which is where the real ones appear.
 *
 * So both halves are pinned here. The first test fails on the old tally, which is what makes it a
 * regression test rather than a description. The second renders two genuinely different controls
 * on one id and requires the warning to still fire, because the failure mode of this fix is an
 * audit that has gone quiet, and an audit with nothing to say looks exactly like an audit that
 * cannot speak.
 */

import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Field, useFieldControl } from "@/components/kit/field";

function ClaimingInput({ label }: { label?: string }) {
  const field = useFieldControl();
  return <input data-testid={label ?? "control"} {...field} />;
}

/**
 * Children that are not a single React element, which is what forces `Field` onto the context
 * path. `isValidElement` is false for an array, the same way it is false for the Flight node a
 * server component hands down -- and the context path is the only one the audit runs on.
 */
function contextChildren(...nodes: React.ReactNode[]) {
  return nodes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Field's duplicate-id audit", () => {
  it("stays quiet for one control, even though StrictMode invokes it twice", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <StrictMode>
        <Field label="Email">{contextChildren(<ClaimingInput key="one" />)}</Field>
      </StrictMode>,
    );

    // One control on the page, so the audit has nothing to report. Under the old tally this is two
    // claims and a duplicate-id warning about a document with no duplicate.
    expect(screen.getAllByTestId("control")).toHaveLength(1);
    const duplicateWarnings = consoleError.mock.calls.filter(([first]) =>
      typeof first === "string" && first.includes("controls claimed"),
    );
    expect(duplicateWarnings, `audit warned about a single control: ${JSON.stringify(duplicateWarnings)}`).toEqual([]);
  });

  it("still reports two different controls sharing one id", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <StrictMode>
        <Field htmlFor="shared-id" label="Email">
          {contextChildren(<ClaimingInput key="a" label="a" />, <ClaimingInput key="b" label="b" />)}
        </Field>
      </StrictMode>,
    );

    // Both really are on the page and both really carry the field's id, which is the defect: the
    // label points at one of them and the other is an unlabelled control with a colliding id.
    expect(screen.getByTestId("a")).toHaveAttribute("id", "shared-id");
    expect(screen.getByTestId("b")).toHaveAttribute("id", "shared-id");

    const duplicateWarnings = consoleError.mock.calls.filter(([first]) =>
      typeof first === "string" && first.includes("controls claimed"),
    );
    expect(duplicateWarnings.length, "the audit went quiet on a real duplicate").toBeGreaterThan(0);
    // The number in the message is the thing that was wrong before, so it is asserted rather than
    // left to the substring: two controls, reported as two.
    expect(String(duplicateWarnings[0][0])).toContain('2 controls claimed id="shared-id"');
  });

  it("still reports children that never wired themselves up", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <StrictMode>
        <Field label="Email">{contextChildren(<input key="bare" data-testid="bare" />)}</Field>
      </StrictMode>,
    );

    // The other arm of the same audit, kept honest by the same reasoning: this control ignored the
    // context, so the label points at an id that is on no element at all.
    expect(screen.getByTestId("bare")).not.toHaveAttribute("id");
    const unwiredWarnings = consoleError.mock.calls.filter(([first]) =>
      typeof first === "string" && first.includes("no control claimed it"),
    );
    expect(unwiredWarnings.length, "the audit stopped reporting an unwired control").toBeGreaterThan(0);
  });
});
