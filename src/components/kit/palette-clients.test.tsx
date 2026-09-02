import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  PaletteClientProvider,
  RegisterPaletteClients,
  usePaletteClientSearch,
  type PaletteClientEntry,
} from "@/components/kit/palette-clients";

const CLIENTS: PaletteClientEntry[] = [
  {
    id: "reid",
    label: "Reid Funding Group (demo)",
    href: "/admin/platform-clients",
    keywords: ["active", "Growth"],
  },
  {
    id: "northstar",
    label: "Northstar Capital (demo)",
    href: "/admin/platform-clients",
    keywords: ["overdue", "Starter"],
  },
];

/** Prints what the palette would be handed, so a test can read the source's answer directly. */
function Probe({ query }: { query: string }) {
  const search = usePaletteClientSearch();
  if (!search) return <p>no source</p>;
  return (
    <p>
      {search(query)
        .map((client) => client.label)
        .join(" | ")}
    </p>
  );
}

describe("palette client registry", () => {
  it("offers no source at all until a page registers one", () => {
    render(
      <PaletteClientProvider>
        <Probe query="" />
      </PaletteClientProvider>,
    );

    // Undefined rather than an empty search function, because that is what makes the palette
    // drop its Clients group entirely instead of rendering an empty heading.
    expect(screen.getByText("no source")).toBeInTheDocument();
  });

  it("matches on the label and on the keywords a page rides along", async () => {
    render(
      <PaletteClientProvider>
        <RegisterPaletteClients clients={CLIENTS} sourceKey="client-book" />
        <Probe query="overdue" />
      </PaletteClientProvider>,
    );

    // "overdue" is nobody's name -- it is the status the client book rode along, which is the
    // point: an operator hunting the overdue account should not have to remember whose it is.
    expect(
      await screen.findByText("Northstar Capital (demo)"),
    ).toBeInTheDocument();
  });

  it("shows what is there before anything is typed", async () => {
    render(
      <PaletteClientProvider>
        <RegisterPaletteClients clients={CLIENTS} sourceKey="client-book" />
        <Probe query="" />
      </PaletteClientProvider>,
    );

    expect(
      await screen.findByText(
        "Reid Funding Group (demo) | Northstar Capital (demo)",
      ),
    ).toBeInTheDocument();
  });

  it("stops offering a page's clients once that page unmounts", async () => {
    const { rerender } = render(
      <PaletteClientProvider>
        <RegisterPaletteClients clients={CLIENTS} sourceKey="client-book" />
        <Probe query="reid" />
      </PaletteClientProvider>,
    );
    expect(
      await screen.findByText("Reid Funding Group (demo)"),
    ).toBeInTheDocument();

    // Navigating away from the client book takes its rows with it. The palette must not keep
    // offering a list nothing on screen is holding any more.
    rerender(
      <PaletteClientProvider>
        <Probe query="reid" />
      </PaletteClientProvider>,
    );

    expect(await screen.findByText("no source")).toBeInTheDocument();
  });

  it("offers a client once when two panels register the same row", async () => {
    render(
      <PaletteClientProvider>
        <RegisterPaletteClients clients={CLIENTS} sourceKey="client-book" />
        <RegisterPaletteClients clients={[CLIENTS[0]!]} sourceKey="attention" />
        <Probe query="reid" />
      </PaletteClientProvider>,
    );

    expect(
      await screen.findByText("Reid Funding Group (demo)"),
    ).toBeInTheDocument();
  });
});
