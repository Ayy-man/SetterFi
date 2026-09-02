import { Check } from "@/components/kit/icons";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StateBadge, type StateTone } from "./state-badge";

describe("StateBadge", () => {
  /*
    A washed pill is two tokens, and the contrast suite can only see one of them. It checks what a
    token's *value* is -- `--good` is a 3.06 dot, `--good-text` is 5.13 on canvas and 4.55 on its
    own wash -- and nothing checked which of the two a component reached for. `good` reached for
    the dot and painted label text with it on twenty-one screens, sitting inside a tone map whose
    four siblings all took their `-text` variant, so it read as a convention until you looked.

    So this asks about the role rather than the value: whatever a pill paints its text with must be
    a text token. `--body` and its neighbours qualify -- they are text roles. A bare state token
    does not, because that hue exists to be a 3px dot. The set is collected by rendering every tone
    of both pill kinds, and asserted non-empty first: every for-loop below passes vacuously over an
    empty match set.
  */
  const PILL_KINDS = ["lifecycle", "verdict"] as const;
  const PILL_TONES = ["neutral", "good", "warning", "critical", "info"] as const;
  const TEXT_ROLES = /^--(?:.+-text|body|ink|muted|faint)$/;

  it("paints pill text with a text role and never with a dot token", () => {
    const painted: { kind: string; tone: string; token: string }[] = [];

    for (const kind of PILL_KINDS) {
      for (const tone of PILL_TONES) {
        const { container, unmount } = render(
          <StateBadge kind={kind} label={`${tone} ${kind}`} tone={tone} />,
        );
        const pill = container.querySelector<HTMLElement>('[data-slot="state-badge"]');
        expect(pill, `${kind}/${tone} rendered no pill`).not.toBeNull();
        const wash = /bg-\[var\((--[\w-]+)\)\]/.exec(pill!.className);
        const text = /text-\[color:var\((--[\w-]+)\)\]/.exec(pill!.className);
        expect(wash, `${kind}/${tone} carries no wash`).not.toBeNull();
        expect(text, `${kind}/${tone} carries no text token`).not.toBeNull();
        painted.push({ kind, token: text![1], tone });
        unmount();
      }
    }

    expect(painted.length, "no washed pills were scanned").toBe(PILL_KINDS.length * PILL_TONES.length);
    const dotPainted = painted.filter(({ token }) => !TEXT_ROLES.test(token));
    expect(
      dotPainted.map(({ kind, token, tone }) => `${kind}/${tone} -> ${token}`),
      "a pill paints its text with a dot token",
    ).toEqual([]);
  });

  it.each(
    (["lifecycle", "verdict", "tag"] as const).flatMap((kind) =>
      (["good", "warning", "critical", "info"] as const).map((tone) => ({ kind, tone })),
    ),
  )(
    "renders an svg alongside a $tone $kind label",
    ({ kind, tone }: { kind: "lifecycle" | "verdict" | "tag"; tone: StateTone }) => {
      const { container } = render(
        <StateBadge kind={kind} label={`${tone} ${kind} state`} tone={tone} />,
      );

      expect(screen.getByText(`${tone} ${kind} state`)).toBeInTheDocument();
      expect(container.querySelector("svg")).toBeInTheDocument();
    },
  );

  it("renders a supplied icon and detail copy", () => {
    const { container } = render(
      <StateBadge
        detail="day 9 of a typical 14 to 21"
        icon={Check}
        kind="lifecycle"
        label="Awaiting carrier"
        tone="warning"
      />,
    );

    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByText("Awaiting carrier")).toBeInTheDocument();
    expect(screen.getByText("day 9 of a typical 14 to 21")).toBeInTheDocument();
  });

  it("keeps tags transparent with a hairline border", () => {
    render(<StateBadge kind="tag" label="Text messages (SMS)" tone="info" />);

    expect(screen.getByText("Text messages (SMS)").closest("[data-slot='state-badge']"))
      .toHaveClass(
        "state-badge--tag",
        "bg-transparent",
        "border",
        "border-[var(--line)]",
      );
  });

  it("gives verdicts a low-chroma tinted background", () => {
    render(<StateBadge kind="verdict" label="Ready to book" tone="good" />);

    expect(screen.getByText("Ready to book").closest("[data-slot='state-badge']"))
      .toHaveClass("state-badge--verdict", "bg-[var(--good-wash)]");
  });

  it("renders lifecycle states as a washed pill, never a bare dot", () => {
    render(<StateBadge kind="lifecycle" label="Live" tone="good" />);

    const badge = screen.getByText("Live").closest("[data-slot='state-badge']");
    expect(badge).toHaveClass(
      "state-badge--lifecycle",
      "bg-[var(--good-wash)]",
      "text-[color:var(--good-text)]",
    );
    expect(badge).not.toHaveClass("border");
    expect(badge).toHaveTextContent("Live");
  });

  it("drops the dot on request and shrinks to the small size", () => {
    const { container } = render(
      <StateBadge dot={false} label="Unassigned" size="sm" tone="neutral" />,
    );

    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Unassigned").closest("[data-slot='state-badge']")).toHaveClass(
      "text-[length:var(--t-badge)]",
    );
  });

  it("renders an absence as quiet text, with no pill and no dot", () => {
    const { container } = render(
      <StateBadge kind="none" label="No scheduled change" tone="neutral" />,
    );

    const badge = screen.getByText("No scheduled change");
    expect(badge).toHaveAttribute("data-kind", "none");
    expect(badge.className).not.toContain("bg-[var(");
    expect(container.querySelector("svg")).toBeNull();
  });
});
