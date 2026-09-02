import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KitInput } from "@/components/kit/atomics/field";
import { Field, type FieldProps } from "@/components/kit/field";

/*
 * The drift this file catches: `Field` is a "use client" component that three *server* components
 * render into -- src/app/login/page.tsx (two fields), src/app/access/page.tsx and
 * src/app/auth/reset-password/page.tsx. Children handed across that boundary do not arrive as
 * React elements; they arrive as an unresolved Flight node the renderer unwraps further down, so
 * `isValidElement(children)` is false and `children.props` is `undefined`. `Field` used to cast
 * children to an element and read `.props.id` off it, which threw
 * `TypeError: Cannot read properties of undefined (reading 'id')` on every server render of
 * /login. React caught it, switched that page to client rendering, and still returned 200 -- so
 * the defect cost /login its SSR without ever surfacing as a failure anybody would notice.
 *
 * A jsdom test cannot reproduce that: rendering `<Field><KitInput /></Field>` from a test file
 * always produces a real element and always takes the cloning path. The boundary case is
 * reproduced here by handing `Field` a resolved React lazy node, which is the shape a
 * Flight-serialised child has by the time a client component sees it -- opaque to
 * `isValidElement`, resolved by the renderer on the way down. Every assertion reads rendered
 * markup rather than source text, because what broke was what the renderer did, not what the file
 * said.
 */

/** The shape a Flight-serialised child presents to a client component: an already-resolved lazy. */
function asBoundaryChild(node: ReactNode): ReactNode {
  const payload = { _result: node, _status: 1 };
  return {
    $$typeof: Symbol.for("react.lazy"),
    _init: (value: typeof payload) => value._result,
    _payload: payload,
  } as unknown as ReactNode;
}

function render(props: FieldProps) {
  return renderToStaticMarkup(createElement(Field, props));
}

function attr(tag: string | undefined, name: string): string | undefined {
  return tag?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function labelTag(html: string) {
  return html.match(/<label\b[^>]*>/)?.[0];
}

function inputTag(html: string) {
  return html.match(/<input\b[^>]*>/)?.[0];
}

let errors: unknown[][] = [];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Field wires the label and the messages to its control", () => {
  it("labels an ordinary in-client child and points the hint at it", () => {
    const html = render({
      children: createElement(KitInput, { name: "plan" }),
      hint: "Use the public plan name",
      label: "Plan name",
      required: true,
    });

    const id = attr(inputTag(html), "id");
    expect(id).toBeTruthy();
    expect(attr(labelTag(html), "for")).toBe(id);
    expect(attr(inputTag(html), "aria-describedby")).toBe(`${id}-hint`);
    expect(attr(inputTag(html), "aria-invalid")).toBe("false");
    expect(attr(inputTag(html), "aria-required")).toBe("true");
    expect(html).toContain(`id="${id}-hint"`);
    expect(errors).toEqual([]);
  });

  it("uses the id the caller pinned, and points the error at that id", () => {
    const html = render({
      children: createElement(KitInput, { id: "plan-name", name: "plan" }),
      error: "Enter a plan name",
      hint: "Use the public plan name",
      htmlFor: "plan-name",
      label: "Plan name",
    });

    expect(attr(inputTag(html), "id")).toBe("plan-name");
    expect(attr(labelTag(html), "for")).toBe("plan-name");
    // Once both are on screen the error, not the hint, is what the control announces.
    expect(attr(inputTag(html), "aria-describedby")).toBe("plan-name-error");
    expect(attr(inputTag(html), "aria-invalid")).toBe("true");
    expect(errors).toEqual([]);
  });

  it("shouts when a child declares an id the field is about to overwrite", () => {
    render({ children: createElement(KitInput, { id: "plan-name" }), label: "Plan name" });

    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain('htmlFor="plan-name"');
  });
});

describe("Field survives a child that crossed the RSC boundary (login, access, reset-password)", () => {
  it("does not throw on a child it cannot recognise as an element", () => {
    // The regression itself. Before the fix this threw
    // `Cannot read properties of undefined (reading 'id')` out of Field.
    expect(() =>
      render({
        children: asBoundaryChild(createElement(KitInput, { name: "email", type: "email" })),
        label: "Email",
        required: true,
      }),
    ).not.toThrow();
  });

  it("still labels the control, through the context rather than through cloning", () => {
    const html = render({
      children: asBoundaryChild(createElement(KitInput, { name: "email", type: "email" })),
      hint: "We send the sign-in link here",
      label: "Email",
      required: true,
    });

    const id = attr(inputTag(html), "id");
    expect(id).toBeTruthy();
    expect(attr(labelTag(html), "for")).toBe(id);
    expect(attr(inputTag(html), "aria-describedby")).toBe(`${id}-hint`);
    expect(attr(inputTag(html), "aria-required")).toBe("true");
    expect(errors).toEqual([]);
  });

  it("honours a pinned id across the boundary too", () => {
    const html = render({
      children: asBoundaryChild(createElement(KitInput, { name: "password", type: "password" })),
      error: "That password is wrong",
      htmlFor: "password",
      label: "Password",
    });

    expect(attr(inputTag(html), "id")).toBe("password");
    expect(attr(labelTag(html), "for")).toBe("password");
    expect(attr(inputTag(html), "aria-describedby")).toBe("password-error");
    expect(attr(inputTag(html), "aria-invalid")).toBe("true");
  });

  it("is loud, not silent, when nothing downstream can claim the wiring", () => {
    // A control neither cloning nor the context can reach leaves the label pointing at an id that
    // is on no element at all. That is invisible on screen, so it has to be audible in dev.
    const html = render({ children: asBoundaryChild("just some text"), label: "Email" });

    expect(html).toContain("just some text");
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("no control claimed it");
  });
});
