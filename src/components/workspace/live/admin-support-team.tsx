"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { ConsoleDeck } from "@/components/kit/console-deck";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { DataState } from "@/components/kit/data-state";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ExportMenu } from "@/components/kit/export-menu";
import type { StatStripItem } from "@/components/kit/stat-strip";
import { ListPage } from "@/components/kit/templates/list-page";
import { wholePageProvenanceKind } from "@/components/kit/provenance-chip";
import {
  GridTable,
  GridTableCell,
  GridTableHead,
  GridTableIdentity,
  GridTableRow,
  Monogram,
  MonoMeta,
  ProgressBar,
  Status,
  UnassignedMark,
} from "@/components/kit/atomics";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import type { SuccessClientBookRead } from "@/lib/repositories/support";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";

/**
 * The success team, derived from the assignments themselves.
 *
 * `AdminSupportTeam.dc.html` draws a roster of people, how loaded each of them is, and the clients
 * sitting with nobody's name on them. Two of those three are countable today: `tenants.success_owner`
 * is on the client-book projection as `successOwner`, so grouping the book by owner gives the
 * roster, the size of each book, and the requests still waiting on somebody.
 *
 * ## What the canvas draws that is not drawn here, and why
 *
 * **Median reply per person.** There is no first-response stamp anywhere in the schema --
 * `admin-inbox.tsx` records the same absence for its own "First touch" figure, and
 * `webhook_events` carries no `conversation_id` to reconstruct one from. A per-owner median would
 * have to be timed off `updated_at`, which moves for every write and would rank the team by how
 * often their threads are touched rather than by how fast anyone answers. The card says the figure
 * is not measured instead of showing a number nobody can defend.
 *
 * **The `Assignment` panel: round-robin, `Rotation running`, `Pause assignment`.** No rotation
 * exists. `success_owner` is a single nullable uuid with no queue, no cursor and no scheduler
 * behind it; the only "rotation" in the migrations is `provider.rotation.verified`, which is
 * credential rotation and a different thing entirely. Drawing a `Rotation running` pill and a
 * `Pause assignment` button over nothing would be a control that reads as broken the first time
 * somebody presses it, so the panel states how assignment actually happens today -- by hand, from
 * the two surfaces that already do it, each write carrying a reason and an audit entry.
 *
 * **`Was` and `Why` on the unassigned table.** There is no owner-change history table. The audit
 * log records every reassignment, so the history is recoverable, but recovering it is an audit
 * query per client and not a column on this read.
 *
 * ## The roster is the assignments, which is a real limit
 *
 * Nobody appears on this page until they own a client, because the client book is the only read
 * that names success owners at all -- there is no team-roster read, and `users` is not projected
 * cross-tenant to this surface. A new hire with an empty book is therefore invisible here, which
 * is stated on the page rather than left for somebody to discover.
 */

type SupportTeamProps = {
  /** The signed-in operator, so their own card can be marked. */
  actorId: string;
  enabled: boolean;
};

type OwnerBook = {
  id: string;
  name: string;
  clients: number;
  openRequests: number;
  onboarding: number;
  live: number;
};

const CRUMBS = [
  { label: "SetterFi platform" },
  { label: "Success team" },
];

/** Waiting on a person: the two states the client book already counts as an open request. */
function isOpenRequest(row: SuccessClientBookRead) {
  return row.supportStatus === "open" || row.supportStatus === "waiting_on_coach";
}

