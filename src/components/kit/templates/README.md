# Admin page templates

Every admin page is one of three shapes. Pick the shape first, then fill it. If a page seems to
need a fourth shape, it is usually two pages.

| The page is… | Use | Example |
| --- | --- | --- |
| a set of records you scan, filter, and open | `ListPage` + `DataTable` | Client book, Audit, Corrections |
| one record you inspect and act on | `DetailPage` | A client, an eval run, a payout |
| configuration split across sub-pages | `SettingsLayout` + `SettingsSection` + `FormSaveBar` | Settings, Plans and pricing |

Shared rules: default table columns are 4 to 6, the stat strip caps at 4 tiles, tab 1 is the
decision view and economics or provisioning internals go into a later tab, and every table keeps
its Export CSV/JSON. Privileged actions carry `AUDIT_ACTIONS[...].microcopy` as their `logged`
string.

## ListPage

```tsx
<ListPage
  title="Client book"
  description="Every coach on the platform and who owns them."   // REQUIRED
  actions={<Button variant="outline">Export</Button>}            // outline / ghost only
  stats={<StatStrip items={tiles} />}          // optional, max 4
  primaryAction={{ label: "Import now", onClick: startImport }}
  provenance="Demo rows are labelled and excluded from analytics."
>
  <DataTable
    ariaLabel="Client book"
    columns={columns}
    data={rows}
    getRowId={(row) => row.client.id}
    emptyState={<DataState kind="empty" title="No clients yet" body="…" />}
    search={{ columnId: "client", placeholder: "Search clients" }}
    facets={[{ columnId: "status", title: "Status", options: statusOptions }]}
    exportResource={{ mode: "server", resource: "platform-clients", filename: "client-book" }}
    onRowClick={(row) => setSelected(row)}
    rowActions={(row) => [
      { id: "reassign", label: "Reassign owner", onSelect: () => reassign(row) },
      { id: "impersonate", label: "Impersonate", tone: "critical",
        logged: AUDIT_ACTIONS["impersonation.started"].microcopy },
    ]}
    testRow={(row) => row.client.isTest}
    rowLabel={{ singular: "client", plural: "clients" }}
  />
</ListPage>
```

The page never scrolls: `ListPage` is a `data-layout="fixed"` column and the table scrolls inside
itself with a sticky header.

## DataTable props worth knowing

- `search` — `{ columnId?, placeholder?, label? }`. Omit `columnId` to filter across every column.
- `facets` — `[{ columnId, title, options }]`. The column needs a `filterFn` that takes an array,
  usually `filterFn: "arrIncludesSome"`.
- `selectable` / `selection` — either turns on the checkbox column; `selection` adds the bulk bar.
- `rowActions(row)` — the kebab column. Give the same actions the record sheet gives.
- `testRow(row)` / `testRowLabel` — the on-screen demo label in the identity cell. It renders only
  while the set is mixed: when every row is seeded, the chip would repeat on every line and say
  nothing about the differences between them, so the table drops it and marks itself
  `data-all-test-rows`. Ask `everyRowIsTest(rows, isDemo)` (exported beside `DataTable`) and pass
  the page-level `provenance` line instead.
- `loading`, `error`, `emptyState` — the three non-row states, all through `DataState`.
- `pagination` — `{ mode: "offset", pageSize }` for client paging, or `{ mode: "cursor", … }` when
  the server pages and sorts.
- `toolbarEnd` — page controls that belong in the right-hand group beside Display and Export.
  Use it for a page's own export or a tooltip-wrapped control; `toolbar` puts children on the left.
- `displayOptions` — extra groups inside the Display menu (a Layout choice, an Order group), as
  `DropdownMenuGroup` + `DropdownMenuLabel` + items.
- `DataTableToolbarShell` — the toolbar row on its own, exported alongside `DataTable`, for a
  second layout of the same page (a grouped feed, a board) that needs the same controls.
- Column width — `meta.width` pins a column, `meta.minWidth` raises its floor; both beat the
  `cellKind` default. Without either, a column sizes to its content between a floor and a ceiling:
  identity columns get the widest band (220px to three quarters of the drawer) because they carry
  the longest strings, money stays a quarter of the drawer, and the selection and kebab columns
  stay fixed.
- Density is shell state and the table takes no prop for it: the Display menu calls `setDensity`
  from `useShellDensity()`, and the shell root carries `data-density` and `--row-h`, persisted at
  `setterfi:device:density`. A per-table value would shadow the reader's choice.
- A press inside the checkbox or the kebab never opens the row. The table stops those two cells
  from bubbling, so a page needs no per-page guard against two overlays opening at once.
- The pagination footer reads `Showing 1–8 of 8 entries`, from `rowLabel`.
- `initialSorting={[{ id: "updatedAt", desc: true }]}` — the sort the table opens on, so rows that
  arrive already ordered show the indicator on the column doing the ordering.
