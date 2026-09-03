import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportMenu } from "@/components/kit/export-menu";

/**
 * A server export used to be a plain `<a download>` pointed at the route, so whatever came back
 * was written to disk under the export's own filename -- including the `{"error":"Not found."}`
 * body the route returns when the resource's flag is off in this environment. These tests hold
 * the menu to only saving a file once the response says it is one, and to saying so plainly when
 * it is not.
 */

type SavedFile = { filename: string; blob: Blob };

/** `Blob.text()` swallows a leading BOM, and the BOM is part of what the export writes. */
async function savedBytes(file: SavedFile) {
  return Array.from(new Uint8Array(await file.blob.arrayBuffer()));
}

function expectedBytes(contents: string) {
  return Array.from(new TextEncoder().encode(contents));
}

const saved: SavedFile[] = [];
let createdBlob: Blob | null = null;

beforeEach(() => {
  saved.length = 0;
  createdBlob = null;

  vi.spyOn(URL, "createObjectURL").mockImplementation((source) => {
    createdBlob = source as Blob;
    return "blob:export-menu-test";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function capture(this: HTMLAnchorElement) {
      saved.push({
        filename: this.getAttribute("download") ?? "",
        blob: createdBlob as Blob,
      });
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
    async () => response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAuditExport() {
  return render(
    <ExportMenu
      filename="setterfi-audit-log"
      mode="server"
      query={{ order: "at_desc", reason: "Quarterly access review" }}
      resource="audit-log"
    />,
  );
}

async function requestCsv(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Export table" }));
  await user.click(await screen.findByRole("menuitem", { name: /Download CSV/ }));
}

describe("ExportMenu server downloads", () => {
  it("saves nothing and says exports are off when the route answers 404", async () => {
    const user = userEvent.setup();
    stubFetch(
      new Response(JSON.stringify({ error: "Not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderAuditExport();

    await requestCsv(user);

    expect(
      await screen.findByText(
        "Exports are not enabled in this environment. No file was saved.",
      ),
    ).toBeVisible();
    expect(saved).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("saves the response body under the export filename when the route answers with a file", async () => {
    const user = userEvent.setup();
    const csv = '﻿"action","at"\r\n"contact.delete","2026-08-31"';
    const fetchMock = stubFetch(
      new Response(csv, {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      }),
    );
    renderAuditExport();

    await requestCsv(user);

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].filename).toBe("setterfi-audit-log.csv");
    expect(await savedBytes(saved[0])).toEqual(expectedBytes(csv));
    expect(
      screen.queryByText(/No file was saved\./),
    ).not.toBeInTheDocument();

    const requested = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(requested.pathname).toBe("/api/exports/audit-log");
    expect(requested.searchParams.get("format")).toBe("csv");
    expect(requested.searchParams.get("reason")).toBe("Quarterly access review");
  });

  it("saves nothing when a 200 carries something other than the format it asked for", async () => {
    const user = userEvent.setup();
    stubFetch(
      new Response("<!doctype html><title>Sign in</title>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    renderAuditExport();

    await requestCsv(user);

    expect(
      await screen.findByText("The export did not complete. No file was saved."),
    ).toBeVisible();
    expect(saved).toHaveLength(0);
  });

  it("saves nothing and stays plain when the request never reaches the route", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    renderAuditExport();

    await requestCsv(user);

    expect(
      await screen.findByText("The export did not complete. No file was saved."),
    ).toBeVisible();
    expect(saved).toHaveLength(0);
  });

  it("still writes local rows without asking the route for anything", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(new Response("", { status: 200 }));
    render(<ExportMenu filename="people" mode="local" rows={[{ name: "Priya" }]} />);

    await requestCsv(user);

    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].filename).toBe("people.csv");
    expect(await savedBytes(saved[0])).toEqual(
      expectedBytes('﻿"name"\r\n"Priya"'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * A menu can carry a second export. These hold the two apart: each group has its own items, the
 * reason typed for a platform export does not travel with the rows-on-screen export beside it,
 * and a refusal is attributed to the source that was asked for.
 */
describe("ExportMenu with a second source", () => {
  function renderTwoSources() {
    return render(
      <ExportMenu
        also={{
          filename: "setterfi-suppression-tombstones",
          groupLabel: "Every deletion record",
          mode: "server",
          query: { order: "created_desc", reason: "" },
          resource: "suppression-tombstones",
        }}
        filename="setterfi-contact-blocks"
        groupLabel="Blocks on screen"
        label="Export"
        mode="local"
        rows={[{ contact: "Priya" }]}
      />,
    );
  }

  it("names both exports under one trigger", async () => {
    const user = userEvent.setup();
    renderTwoSources();

    expect(screen.queryByRole("button", { name: "Export table" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(await screen.findByRole("menuitem", { name: /Download CSV, Blocks on screen/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Download JSON, Blocks on screen/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Download CSV, Every deletion record/ }))
      .toBeInTheDocument();
    expect(screen.getByText("Blocks on screen")).toBeInTheDocument();
  });

  it("keeps the reason on the source that requires one, and exports the other without it", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(new Response("", { status: 200 }));
    renderTwoSources();
    await user.click(screen.getByRole("button", { name: "Export" }));

    // The deletion export is refused until its reason is given; the rows export never asks.
    expect(await screen.findByRole("menuitem", { name: /Download CSV, Every deletion record/ }))
      .toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: /Download CSV, Blocks on screen/ }))
      .not.toHaveAttribute("data-disabled");

    await user.click(screen.getByRole("menuitem", { name: /Download CSV, Blocks on screen/ }));
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].filename).toBe("setterfi-contact-blocks.csv");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.type(
      await screen.findByLabelText("Every deletion record: export reason"),
      "Quarterly access review",
    );
    await user.click(screen.getByRole("menuitem", { name: /Download CSV, Every deletion record/ }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requested = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(requested.pathname).toBe("/api/exports/suppression-tombstones");
    expect(requested.searchParams.get("reason")).toBe("Quarterly access review");
  });

  it("puts a refusal back under the export that was refused", async () => {
    const user = userEvent.setup();
    stubFetch(
      new Response(JSON.stringify({ error: "Not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderTwoSources();

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.type(
      await screen.findByLabelText("Every deletion record: export reason"),
      "Quarterly access review",
    );
    await user.click(screen.getByRole("menuitem", { name: /Download CSV, Every deletion record/ }));

    const message = await screen.findByText(
      "Exports are not enabled in this environment. No file was saved.",
    );
    expect(message).toBeVisible();
    expect(saved).toHaveLength(0);
    // The rows export beside it is untouched and still offered.
    expect(screen.getByRole("menuitem", { name: /Download CSV, Blocks on screen/ }))
      .not.toHaveAttribute("data-disabled");
  });
});
