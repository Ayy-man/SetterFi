import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminAccountTerms } from "@/components/workspace/live/admin-account-terms";

const CONTENT_HASH = "a".repeat(64);

const draft = {
  versionKey: "2026-10-terms-v1",
  contentHash: CONTENT_HASH,
  createdAt: "2026-10-01T00:00:00.000Z",
  publishedAt: null,
};

const published = {
  versionKey: "2026-09-terms-v1",
  contentHash: "b".repeat(64),
  createdAt: "2026-09-01T00:00:00.000Z",
  publishedAt: "2026-09-02T00:00:00.000Z",
};

function stubFetch(response: Response) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the account terms publisher surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The empty registry is a real state with a consequence, not a blank panel. Saying only "no
   * versions" would leave an admin to guess whether signup is quietly collecting an agreement
   * against something.
   */
  it("says what an empty registry means for signup", () => {
    render(<AdminAccountTerms acceptanceLive={false} drafts={[]} published={null} />);

    expect(screen.getByText(
      "No terms are published. Signup records no acceptance until a version is published.",
    )).toBeVisible();
  });

  it("names the published version, its hash, and the day it went in", () => {
    render(<AdminAccountTerms acceptanceLive drafts={[]} published={published} />);

    expect(screen.getByRole("heading", { name: "2026-09-terms-v1" })).toBeVisible();
    expect(screen.getByText("Published")).toBeVisible();
    expect(screen.getByText(published.contentHash)).toBeVisible();
    expect(screen.getByText(/Signup asks every new coach to accept this version/u)).toBeVisible();
  });

  /**
   * The flag and the registry are two separate facts, and the screen has to keep them apart: a
   * published version with the flag off collects nothing, and an admin reading "Published" alone
   * would reasonably assume otherwise.
   */
  it("separates a published version from an armed signup", () => {
    render(<AdminAccountTerms acceptanceLive={false} drafts={[]} published={published} />);

    expect(screen.getByText(/SETTERFI_ACCOUNT_TERMS_LIVE is off/u)).toBeVisible();
  });

  it("offers no publish control once a version is published, and says why", () => {
    render(<AdminAccountTerms acceptanceLive drafts={[draft]} published={published} />);

    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByText(
      /A version is already published, so this draft cannot be published over it/u,
    )).toBeVisible();
  });

  it("offers no verb that would withdraw or replace the standing version", () => {
    render(<AdminAccountTerms acceptanceLive drafts={[draft]} published={published} />);

    for (const name of [/unpublish/iu, /withdraw/iu, /replace/iu, /supersede/iu, /delete/iu]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("publishes the exact key and hash pair the row is showing", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(new Response(
      JSON.stringify({ state: "published", auditId: "9002" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    render(<AdminAccountTerms acceptanceLive={false} drafts={[draft]} published={null} />);

    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toEqual({
      action: "publish",
      versionKey: draft.versionKey,
      contentHash: draft.contentHash,
    });
    expect(await screen.findByText(/Logged after server confirmation, audit receipt #9002/u)).toBeVisible();
    expect(screen.getByText(/SETTERFI_ACCOUNT_TERMS_LIVE is off/u)).toBeVisible();
  });

  it("shows the registry's own refusal rather than a generic failure", async () => {
    const user = userEvent.setup();
    stubFetch(new Response(
      JSON.stringify({
        state: "refused",
        code: "ACCOUNT_TERMS_ALREADY_PUBLISHED",
        error: "A version is already published.",
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    render(<AdminAccountTerms acceptanceLive={false} drafts={[draft]} published={null} />);

    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("A version is already published.")).toBeVisible();
    expect(screen.getByText("The publication was refused")).toBeVisible();
  });

  it("holds the draft submit until all three fields carry a value", async () => {
    const user = userEvent.setup();
    render(<AdminAccountTerms acceptanceLive={false} drafts={[]} published={null} />);

    const save = screen.getByRole("button", { name: "Save draft" });
    expect(save).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: /Version key/u }), "2026-10-terms-v2");
    await user.type(screen.getByRole("textbox", { name: /Terms of service/u }), "Terms body.");
    expect(save).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: /Privacy policy/u }), "Privacy body.");
    expect(save).toBeEnabled();
  });

  it("sends the draft bodies untouched and never a hash of its own", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(new Response(
      JSON.stringify({ state: "drafted", auditId: "9001" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    render(<AdminAccountTerms acceptanceLive={false} drafts={[]} published={null} />);

    await user.type(screen.getByRole("textbox", { name: /Version key/u }), "2026-10-terms-v2");
    await user.type(screen.getByRole("textbox", { name: /Terms of service/u }), "Terms body.");
    await user.type(screen.getByRole("textbox", { name: /Privacy policy/u }), "Privacy body.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toEqual({
      action: "draft",
      versionKey: "2026-10-terms-v2",
      termsBody: "Terms body.",
      privacyBody: "Privacy body.",
    });
  });

  it("states that the registry could not be read instead of reporting nothing published", () => {
    render(
      <AdminAccountTerms
        acceptanceLive={false}
        drafts={[]}
        published={null}
        readError="The account terms registry could not be read, so this page cannot say what is published."
      />,
    );

    expect(screen.getByText(/could not be read/u)).toBeVisible();
    expect(screen.queryByText(/No terms are published/u)).not.toBeInTheDocument();
  });
});
