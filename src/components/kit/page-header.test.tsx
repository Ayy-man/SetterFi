import { fireEvent, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Component, Fragment, useState, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

import { PageHeader } from "@/components/kit/page-header";
import { Button } from "@/components/ui/button";

const CRUMBS = [
  { label: "Platform", href: "/admin" },
  { label: "Overview" },
] as const;

const DESCRIPTION = "What needs a person today.";

function renderInShell(header: ReactNode) {
  return render(<main data-shell-root>{header}</main>);
}

function tokenBackedStyle(element: Element, property: string, token: string) {
  const computedValue = getComputedStyle(element).getPropertyValue(property);
  expect(computedValue).toContain(`var(${token})`);
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function ActionGroup({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

class ActionValidationBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null };

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  render() {
    return this.state.message ? (
      <p role="alert">{this.state.message}</p>
    ) : (
      this.props.children
    );
  }
}

function MutatingActionGroup({ mutation }: { mutation: "add" | "reorder" }) {
  const [mutated, setMutated] = useState(false);
  const trigger = (
    <Button
      key="trigger"
      variant="outline"
      onClick={() => setMutated(true)}
    >
      Change actions
    </Button>
  );
  const primary = <Button key="primary">Save</Button>;

  if (!mutated) {
    return (
      <>
        {trigger}
        {primary}
      </>
    );
  }

  return mutation === "add" ? (
    <>
      {trigger}
      {primary}
      <Button key="added-primary">Publish</Button>
    </>
  ) : (
    <>
      {primary}
      {trigger}
    </>
  );
}

describe("PageHeader", () => {
  let style: HTMLStyleElement;

  beforeAll(async () => {
    const tokensPath = path.resolve(process.cwd(), "src/app/tokens.css");
    const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");
    const [tokens, globals] = await Promise.all([
      readFile(tokensPath, "utf8"),
      readFile(globalsPath, "utf8"),
    ]);
    const generated = await postcss([tailwindcss()]).process(globals, {
      from: globalsPath,
    });
    let titleStyles = "";
    generated.root.walkRules((rule) => {
      if (rule.selector === ".text-title") titleStyles = rule.toString();
    });
    if (!titleStyles) throw new Error("Tailwind did not generate the text-title utility.");

    style = document.createElement("style");
    style.textContent = `${tokens}\n${titleStyles}`;
    document.head.append(style);
  });

  afterAll(() => style?.remove());

  it("renders the title at the page-title token's 20px and 600 weight", () => {
    renderInShell(
      <PageHeader
        title="Overview"
        description="What needs a person today."
        crumbs={CRUMBS}
      />,
    );

    const title = screen.getByRole("heading", { level: 1, name: "Overview" });
    expect(title).toHaveClass("t-page-title");
    expect(tokenBackedStyle(title, "font-size", "--t-page-title")).toBe("20px");
    expect(tokenBackedStyle(title, "font-weight", "--t-page-title-w")).toBe("600");
  });

  it("always renders the required description under the title, in muted", () => {
    renderInShell(
      <PageHeader
        title="Overview"
        description="What needs a person today."
        crumbs={CRUMBS}
      />,
    );

    const description = document.querySelector<HTMLElement>(
      '[data-slot="page-header-description"]',
    );
    expect(description).not.toBeNull();
    if (!description) throw new Error("Expected the PageHeader description slot.");
    expect(description).toHaveTextContent("What needs a person today.");
    expect(description.className).toContain("var(--muted)");

    const title = screen.getByRole("heading", { level: 1, name: "Overview" });
    expect(
      title.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("throws when two instances mount inside one shell", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(() =>
        renderInShell(
          <Fragment>
            <PageHeader title="Overview" crumbs={CRUMBS} description={DESCRIPTION} />
            <PageHeader title="System" crumbs={CRUMBS} description={DESCRIPTION} />
          </Fragment>,
        ),
      ).toThrow();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("allows at most one primary action and requires it to be last", () => {
    renderInShell(
      <PageHeader
        title="Overview"
        crumbs={CRUMBS}
        description={DESCRIPTION}
        actions={
          <>
            <Button variant="outline">Export</Button>
            <Button>Add client</Button>
          </>
        }
      />,
    );

    const actions = document.querySelector('[data-slot="page-header-actions"]');
    expect(actions).not.toBeNull();
    if (!actions) throw new Error("Expected the PageHeader actions slot.");
    const primaryActions = actions.querySelectorAll(".bg-primary");
    expect(primaryActions).toHaveLength(1);
    expect(actions.lastElementChild).toBe(primaryActions[0]);
  });

  it("validates primary actions after component wrappers render", () => {
    expect(() =>
      renderInShell(
        <PageHeader
          title="Overview"
          crumbs={CRUMBS}
          description={DESCRIPTION}
          actions={
            <>
              <ActionGroup>
                <Button>Add client</Button>
              </ActionGroup>
              <ActionGroup>
                <Button variant="outline">Export</Button>
              </ActionGroup>
            </>
          }
        />,
      ),
    ).toThrow("The primary PageHeader action must be last.");
  });

  it.each([
    ["adds a second primary action", "add", "PageHeader accepts at most one primary action."],
    [
      "moves the primary action away from last",
      "reorder",
      "The primary PageHeader action must be last.",
    ],
  ] as const)("observes when a stateful descendant %s", async (_label, mutation, message) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      renderInShell(
        <ActionValidationBoundary>
          <PageHeader
            title="Overview"
            crumbs={CRUMBS}
            description={DESCRIPTION}
            actions={<MutatingActionGroup mutation={mutation} />}
          />
        </ActionValidationBoundary>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Change actions" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("enforces action validation in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    try {
      expect(() =>
        renderInShell(
          <PageHeader
            title="Overview"
            crumbs={CRUMBS}
            description={DESCRIPTION}
            actions={
              <ActionGroup>
                <Button>First</Button>
                <Button>Second</Button>
              </ActionGroup>
            }
          />,
        ),
      ).toThrow("PageHeader accepts at most one primary action.");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows a header outside a shell", () => {
    expect(() => render(<PageHeader title="Overview" crumbs={CRUMBS} description={DESCRIPTION} />)).not.toThrow();
  });

  it("rejects a second primary action", () => {
    expect(() =>
      renderInShell(
        <PageHeader
          title="Overview"
          crumbs={CRUMBS}
          description={DESCRIPTION}
          actions={
            <>
              <Button>First</Button>
              <Button>Second</Button>
            </>
          }
        />,
      ),
    ).toThrow("PageHeader accepts at most one primary action.");
  });

  it("rejects a primary action that is not last", () => {
    expect(() =>
      renderInShell(
        <PageHeader
          title="Overview"
          crumbs={CRUMBS}
          description={DESCRIPTION}
          actions={
            <>
              <Button>Add client</Button>
              <Button variant="outline">Export</Button>
            </>
          }
        />,
      ),
    ).toThrow("The primary PageHeader action must be last.");
  });
});