- A short result set ends at its last row: the page's height lands on an outer frame and the card
  inside it sizes to its rows, so eight rows no longer leave a screen of empty ruled table.
- Header type is one treatment for every column. The sortable header inherits the `th`'s 11px
  uppercase muted type and shows its chevron only on hover, focus, or while sorted, so sortability
  never looks like a property of the data.

- A facet can be controlled: pass `value` + `onChange` (and no `columnId`) for one whose value
  lives in the URL because the server pages the rows. Same chip, different home for the value.
- `stateColumn` takes `kind: "none"` alongside the pill kinds, so an absence cell goes through the
  factory instead of a hand-built span.

### Default vs Display columns

Ship 4 to 6 columns on the default view. Everything else stays declared but hidden:

```ts
{ accessorKey: "providerState", header: "Provider state", meta: { defaultHidden: true, label: "Provider state" } }
```

Any column with a non-string `header` must carry `meta.label` — the Display menu refuses to leak a
technical column id, and throws in development if the label is missing.

Column factories in `../columns.ts` (`identityColumn`, `moneyColumn`, `dateColumn`, `stateColumn`,
`selectColumn`) set the right `meta.cellKind`, which drives column width and alignment.

### Opening a RecordSheet from a row

```tsx
const [selected, setSelected] = useState<Client | null>(null);

<DataTable … onRowClick={setSelected} />
<RecordSheet
  open={selected !== null}
  onOpenChange={(open) => !open && setSelected(null)}
  title={selected?.name ?? ""}
  subtitle={selected?.plan}
  state={statusBadge(selected?.status)}
  tabs={[
    { id: "overview", label: "Overview", sections: [{ title: "Owner", body: <KeyValue … /> }] },
    { id: "economics", label: "Economics", sections: [{ title: "Cost", body: … }] },
  ]}
  primaryAction={{ label: "Reassign owner", onClick: reassign }}
  secondaryAction={{ label: "Open full record", href: `/admin/clients/${selected?.id}` }}
  logged={AUDIT_ACTIONS["support.reassigned"].microcopy}
/>
```

`sections` alone still works for a single-view sheet; pass `tabs` when the record has more than one.

## DetailPage

```tsx
<DetailPage
  title={client.name}
  subtitle={`Coach since ${joined}`}                             // REQUIRED
  state={{ kind: "lifecycle", tone: "good", label: "Live" }}
  provenance="Demo data, excluded from real analytics."
  actions={<Button variant="outline">Message</Button>}           // outline / ghost only
  primaryAction={{ label: "Reassign owner", onClick: reassign }} // the page's ONE fill
  tabs={[
    { id: "overview", label: "Overview", content: <Overview client={client} /> },
    { id: "provisioning", label: "Provisioning", count: 3, content: <Provisioning client={client} /> },
    { id: "economics", label: "Economics", content: <Economics client={client} /> },
  ]}
/>
```

The header does not scroll; each tab's content does. A `DetailTab` with `href` renders its trigger
as a link and marks itself `aria-current="page"` when open, for tabs that are really sub-routes. `provenance` is the same one-line disclosure
ListPage takes, rendered under the subtitle — pages should not hand-roll it.

## SettingsLayout

```tsx
<SettingsLayout
  title="Settings"
  description="Platform configuration."
  items={[
    { href: "/admin/settings", title: "General" },
    { href: "/admin/settings/branding", title: "Branding" },
    { href: "/admin/settings/notifications", title: "Notifications" },
  ]}
>
  <SettingsSection
    title="Workspace"
    description="How the platform names itself to coaches."
    actions={<ExportMenu … />}
    footer={
      <FormSaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        onDiscard={reset}
        logged={AUDIT_ACTIONS["settings.updated"].microcopy}
      />
    }
  >
    <Field … />
  </SettingsSection>
</SettingsLayout>
```

`SettingsSection.actions` sits on the heading row: an export, a link out. The save action belongs
in `footer`, never there. The rail is text only. `SidebarNavItem.icon` exists in the type for a later custom-icon pass and
renders nothing today.

## The sr-only trap in fixed-height pages

`sr-only` is `position: absolute`. Inside a fixed-height scroll container with no positioned
ancestor, its containing block is the viewport: it escapes the scroller's clip, adds its static
offset to `documentElement.scrollHeight`, and puts a scrollbar on a page that is meant to be
viewport-fixed. `overflow: hidden` on the scroller does not fix it; only a positioned ancestor
(or `contain: paint`) does.

Every scroller these templates own already carries `relative` — the table's scroll region, the
detail tab body, the settings content column, the record sheet body, the settings rail — so an
`sr-only` heading you drop into any of them is safe. If you add your own `overflow-y-auto` inside
a page, add `relative` with it.