export function ownerBooks(rows: readonly SuccessClientBookRead[]): OwnerBook[] {
  const books = new Map<string, OwnerBook>();

  for (const row of rows) {
    const owner = row.successOwner;
    if (!owner) continue;
    const book = books.get(owner.id) ?? {
      id: owner.id,
      /*
       * An owner row with no name is a real state -- the projection types `name` as nullable -- and
       * it prints as an unnamed owner rather than as a uuid. A uuid on a card headed by a monogram
       * would read as a person's name to anybody scanning the page.
       */
      name: owner.name?.trim() || "Owner not named",
      clients: 0,
      openRequests: 0,
      onboarding: 0,
      live: 0,
    };
    book.clients += 1;
    if (isOpenRequest(row)) book.openRequests += 1;
    if (row.status.toLocaleLowerCase() === "onboarding") book.onboarding += 1;
    if (row.status.toLocaleLowerCase() === "active") book.live += 1;
    books.set(owner.id, book);
  }

  // Heaviest book first: the page's question is who is loaded, and a name-sorted roster answers a
  // different one. Open requests break a tie, since two equal books are not equal work.
  return [...books.values()].sort((left, right) =>
    right.clients - left.clients
    || right.openRequests - left.openRequests
    || left.name.localeCompare(right.name),
  );
}

/**
 * What the card says about a book, in words, from the two counts behind it.
 *
 * Never a judgement the numbers do not support: "overloaded" is not a state anybody defined, so the
 * sentence describes the book rather than grading the person holding it.
 */
function bookSentence(book: OwnerBook, largest: number) {
  const clients = `${book.clients} ${book.clients === 1 ? "client" : "clients"}`;
  if (book.openRequests === 0) {
    return `${clients}, none of them waiting on a reply.`;
  }
  const share = book.clients === largest && largest > 0 ? "the largest book on the team, and " : "";
  return `${clients}, ${share}${book.openRequests} waiting on a reply.`;
}

export function AdminSupportTeam({ actorId, enabled }: SupportTeamProps) {
  const [rows, setRows] = useState<SuccessClientBookRead[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      // The whole platform, not the reader's own book: this page is about who owns what, so
      // `book=mine` would answer with the one book the reader already knows.
      const response = await fetch("/api/platform/clients?book=all", { cache: "no-store", signal });
      const value = (await response.json()) as { clients?: unknown };
      if (!response.ok || !Array.isArray(value.clients)) throw new Error("CLIENT_BOOK_READ_FAILED");
      if (signal?.aborted) return;
      setRows(value.clients as SuccessClientBookRead[]);
    } catch {
      if (!signal?.aborted) setError("The client book could not be read, so the team cannot be counted.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [enabled, load]);

  const books = useMemo(() => ownerBooks(rows ?? []), [rows]);
  const unassigned = useMemo(
    () => (rows ?? []).filter((row) => !row.successOwner),
    [rows],
  );
  const largest = books[0]?.clients ?? 0;
  /*
   * Every figure on this page is counted from the client book, so the disclosure is about the same
   * rows: a fleet of seeded clients makes every book size, load meter and open-request count on
   * screen a figure about demo data. A book with one real client in it is a mixed page and says
   * nothing here.
   */
  const bookProvenanceKind = wholePageProvenanceKind(
    rows ?? [],
    (row) => (row.client.isDemo ? "demo" : null),
  );

  /*
   * What each of the two tables on this page hands over, built from the same figures the rows
   * already draw. Nothing is projected that the surface does not show: no cost, no margin, no
   * identifier a reader cannot already see on screen.
   */
  const bookExportRows = useMemo(
    () => books.map((book) => ({
      owner: book.name,
      clients: book.clients,
      live: book.live,
      onboarding: book.onboarding,
      openRequests: book.openRequests,
      medianReply: "Not measured",
    })),
    [books],
  );
  const unassignedExportRows = useMemo(
    () => unassigned.map((row) => ({
      client: row.client.name,
      plan: row.planLabel ?? "No plan recorded",
      lifecycle: row.status,
      request: row.supportStatus ?? "None",
      lastChange: row.updatedAt,
      successOwner: "Unassigned",
    })),
    [unassigned],
  );

  const read = rows !== null;

  const figure = (label: string, value: number, note: string): StatStripItem => ({
    label,
    availability: read
      ? { kind: "value", value, format: "count" }
      : { kind: "unavailable", note: "The client book has not answered yet." },
    ...(read ? { note } : {}),
  });

  const tiles: StatStripItem[] = [
    figure("People with a book", books.length, "Everyone who owns at least one client."),
    figure("Clients assigned", (rows?.length ?? 0) - unassigned.length, "Owned by a named person."),
    figure(
      "Open requests",
      (rows ?? []).filter(isOpenRequest).length,
      "Waiting on somebody on the team.",
    ),
    figure("Unassigned", unassigned.length, "Nobody on the team owns these clients."),
  ];

  const body = !enabled ? (
    <DataState
      body="Support is not switched on for this deployment, so there are no assignments to group."
      kind="empty"
      title="The success team is not available yet"
    />
  ) : error ? (
    <DataState body={error} kind="error" retry={() => void load()} title="The team could not be read" />
  ) : loading && !read ? (
    <DataState kind="loading" />
  ) : (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[13px] overflow-y-auto">
      {books.length === 0 ? (
        <DataState
          body="Every client on the platform is unassigned, so there is no book to group. Assign one from the client book and this roster fills in."
          kind="empty"
          title="No client has an owner yet"
        />
      ) : (
        <>
        {/*
          The second of the two exports the canvas draws. The roster is a deck of cards rather than
          a `GridTable`, but it is the same tabular thing -- one row per owner, five counted
          columns -- and "who is loaded" is a question answered in a spreadsheet as often as on
          screen. `medianReply` ships as the words the cards show rather than as an empty column,
          so a reader opening the file cannot mistake a blank for a zero.
        */}
        <div className="flex justify-end">
          <ExportMenu
            filename="setterfi-success-team"
            label="Export the roster"
            mode="local"
            rows={bookExportRows}
          />
        </div>
        <ConsoleDeck ariaLabel="Success owners and their books">
          {books.map((book) => (
            <DeckPanel
              dataSlot="support-team-owner"
              eyebrow={book.id === actorId ? "Your book" : "Success owner"}
              figure={<span className="mono tabular-nums">{book.clients}</span>}
              footer={
                <div className="flex flex-col gap-[7px]">
                  <ProgressBar
                    height={4}
                    label={`${book.name}: ${book.clients} of ${largest} on the largest book`}
                    tone={book.openRequests > 0 ? "warning" : "accent"}
                    value={largest > 0 ? book.clients / largest : 0}
                  />
                  <MonoMeta>
                    {book.live} live · {book.onboarding} onboarding · {book.openRequests} open
                  </MonoMeta>
                  {/*
                    The figure the canvas draws third on this card, and the reason it is a sentence
                    rather than a number. Stated per card rather than once at the foot of the page:
                    a reader comparing two people looks at the cards, and an absence noted somewhere
                    else is an absence they will not see while they are comparing.
                  */}
                  <span className="text-[11.5px] leading-[1.4] text-[color:var(--faint)]">
                    Median reply is not measured. Nothing records when a thread was first answered.
                  </span>
                </div>
              }
              key={book.id}
              name={book.name}
              sentence={bookSentence(book, largest)}
            />
          ))}
        </ConsoleDeck>
        </>
      )}

      <DeckPanel
        dataSlot="support-team-assignment"
        eyebrow="Assignment"
        name="Clients are assigned by hand"
        sentence="There is no rotation to start, pause or resume. A client gets an owner when somebody sets one, and every change carries a reason and an audit entry."
      >
        <p className="m-0 text-[13px] leading-[1.5] text-[color:var(--muted)]">
          Reassignment happens in two places and both write the same receipt:{" "}
          <Link href="/admin/platform-clients">the client book</Link>, on the client&rsquo;s own
          row, and <Link href="/admin/support">Client requests</Link>, on the thread. Round-robin
          would need assignment state the platform does not hold, so this page shows who owns what
          rather than claiming to distribute it.
        </p>
      </DeckPanel>

      <DeckPanel
        dataSlot="support-team-unassigned"
        eyebrow={unassigned.length === 0 ? "Nothing unowned" : "Waiting for an owner"}
        name={
          unassigned.length === 0
            ? "Every client has somebody's name on it"
            : `${unassigned.length} ${unassigned.length === 1 ? "client has" : "clients have"} nobody's name on them`
        }
        sentence={
          unassigned.length === 0
            ? "Nothing on the platform is sitting unowned right now."
            : "An unowned client is nobody's to answer, so this is the list the team works down first."
        }
      >
        {unassigned.length === 0 ? null : (
          <>
          {/*
            CLAUDE.md: "Every table exports CSV/JSON." This one did not, and it is the list the
            team works down first -- an operator chasing unowned clients into a spreadsheet is the
            actual job, so a table that can only be read is a table whose contents get retyped.
            `AdminSupportTeam.dc.html` draws Export twice on this screen.

            `mode="local"` rather than the `success-client-book` server resource, deliberately.
            That resource exists and this page reads the same projection, but its filters are
            `search`, `status`, `book` and `assignee` -- there is no unassigned filter, so a server
            export from here would hand back the whole platform book under a heading that says
            these are the clients nobody owns. A local export carries exactly the rows on screen.
            `admin-agents.tsx` and `admin-inbox.tsx` set the same precedent, and the whole book is
            still exportable from the client book itself, where the heading matches what comes out.

            Named, because the roster above exports too and two controls both reading "Export" is
            the same as neither of them being named. No cost or margin is projected: these are the
            same five fields the row already draws.
          */}
          <div className="mb-[var(--s-3)] flex justify-end">
            <ExportMenu
              filename="setterfi-unassigned-clients"
              label="Export unassigned"
              mode="local"
              rows={unassignedExportRows}
            />
          </div>
          <GridTable columns="1.6fr .9fr .9fr 1fr" label="Clients with no success owner">
            <GridTableHead
              columns={[
                { label: "Client" },
                { label: "Lifecycle" },
                { label: "Request" },
                { label: "Last change", align: "right" },
              ]}
            />
            {unassigned.map((row, index) => (
              <GridTableRow key={row.client.id} last={index === unassigned.length - 1}>
                <GridTableCell>
                  <GridTableIdentity
                    leading={<Monogram name={row.client.name} />}
                    name={row.client.name}
                    subline={row.planLabel ?? "No plan recorded"}
                  />
                </GridTableCell>
                <GridTableCell>
                  <Status label={row.status} tone="neutral" />
                </GridTableCell>
                <GridTableCell>
                  {row.supportStatus ? (
                    <Status
                      label={row.supportStatus.replace(/_/gu, " ")}
                      tone={isOpenRequest(row) ? "warning" : "neutral"}
                    />
                  ) : (
                    <UnassignedMark />
                  )}
                </GridTableCell>
                <GridTableCell align="right">
                  <MonoMeta>{workspaceTimestampFormat.format(new Date(row.updatedAt))}</MonoMeta>
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
          </>
        )}
      </DeckPanel>

      {/*
        The roster's own boundary, on the page rather than in a docstring. Somebody comparing two
        cards has to know the page cannot show a third person whose book happens to be empty.
      */}
      <p className="m-0 text-[12px] leading-[1.5] text-[color:var(--faint)]">
        This roster is built from the assignments themselves, so somebody with no clients yet does
        not appear here.
      </p>
    </div>
  );

  return (
    <AppShell activePath="/admin/support-team" crumbs={CRUMBS} nav={workspaceNavigationFor("admin")} role="admin">
      <ListPage
        description="Who owns which coaches, how loaded each of them is, and where a client is sitting with nobody's name on it."
        provenanceKind={bookProvenanceKind ?? undefined}
        stats={enabled && read ? <ConsoleStatDeck ariaLabel="Success team summary" heroLabel="Unassigned" items={tiles} /> : undefined}
        title="Success team"
      >
        {body}
      </ListPage>
    </AppShell>
  );
}