To catch it on any fixed page: load it and run `window.scrollBy(0, 500); window.scrollY`. Anything
non-zero means something is escaping a scroller.

## Mapping enums to StateBadge

Map every enum to sentence-case copy in one place per page, then hand `StateBadge` a tone. Nothing
raw (`open`, `past_due`) reaches the screen.

```ts
const CLIENT_STATE = {
  active:     { label: "Active",     tone: "good" },
  onboarding: { label: "Onboarding", tone: "warning" },
  past_due:   { label: "Past due",   tone: "critical" },
} as const satisfies Record<string, { label: string; tone: StateTone }>;
```

- `kind="lifecycle"` (default) — a washed pill with a dot. The everyday row state.
- `kind="verdict"` — a washed pill with a meaning icon. Pass/fail, ready/blocked.
- `kind="tag"` — an outlined chip. Channels, labels, categories.
- `size="sm"` inside dense table cells, `size="md"` in headers and sheets.
- `dot={false}` when the label alone carries it.

Honest states survive the port: provisioning is amber with a real day counter (`DayCounter`), never
a percentage and never "all set" while a carrier is still vetting.

`ListPage` also takes `scope`, rendered between the stats and the table: the switch that changes
*which* rows the page is about (my clients vs all, this month vs last), which is a different
question from the filters inside the table's own toolbar.

## The page head, and the one rule everybody breaks

Both `ListPage` and `DetailPage` draw the same head: mono-11 breadcrumb, a 20/600 title, one
muted sentence, then right-aligned actions.

- **`description` on `ListPage` is REQUIRED, and `subtitle` on `DetailPage` is REQUIRED.** Same
  slot, same treatment, and `DetailPage` kept the name `subtitle` rather than growing a second
  prop, so every existing call site already satisfies it and nothing had to be rewritten. One
  sentence, muted, saying what the page is for: a title over a table leaves the reader to infer
  the page's job from its columns.
- **At most ONE filled (primary) button on a page.** It goes in `primaryAction`, renders last, and
  everything in `actions` is outline or ghost. Two fills on one page is a bug, not a preference —
  a page asking for nothing passes no `primaryAction` and shows no fill at all.
- In development both templates `console.warn` when they can see two filled controls in their own
  header row. **That warning only watches the header row.** It cannot see a filled button you put
  in a stat tile, a section heading, a table toolbar, an empty state, or a drawer — a page still
  has exactly one fill in total, and keeping that true is the author's job, not the template's.
  `PageHeader` (the older, non-template head) is stricter and throws outright.
- Tabs underline 2px in ink on the active tab. A `DetailTab` takes an optional `count`, rendered
  faint in mono after the label and hidden from the accessible name. Leave `count` off rather than
  passing `0` — an empty tab says so in its own body, and a grey zero in the strip reads as a
  broken count.

## Vertical rhythm

Every template used to stack its blocks with one `gap-[var(--s-4)]`, so the crumb, the title, the
stat strip, the scope row and the table all sat 16px apart and nothing in the spacing said where
the head ended and the content began. `templates/rhythm.ts` names the four breaks a page actually
has, and each block carries the break above it rather than inheriting a container gap:

| Break | Step | Where |
| --- | --- | --- |
| `crumb` | 8px | Breadcrumb to the title it labels. The tightest pair on the page. |
| `head` | 20px | Page head to the first block of content. |
| `section` | 32px (`--d-section-gap`) | Two sections doing different jobs: a summary strip and the table under it, one settings card and the next. |
| `control` | 12px | A control row to the thing it controls: a scope switch over its table, a tab strip over its panel. |
| `bareControl` | 24px | A page head to a bare text control strip. Tabs carry no border of their own and need more air above them than a bordered strip does. |

**A page's texture follows what it carries, and that is the point.** A `ListPage` with a stat strip
is two sections, so the strip sits close under the head and a full 32px separates it from the rows
— a tall summary block over tight rows. A `ListPage` with no strip is one section, so the table
opens 20px under the head and the reader is in the rows immediately. A `DetailPage` inverts the
shape again: its tab strip takes the wider 24px above and then sits 12px over the panel it governs.
The Overview and the client book are supposed to look like different pages.

Three densities carry the same idea across the components: a stat tile stands near 95px because it
is a figure to read, an `ExceptionTile` near 60px because it is one of a few things to act on, and
a table row at 36px (`--d-row`) because it is one of two hundred to scan. When those three drift
together the page reads as one undifferentiated grid, which is the failure mode this whole scale
exists to prevent.

The route skeletons in `page-skeleton.tsx` take the same breaks, and their bones stand at `--d-row`
and `--d-th`. A skeleton with a rhythm of its own re-flattens the page it is standing in for, at
exactly the moment the reader forms a first impression of it.

## Section headings

`PageSection` is for the long scrolling pages — help, the offer editor, integrations, support — that
stack several subjects under one head. It takes the 32px section break above its heading and gives
its own content 12px, so the section is pushed away from what precedes it and pulled tight around
what belongs to it:

```tsx
<PageSection title="Audience" description="Who the agent talks to." actions={<ExportMenu … />}>
  <Fields … />
</PageSection>
```

The announcement is entirely proportion. No rule, no tint, and specifically no coloured edge bar —
a stripe would be doing the spacing's job badly and the client rejected edge stripes outright.
`headingLevel={3}` changes the document outline without changing the type, because the break above
the heading carries the level. `first:mt-0` keeps the top section from double-spacing under a page
head that already set its own break.

A bare `<h2 className="text-section">` spaced the same as the paragraph above it is not a heading,
it is a bold line. Several pages still do that; they should move to `PageSection`.

## The list toolbar

`FilterBar` is one search input, a Filters popover, and an optional Display menu — one place to
type, not four controls competing to be the search box.

- **Saved views** render as a bordered segmented control ("All · Mine · Needs attention"): hairline
  dividers between segments, and the active one takes a quiet fill at weight 500. No accent rule,
  no coloured edge stripe — the client rejected edge stripes outright, and nothing in this kit may
  reintroduce one. Reuse it directly as `SegmentedControl` from `@/components/kit/segmented-control`
  when a page needs its own scope switch.
- **Applied filters** render as segmented chips: field · operator · value, in three segments split
  by hairlines. The value alone sits in ink at weight 500; the field and the operator stay muted,
  because they are the grammar and the value is the answer the reader is scanning for.
- **Clear all** carries an `esc` hint in a mono `kbd`, and Escape really does clear the toolbar —
  unless a popover, menu, or listbox is open, which owns Escape while it is up.

## The primary action

`ListPage` and `DetailPage` take `primaryAction` alongside `actions`:

```tsx
primaryAction={{ label: "Publish to all agents", onClick: publish, logged: "brain.published" }}
```

It renders last in the action row and is the only filled control on the page — everything in
`actions` stays outline or ghost. A page that is asking for nothing passes no `primaryAction` and
shows no fill; two fills on one page is a bug, not a preference. Pass `logged` for an audited
action and the microcopy renders as a caption under the button, never inside its label.

## StatStrip anatomy

Every tile is label / figure / at most one muted note, whatever `availability.kind` says. The figure
is the `.t-figure` role (mono 22/500, tabular) in every case, and `precision` fixes the decimals so a
tile never reads 6% beside a table that reads 6.0%. `note` on the item supplies the note line for a
plain `value` tile, the one kind whose availability carries no note of its own.

What the figure says when there is no number is a contract, not a style choice: **the literal words
"not yet" in italic faint**, with the reason on the note line beneath. Never a zero, which claims
the window was measured and came back empty, never a percentage of a bar filling up, and never a
predicted date. The one exception is `no-events`, where the window genuinely was measured and
nothing happened in it, so `0` is the true reading. `needs-history` shows a day counter and the days
still needed. There is a test on all of this; it is the honest-states rule from CLAUDE.md rendered.

A tile is padded 20/16 around the figure and stands near 95px, roughly three of the table's 36px
rows. That proportion is what makes the strip read as a block over rows rather than as a slightly
taller stripe in the same grid.

## State tone and absences

`info` is reserved for a state that is genuinely in progress. It sits close enough to the accent
that a column of `info` pills reads as a column of selected rows, so anything meaning "closed",
"nothing yet", or "not applicable" is `neutral`. An absence is not a state at all: pass
`kind="none"` and the badge renders as quiet muted text with no pill and no dot, which is what
"No request" and "No scheduled change" should look like next to real states.

## Checkbox matrices

`MatrixCheckbox` is one cell of a permission or delivery grid. It builds its accessible name as
"column for row" from a hidden span, so a screen reader hears "Email for Appointment booked" while
the screen shows a bare box under an `Email` column header. Pass `showColumnLabel` only where
there is no header row to carry the word. A cell fixed by policy takes `locked` plus
`lockedReason`, which draws a lock glyph — dimming alone makes a locked-on box and a
disabled-off box look the same.

## Day counters

`elapsedWorkspaceDays` returns `number | null` and never throws: an unreadable start time is an
absence, logged in development, not a crash. `DayCounter` renders "Still waiting" with the typical
range and no day number in that case, because "Day 0" would claim the wait began today. It accepts
a date-only value or any timezone-qualified timestamp, including the six fractional digits Postgres
writes for `timestamptz` — a caller does not need to round the value before handing it over.
