# Coach rehaul notes

The running log for the coach side, in the same shape as
`docs/plans/2026-09-03-ui-rehaul-notes.md`, which is what kept the owner console pass coherent
across twenty-six corrections. Ayman's notes go in verbatim, in arrival order, each with what was
found underneath it and what was done.

The rules the owner pass was built on are in `docs/COACH-REDESIGN-PLAYBOOK.md`. Read that first.
The visual authority is `docs/REDESIGN-CANVAS.md`, which is still right on layout, anatomy, copy and
ordering, and out of date on colour.

## Note 1 (2026-09-04, screenshot of coach Overview at `/coach`, first-run variant)

> this is kind of shit dont you think, and is there a way to fake these steps being done for demo
> purposes, temporarily ofc, then it resets in 10 minutes, also this whole page itself looks
> fucking weird,

Three separate asks: a judgement on the setup rail, a demo affordance, and a layout complaint.

**What the screenshot shows.** `Welcome, Reid`, one line reading "1 step is waiting on you", a
second line reading "Demo data, excluded from real analytics", then a two column block: "Your setup"
with a four card timeline on the left, "Your numbers" with three stacked figure cards on the right.
Below that, roughly a third of the viewport is empty.

**What is actually wrong, read against the component rather than the picture.**

1. **The step list has four cards and a counter that says "0 of 3 done".** The counter is honest by
   design, `coach-dashboard.tsx:671` counts only the rungs this page actually read, but a reader
   sees four rows and a denominator of three and concludes the page is broken. An honest number that
   reads as a bug is still a bug.
2. **The rows do not share an anatomy.** Step 1 and the last two cards carry a footer action bar;
   step 2 has none. Two different cards carry the same "See setup" label pointing at different
   places. Two rows are numbered steps and two are not.
3. **The blocked card repeats the page header.** The header already says "1 step is waiting on you"
   and the third card says "1 step is blocked" with a Blocked pill. Same fact, twice, eleven
   hundred pixels apart. This is playbook rule 4.
4. **The icon rail draws three icons for four rows,** so the spine does not line up with the cards
   it is threading.
5. **The dead space is our own absence rule at page scale.** The lower panels exist in the component
   (leads, booked calls, time to book, and the grids below them) and refuse to render on a first run
   account because they have nothing measured to show. Rule 1 of the playbook is right for a single
   card and wrong for two thirds of a viewport: the page needs a first run composition, not the
   ordinary composition with its middle removed. This is also exactly what the client said about
   Inbox on the 2026-09-02 call, "does not fill the screen; must work on every monitor".
6. **The figure cards are mostly empty.** Three tall cards holding one number each, with the number
   sitting in the top third and nothing under it.

**The demo affordance.** Wanted: mark the setup steps complete for a demo, then have it expire on
its own after ten minutes.

The hard constraint is the release boundary in `README.md`: nothing may present a provider,
integration or booking as complete unless a real receipt supports it. So this cannot write
`provisioning_steps`, and it cannot exist on a real tenant. Shape ruled on 2026-09-04:

- Presentation only. It never writes provisioning state, never writes an audit row, and never
  changes what any other reader sees.
- Available only when the tenant carries `is_demo` and demo logins are enabled, so it cannot appear
  on a real coach's account even by accident.
- Per viewer and time boxed. It is stored in the viewer's own browser with an expiry stamp, so it
  expires on its own and cannot outlive the demo, and a second viewer of the same tenant is
  unaffected.
- Visibly labelled while it is on, so nobody in the room mistakes the demo for the product.

**Decided.** The demo affordance ships now because it is small and unblocks demos. The dashboard
composition is the first coach surface of the redesign proper, and it follows the playbook sequence
rather than being patched ad hoc: draw it, build it as a new component, ship it to the demo tenant
for reaction.

## Note 2 (2026-09-04)

> is this literally the first onboardnig stage a new customer ever sees

No. Traced rather than assumed. A new coach goes signup, then the confirmation email lands them on
`/onboarding`, the setup companion, which has its own four step pill rail, its own headline counting
the outstanding checks, and five sub-routes: business profile, connect, texting eligibility,
calendar, offer. The coach role's home is `/coach/home`, which is where every later sign-in lands,
and there is no gate sending an incomplete coach back to `/onboarding`.

So the dashboard's setup rail is compensating for a missing redirect, and the same story is told
twice in two shapes: onboarding draws its rail off the fourteen step provisioning contract, the
dashboard draws four cards off a partial read of the same table. The open product question, not
decided here, is which one survives: route an incomplete coach to the companion and shrink the
dashboard's rail to a line, or fold the companion into the dashboard and delete it as a surface.
The canvas leans the second way, since it folds Get started into the Home setup card.

## Note 3 (2026-09-04)

> is there a way we can manually access that onboarding, for testing purposes

Yes, with nothing to set up. Sign in as the coach and open `/onboarding` directly; the route has no
gate, so it renders for any signed-in coach at any stage. The sub-steps are reachable the same way.
Verified on the dev server as the demo coach.

The visit proved the contradiction in Note 2: `/onboarding` says the demo coach has confirmed 3 of
7 checks with workspace activation ticked, while `/coach/home` says the same coach has 0 of 3 done.

## Note 1, what shipped (2026-09-04): the demo setup override

The affordance ruled on in Note 1 is built. Recording the shape here as well as in the code, because
a ruling that lives only in a comment is the failure the playbook's rule 10 names.

**It is a timestamp in one browser and nothing else.** `src/lib/demo-setup-override.ts` writes an
expiry to `localStorage` and reads it back. There is no server half of that module and there must
never be one: `provisioning_steps` is untouched, no audit row is written, and a second viewer of the
same tenant sees the real setup, which is what keeps this on the right side of the release boundary
in `README.md`.

**The gates are three and they fail closed.** `SETTERFI_DEMO_LOGINS`, `tenants.is_demo` for the
signed-in tenant (both resolved by `src/app/(workspace)/layout.tsx`), and `measurement.isDemo`,
which is the flag the provenance line under the greeting already prints. The third is deliberate
belt and braces: the control cannot appear on a page that is not already telling the room these rows
are seeded. It is also offered only on the first-run composition, because that is the only one with
a setup rail to override.

**The control lives in the context eye,** which is where this console already puts things a reviewer
opens on purpose, and which already labels itself "review only". `ContextEye` grew one anonymous
`action` slot for it; the eye knows nothing about demos. A button in the page header or the account
sheet would have read as a product feature, and this is not one.

**The header, the counter and the cards agree because they read one object.** The override does not
touch three renderers; it substitutes the `CoachChannelStatus` and the blocked-step count once, at
the top of `CoachDashboard`, and the status line, the rungs and the counter all read the
substitution. On the demo coach that turns "1 step is waiting on you" and "0 of 3 done" over four
cards into "Your agent is live on Instagram and Messenger" and "2 of 2 done" over three, with green
Live and Registered pills. The counter's `done` half now counts the channel rung from the status it
was handed rather than being pinned to zero, which is the same number it always was on a real first
run and the right one under the override.

Two things it deliberately does not fix, because Note 1 sends them to the redesign proper: the
greeting still reads "Welcome" rather than "Welcome back" while the override is on, since that word
is bound to the real first-run test that also chooses the page composition; and "The rest of your
setup" still renders under a full counter, because it names no state and is excluded from both
halves by the same rule that excluded it before.

Verified on the dev server as the demo coach, in Chrome: off, on, on after a reload with the same
expiry rather than a restarted clock, and off again. The suite covers the absent control on a real
tenant, the expiry, an expired stamp, a corrupt stamp, a stamp claiming longer than ten minutes, a
storage whose every accessor throws, and the three-way agreement while it is on.

## Note 4 (2026-09-04)

> fix whatever small issues you noted and pish to main again

Two of the noted items were small enough to fix without touching the composition, and both landed.

**The setup rail on the coach Overview** now obeys the four rules Note 1 listed. The rail is built
from one `rungs` array, the counter reads its length, and the rows are drawn from it, so three
cards sit over "0 of 3 done" and the two numbers cannot drift apart again. "The rest of your setup"
is no longer a card; it is a muted line and one link under the rail, because it names no state.
Every row is one panel with a header band carrying eyebrow, name, state pill and at most one
action; the footer action bars and the step numbering are gone, and the two "See setup" labels
became "Fix this step" on the blocked row and "See the rest of your setup" on the line below. The
blocked row names the step, "Opt-in pages" on the demo coach, through the shared step labels, so the
header's count is stated once. Each row draws its own connector to the next node, which is what
fixed the spine: the old single line ran to a fixed offset from the bottom of a last row whose
height changed with its footer.

**The Money cost rows** no longer travel through the export route. The Costs tab reads them
server-side in its own branch, the default Billing tab reads them in the existing parallel batch
because the record sheet's Cost tab needs them, and no view files the two spurious audit receipts
any more. Section 9.1 of `docs/BACKEND-SPEC.md` records the reasoning.

**Margin on the owner Overview is not a small fix**, and is recorded here so nobody spends an hour
rediscovering it. Traced in the hosted database: every row in the margin projection is complete, but
the read requires a projection window that starts thirty days before now and ends after now, and the
newest windows end on 2026-09-01 and 2026-09-03. So the metric was available on the first of the
month and has read "Unavailable" since the second. That is the phase 6 date drift already in the
owner backlog, not a formatting or binding defect.

Still open from Note 1: the greeting while the override is on, the first-run composition and its
dead space, and the mostly empty figure cards. Those belong to the redesign proper, which starts
tonight.

## Note 5 (2026-09-04, overnight): the coach canvas

Drawn overnight on the instruction to audit every coach screen, research each against Mobbin and
the impeccable product register, draw the canvas, then rebuild. The audit is
`2026-09-04-coach-visual-audit.md`, the research `2026-09-04-coach-mobbin-research.md`, and the
canvas is indexed in `docs/REDESIGN-CANVAS.md` under "The coach canvas, 2026-09-04".

Rulings made on the boards that the spec left open, so they are not re-litigated:

- Home live: the six bubbles sit in a three by two grid aligned to their tops, so a card with only a
  figure ends after its sentence. Booked calls is the one drenched panel and carries no allowance,
  which lives on Billing only. The trend is bars, past months faded, the current month solid and
  labelled "so far", with the partial month stated in a sentence. Keywords render in sentence case.
  The keyword table prints the denominator on every row and prints an absence sentence in place of
  rates for a keyword under ten senders.
- Home first run: three rungs from one list, the header states the count once and the row names
  the step, the hero always has something to say, and there are no figure cards at all.
- Inbox: the Needs you view drops the per-row state pill because every row would repeat the view.
  Lead details are facts only. Composer tabs read "Reply to Denise" and "Note to yourself".
- Agent: the four cards pack as two stacked columns. Keywords and question order are a fifth
  full-width panel written as prose with fields inside the sentence, with 44px up and down arrows
  beside an Asked or Skipped switch. This makes "Four things are yours" five in practice; the
  sentence stands until Alec rules.
- Leads: the two request actions live in a per-row menu with "Open the conversation" above them.
  Stage is a dot plus a word, not a pill. The board's non-drag equivalent is a "Move to" button.
- Billing: "18 of 25" is a figure and a phrase, not a progress bar. Change plan is the page's one
  filled button.
- Onboarding: later steps get a plain ring with no numeral; a step's form panel has no header band
  because the step title is the h1; the go-live board has no per-row "Ready" pill; on a phone the
  Continue button is a sticky full-width footer and there is no tab bar because onboarding is not
  the console.
- Setup: a broken channel that needs the coach's reconnect says so ("Its permission ran out, and
  reconnecting brings it back") and carries the button; an outage SetterFi owns says "We're fixing
  it" and carries nothing. The technical record is one closed disclosure.
- Notifications: one question, three rows, with Text and Both showing "Not ready yet" while the
  carrier review runs rather than being hidden.
- Loading: skeleton bars all the same height, because varying them draws data that has not arrived.
- Error and not found: one panel, one sentence, one button; no codes anywhere.

---

## Billing, what shipped

Written 2026-09-04, rebuilding `/coach/billing` from `design/coach/Billing.dc.html` against the
seeded demo coach. The screen the 2026-09-04 visual audit measured rendered two error blocks and
nothing else; the one before that spread five blocks and a chart over a record that carries one
period.

### What is on the page now

Four things and nothing else, in the artboard's order.

1. **The plan card**, hero radius, top left. Band: "Your plan" over the tier name, with **Change
   plan** as the page's one filled button. Body: the allowance as a 62px mono figure with `of 75`
   beside it and the phrase under it ("Booked calls this billing period. Resets October 3."). A
   three-up footer carries the cost with its cadence, the current period, and the overage rate.
2. **"Does N look wrong?"**, top right. The band holds one secondary button, "This count looks
   wrong", which opens a labelled text box and a "Send to support" button. Nothing else.
3. **"How did these appointments go?"**, full width. One row per unanswered appointment, name over
   the time, with **Showed** and **No-show** at 48px each. One footer line says every answer is
   logged and that it never changes the bill.
4. **One notice line inside the plan card**, and only when something is outstanding.

### Deliberate departures from the artboard

- **The three header buttons are one.** The artboard draws Invoices, "Update your card" and a card
  expiry notice. There is no saved-card record, no invoice document and no coach-reachable route
  to either, so none of them is drawn. "Change plan" is a link to `/coach/help`, because a plan
  change is arranged with SetterFi and takes effect at a period boundary; there is no self-serve
  mover and there is not going to be one.
- **The overage stat states its absence.** `coach_billing_projection` carries no overage rate, so
  the third stat reads "Not stated on your record" in the absent treatment rather than printing a
  number nobody can check. Dropping the stat entirely would have let a coach assume nothing is
  charged past the allowance, which is the opposite error.
- **The cadence is measured, not assumed.** The projection has a price and two period boundaries
  and no interval field, so the two dates decide the word: 26 to 32 days is "a month", and
  anything outside the three ordinary cadences is named "each period". On the seeded demo coach
  the period reads Oct 24 2025 to Oct 3 2026, so the card honestly says "each period". That is a
  seed defect worth fixing rather than a phrasing to paper over.
- **Answered rows are not drawn.** The artboard shows "Grant Okafor, Showed" as a settled row.
  `outcomePrompts` is the unanswered queue only; a booking whose attendance is recorded leaves the
  projection, so there is nothing to draw those rows from.
- **Skip is gone.** A row a coach does not want to answer is already answered by leaving it alone,
  and a third button on a two-button question is the form asking about itself. `skip_attendance`
  is untouched on the route.
- **Dates are the product's US formats**, not the artboard's "21 Aug to 20 Sep". A second date
  vocabulary on one screen is worse than a date style nobody drew.
- **The audit caption is one line, not eight.** `LoggedButton` prints a shield caption under every
  button, which on a four-row question is the "Required, sixteen times" defect from note 4 of the
  playbook. The attendance verbs are plain buttons and the card's footer carries the counted
  sentence instead. "Send to support" is still a `LoggedButton`, so the page keeps one visible
  audit caption where a privileged write actually happens.

### What was killed

The five caps overlines (the three category lines are `.coach-panel__eyebrow`, sentence case, and
the test asserts the exact three strings). The correction form's draft machinery: the picker of
billable events, the separate reason field, the in-flight status and the standing "Logged" caption
are one button, one box and one send. The progress meter under the allowance, which drew the ratio
the phrase already states. The single-bar chart, which was a shape drawn from one reading. The
"Activate your plan" panel, which reported the checkout state machine three times over an active
subscription; the checkout is now invisible plumbing that surfaces one line only when there is an
offer a coach can act on or a Stripe return still resolving, and says nothing at all when the route
answers 404 or fails.

### The demo tenant's empty list, stated rather than seeded

Every billable row on a demo tenant carries `is_test` and the projections exclude it, so the
attendance queue and the correction candidates are both empty on the demo coach by design. The
card says so in the figure's slot ("No calls are listed here. This is a demo workspace, so its
bookings are marked as test data and never billed.") using `snapshot.isDemo`, and a real workspace
with nothing waiting gets the plain sentence instead. Nothing was seeded to fill either.

### Backend gaps for Codex round two

- **A period-level correction request.** `/api/billing/corrections` requires an `eventId` and a
  non-zero `quantityDelta`, but the artboard's design is a coach describing the problem in words
  and a person reconciling it against the conversations. The page anchors the request to the most
  recent billable call in the period and says so under the box, which is honest but is not what is
  being asked. A `request_correction` that takes a period and a reason with no event and no delta
  would let the card drop that sentence.
- **The overage rate** is on the tier and not in `coach_billing_projection`. One field would turn
  the third stat from an absence into the number the artboard drew.
- **The billing interval.** The projection carries no interval, so the cadence is inferred from
  the period boundaries. One field removes the inference.
- **Settled attendance rows.** The projection returns unanswered prompts only, so the list cannot
  show recent bookings a coach already answered, which is half of what the artboard draws.
- **Seed defect, not a backend gap:** the login coach's `billing_subscriptions` period reads
  2025-10-24 to 2026-10-03 on the hosted project, so the plan card cannot call the price monthly.

### Measured in Chrome against the dev server, seeded demo coach

Light theme, `/coach/billing`, full page. No text node under 14px in the page's own content at
either width; the 13px pill labels and the 12px inbox count at 390 are the shell's pill bar, not
this surface. No pressable element under 44px except the shell's "Skip to main content" link.
Page `scrollWidth` equals `clientWidth` at 390. Document height 946 at 1440, content filling it,
against the audit's "60 percent of the viewport is empty".

One accent fill in the page's own content, on "Change plan". A second fill is on screen from the
support launcher, which paints `--accent-fill` at `HEAD`; the artboard draws that button in
`--ink` precisely so it cannot compete, and the fix is in the support-bubble lane rather than this
one.

Screenshots: `Billing-1440.png`, `Billing-390.png`, `Billing-1440-correction-open.png`,
`Billing-390-correction-open.png` in the round's scratchpad.

## Leads, what shipped

One screen for both routes. `/coach/contacts` and `/coach/pipelines` now mount the same
`rehaul/coach-leads.tsx`, one opening on the list and the other on the board, and the view is a
`?view=` search parameter after that. `live/leads-surface.tsx` is no longer mounted anywhere; it is
untouched on disk so the lane that owns it can retire it deliberately. The nav is unchanged, because
`workspace-navigation.ts` already matched both paths to the one Leads pill.

Built from `Leads.dc.html` and `LeadsBoard.dc.html`: title, a List / Board switch, a search box, a
stage filter that is a real popup rather than a native select, and Export with CSV and JSON. List
rows are 48px carrying name, channel, stage as a dot and a word, last activity and outcome, with a
44px per-row menu holding "Open the conversation", "Report a duplicate", "Request deletion" and the
sentence "Both requests open a message to support." The board is one column per stored stage, cards
carrying name, channel and age, one sentence and a worded pill, with a full-width "Move to" button
whose menu lists the other stages. Drag stays and the menu is its equivalent.

Killed, as `SIMPLIFICATION-SPEC` 2.3 rules: the five KPI cards, the eleven filter controls, merge,
unmerge, the type-to-confirm permanent delete, the call-back third view, the funnel and its three
restatements, the stage legend that repeated the column headings, the two `<details>` blocks and the
methodology footnote. The explainer prose moved into the context eye.

### Departures from the artboards, and why

- **Seven board columns, not five.** The artboards collapse the stored seven stages into five, which
  would put "No show" and "Disqualified" under one "Not a fit" heading. `lead-search.ts` already
  recorded that refusal: a coach who cannot tell the lead who never turned up from the lead who was
  turned away has lost the distinction they would act on. The board scrolls sideways instead, which
  is also the fix for the audit's clipped seventh column, and each column scrolls on its own so one
  crowded stage cannot make the page 7,888px tall.
- **Composed sentences, not the artboard's prose.** The cards read "Wants $40,000 to expand a
  trucking route" on the board. Nothing stores why a lead wants the money. The sentence is built
  from the funding goal, the credit range and the appointment, and says "Your agent has not captured
  anything yet" where none of those exist.
- **The pill is the agent's decision.** "Unscored", "Needs you" and "Ready to book" are three
  different facts on the artboard's cards. Only the decision is a stored field, so that is the pill,
  with "No decision yet" where it is null.
- **"Show more" rather than back and forward.** The artboard's footer pages the list. This grows it
  25 at a time under the same sentence, which needs no page cursor and no second control.
- **No provenance chip.** `ProvenanceChip` is 10.5px uppercase mono, three ways under the coach
  floor, and the kit is frozen. The screen states it once in words under the title instead, and only
  when every row agrees.
- **The dialog's send button is not accent-filled.** The one accent fill in view is the nav pill, so
  the request dialog uses the secondary button rather than putting a second fill on screen. Its
  heading cites `COACH_SURFACE_TITLE_CLASS` rather than respelling 20px at 600: the dialog is a
  bandless surface with no eyebrow over it, which is the role that constant names, and the constant
  keeps its size as a literal so it survives being portalled out of the coach shell.

### Measured in Chrome against the dev server, seeded demo coach, 200 leads

Light theme, full page, both routes at 1440x900 and 390x844. No text node under 14px in either
view's own content; the 13px pill labels and the 12px inbox count at 390 are the shell's pill bar.
No pressable element under 44px except the shell's "Skip to main content" link. Page `scrollWidth`
equals `clientWidth` at both widths on both routes. Exactly one accent-fill element in view, the
Leads nav pill. The board scrolls horizontally, 2,196px of columns in a 1,376px viewport, and each
column scrolls vertically inside 580px.

An `sr-only` span in the actions column header was pushing the document's scroll width to 846px at
390, because `sr-only` positions absolutely and the header cell was not a containing block. The cell
is `relative` now and the label stays.

Screenshots: `leads-contacts-1440.png`, `leads-pipelines-1440.png`, `leads-contacts-390.png`,
`leads-pipelines-390.png`, `leads-row-menu-1440.png` in the round's scratchpad.

### The list is a plain table, not `DataTable`

Deliberate, and it is why the coach route walk no longer reaches `src/components/kit/data-table.tsx`.
Three reasons, in order of weight. The audit's defect 5 is `DataTable`'s own column-header sort
triggers measuring 8px wide by 44 tall, five of them on this screen; the kit floor gives them a 44px
hit box but the control is still a sort affordance nobody asked for on a list whose order is fixed
and stated. `Leads.dc.html` draws five fixed columns with no sort, no density control and no column
picker, which is most of what `DataTable` is for. And the hard rule the component carries with it,
that every table exports, is met here by the same `ExportMenu` in the page header, in both formats,
over the filtered set rather than the visible page.

So the control that guard file uses to prove it read the coach surface at all wants repointing at
another kit component the coach side still mounts. That is an integration call, and the two guard
files were left alone.

### Backend, for Codex round two

Nothing was blocked. `listContacts`, the audited `setPipelineStage` route and the new
`POST /api/contacts/[id]/support-request` all carry what this screen needs. Two notes:

- `SETTERFI_PIPELINE_WRITE_LIVE` is unset locally, so the board honestly states once that no lead
  can be moved and draws no control it cannot honour. The move path itself is written and tested
  against a mocked route; it has not been exercised against a live write.
- The support request needs a note of one to 2,000 characters, so the two request actions open a
  small dialog for it rather than filing a message nobody wrote.

The page no longer reads `listFollowups`. The old surface used it for a "Needs you" marker on cards,
which the decision pill replaced; that is one fewer query per page load, and the signal still lives
on Home and the Inbox.

## Setup, what shipped (2026-09-04)

`design/coach/Setup.dc.html`, built as `src/components/workspace/rehaul/coach-setup.tsx` with its
server read beside it in `coach-setup-read.ts`. It replaces two surfaces at once: the six-step
`GetStartedChecklist` on `/coach/get-started` and the 1936-line `coach-integrations.tsx` on
`/coach/integrations`. Both routes render it, because `src/lib/workspace-navigation.test.ts` pins
that every destination demoted off the coach rail stays reachable, and because
`META_CONNECT_RETURN_PATH` sends a completed Meta sign-in back to `/coach/integrations` by name.

### What the page is

Two panels and a footnote. The steps panel carries the four receipt-backed steps from spec 2.5,
each one row with a state pill and no action, and closes with one shut `<details>` holding the
hashes, the carrier's decision code and who filed. The channels panel carries Instagram, Messenger,
texting and the calendar, each one row with its state and at most one 48px button. A small "Ask a
person" panel points at the support bubble, which is the only place the support hours are stated.

Everything spec 2.6 sent to admin is gone rather than hidden: reply windows, connection history,
last error, "what to try", message templates, the four-up stat strip and the "Check again" button.
`coach-setup.test.tsx` asserts their absence against the rendered page rather than the source, so a
helper cannot quietly bring one back.

### The three rules that shaped the derivation

**Nothing reads done while provisioning.** A step ticks on a receipt timestamp, never on a state
word. `provisioning_steps.completed_at` ticks business details, the safe test and go-live;
`carrierReviewFrom` ticks the carrier only on `done`. A step that is `done` in the runner's sense
with no completion time recorded reads as not finished, which is the honest answer.

**The carrier counter is real days elapsed.** The pill reads `Day 14 of about 21`, computed by
`elapsedWorkspaceDays` from the filing date, which is the same function `DayCounter` computes from,
so this pill and coach Home's counter cannot drift by a day. `about 21` is the top of
`CARRIER_TYPICAL_DAYS` in words. There is no percentage and no predicted date anywhere on the
screen, and a filing with no recorded date counts nothing and says so rather than counting from
today.

**A row SetterFi broke offers no button.** Three states, three treatments, following the
Customer.io and LangChain precedents in the Mobbin research. `expired` is the coach's, so it reads
"Its permission ran out, and reconnecting brings it back." with a Reconnect button. `error`,
`flagged`, `restricted` and `blocked_permanent` are ours, so they read "Instagram stopped answering
on Tuesday. We're fixing it." with nothing to press. A connected row names the account and stops.

### Rulings made here

- **The accent fill goes to the first connection, not the first repair.** The artboard gives the
  fill to "Connect calendar" while Instagram's Reconnect sits beside it in the secondary face, and
  the general rule behind that drawing is that a channel never connected is the gate on going live
  while a reconnect is a thirty-second repair of something that worked an hour ago.
  `coachSetupAccentRow` returns one key, so "exactly one accent fill" is a property of the function
  rather than something four rows have to agree about.
- **The texting row never repeats the day count.** Carrier progress is the carrier step's fact and
  appears once. The texting channel row says only whether leads can text yet.
- **Overview stays the active pill.** Setup is not one of the five rail destinations and a pill
  group with nothing lit reads as navigation that has lost its place, which is what the artboard
  draws. The cost is that `coach-pillbar.tsx` sets `aria-current="page"` on a link to a different
  route; see the shared-kit note below.
- **`/coach/integrations` keeps its route.** Deleting it would break the Meta OAuth round trip and
  Home's blocked-channel link. `coach-integrations.test.ts` was retargeted from the old page's
  shape to the new one, keeping every claim that still holds and asserting the removed diagnostics
  stay removed.

### Backend gaps hit, for Codex round 2

- **No coach-reachable read for the consent artifact or the content screen.** `loadCurrentArtifact`
  and `loadCurrentContentScreen` are private to their API handler modules, so the technical record
  repeats their two small table reads in `coach-setup-read.ts`. Either export them or move them to
  a repository, and this page should call that instead.
- **The A2P projection carries no approval timestamp.** `CoachA2pRegistrationProjection` has
  `submittedAt` but nothing for when the carriers decided, so an approved carrier step says
  "Approved" with no date beside it while every other finished step carries one.
- **`channel_connections` has no receipt that dates an outage.** The outage sentence names the day
  from `updated_at`, which is the row's last write of any kind rather than the moment it stopped
  answering. A `broke_at` (or the first failed delivery) would make that sentence exact.
- **The demo tenant has no `business_profile`, `a2p_brand` or `a2p_campaign` rows and no Meta
  connections.** Verified live: every step reads not filed and both Meta rows read not connected, so
  the day counter and the reconnect row cannot be seen against seeded data. The seeder should give
  the demo coach a filed registration mid-review and one expired Instagram token, which is the
  composition the artboard draws and the one worth showing on a call.

### Shared-kit changes wanted and not made

- **A section match on the coach pill bar.** `isWorkspaceNavItemActive` is exact-or-prefix, so
  lighting Overview on a folded route also claims `aria-current="page"` for it. A folded route
  wants "highlight the parent, claim nothing", which is a `coach-pillbar.tsx` change.
- **A 48px coach button in the kit.** `kitButtonClass` tops out at 34px because the console's
  toolbar is 30 to 34px, and `coach.css` can raise a mounted kit button to 44px but not to the 48px
  every artboard draws. This file writes its own two button faces and imports
  `ACCENT_FILL_SHADOW_CLASS` so at least the fill's shadow is shared rather than retyped.
- **A banded panel whose body is full-bleed rows.** `DeckPanel` pads its body 20px and `TitlePanel`
  has no band, so neither draws the band-plus-hairline-rows shape both panels here need. Written
  locally for now, the same way `coach-dashboard.tsx` writes its own `PANEL_CLASS` and `Band`.
- **`coach-integrations.tsx` is now unimported and was left in place.** Nothing renders it, but
  `src/components/palette-literals.test.ts` and `src/components/kit/atomics/button-class.test.ts`
  both `readFileSync` it by path and throw if it is missing, and neither is this lane's file.
  Deleting it is one commit once those two rows go with it.

### Measured in Chrome against the dev server, seeded demo coach

Light theme, both routes, full page, at 1440x900 and 390x844. No text node under 14px in the page's
own content at either width; the only sub-floor text at 390 is the shell's 13px phone tab bar. No
pressable element under 44px except the shell's "Skip to main content" link. Page `scrollWidth`
equals `clientWidth` at 390. Overview is the pill carrying `aria-current`. The technical record is
shut on load.

Zero accent fills on this tenant, which is the honest reading rather than a miss: Meta sign-in is
unconfigured on this deployment so both Meta rows carry no button, and the demo calendar is already
connected, so nothing on the page is the coach's to press and the status line says "Nothing is
waiting on you." The one-fill rule is pinned in the test against the composition the artboard draws.

Screenshots: `Setup-getstarted-1440.png`, `Setup-getstarted-390.png`, `Setup-integrations-1440.png`,
`Setup-integrations-390.png` in the round's scratchpad.

## Agent, what shipped (2026-09-04)

`/coach/agent` was a seven-step ladder with a Connections tab, a draft badge, a publish button and a
progress meter, in 2,160 lines. It is now one page of four editable cards, a read-only rail, a prose
keyword panel, a list of what the platform runs, and one Save. `coach-agent-connection-view.ts` was
deleted; the Connections tab was its only consumer, and channel connections already live on Setup.

### The three rules the file is built around

**One Save, no publish.** `SIMPLIFICATION-SPEC.md` Q4's default is that a coach never meets the word
publish. Save writes the offer draft and then publishes it, and confirms the publish from the
receipt rather than from a 200, so "Changes go live when you save." is a claim the code keeps.

**Everything on the page is one edit.** Questions, keyword goals and the offer layer are three write
paths. A screen with one Save bar cannot have two of them writing on click while the third waits, so
every control buffers into local state and Save flushes all three, collecting failures per area. A
refused write names what did not save and says nothing else was changed.

**Nothing here queries.** The offer layer, the merged question library and the objections rollup all
arrive from `page.tsx` as props, because all three are tenant-scoped and the browser has no business
naming a tenant for them. A refused read stays null and the panel says it could not read, which is
not the same claim as an empty library.

### Departures from the board, and why

- **Seven follow-up touches, not three.** The board draws three at a day, three days and a week.
  `DURABLE_TOUCHES` fixes five at 2h, 1d, 3d, 7d and 14d plus two window-bound touches, and the
  card's whole claim is that the platform owns count and timing. Building the board's three would
  have made the card lie. The audit already flagged the board's figures as inventions.
- **Each touch stacks its sentence over its field.** The board runs them inline on a wrapping row,
  which works there because its timings are three short invented phrases. Real timings read like
  "22 hours before the reply window closes", so an inline row breaks on some touches and not on
  others and the card becomes a ragged stack of half-lines.
- **The four cards flow row by row through a `display: contents` wrapper.** Two real column boxes
  put both short cards above the one tall card and left half a screen empty under them. The board's
  own grid is row-major; this reproduces it without reflowing the whole block.
- **Proof moved into "What SetterFi handles for you".** Spec 2.4 demotes the proof editor to an
  intake request, but `workspace-round4.test.ts` R4-20 pins exactly one renderer of proof at this
  file. Deleting the panel would have left zero. It now reads under the statement about what the
  agent may claim, which satisfies both the guard and the spec.
- **A local `LoggedNote` instead of `LoggedButton`.** The kit's caption uses `.text-over`, which is
  `text-transform: uppercase` and banned on coach by spec section 5. The note carries the registry's
  `ariaLabel` so the accountability is unchanged, and reads "Every save is recorded." so the coach
  never meets the word publish through the microcopy either.
- **A program-name guard the board has no field for.** The board dropped the field but
  `validateCoachOfferDraft` still requires it. With no program name the bar says so in words and
  Save is disabled, rather than letting a press fail at the boundary.
- **Two-way choices are grouped, not binary.** Credit repair and refunds are four-value enums behind
  the board's two sides. Pressing the side already selected leaves the stored shade alone, so a
  coach who never touched the control cannot silently rewrite what an onboarding call recorded.

### Three full-width bands (2026-09-04, follow-up)

The third column is gone. The page is now three bands: the four editable cards as a two-by-two grid
across the full content width, then Top objections and Keywords and questions side by side at half
width each, then What SetterFi handles for you full width. At 390 all seven panels stack in that
same DOM order.

Pairing the two list panels is what fixes the rail. Both grow with the same kind of content,
objection rows against keyword and question rows, so their heights track each other on a populated
tenant. A rail in its own column had no such partner: stretched to the height of the card block it
opened a 700px hole between its rows and its closing line, and left short it read as a ragged stub.
Objections keeps its closing sentence on `margin-top: auto` and Keywords keeps its add control on
the same, so both panels close on their footer whatever height the row settles at.

### Equal-height cards (2026-09-04, follow-up)

Both grids dropped `items-start`. `.coach-panel` is already a flex column whose body is `flex: 1`,
so a stretched panel fills its cell with no further help and two cards in a row end level, instead
of the prices card finishing 160px above its neighbour.

The prices card also carries `flex-1` on its body and `mt-auto` on the dashed add control. It is the
shortest card in its row, so once the grid stretched it the add would otherwise have sat halfway up
with a void beneath it; anchored to the bottom it reads as the card's own footer at any height.

At 390 nothing changes, which is the expected result: the grid is one column there, so every card is
already content-height and stretch has nothing to do. Verified in light and dark at 1440 and in the
single column at 390.

### Backend gaps found

None new. Prices, bounds, voice, cadence purposes, keyword goals, question order and skip state, and
the objections rollup all had a read and a write, and all are wired. Two notes for round 2: the
objections read returns a null `bookedRate` whenever no approved definition exists, which the rail
draws in words rather than as a bar, and `save-and-publish/handler.ts` currently fails to compile
against a missing `@/app/api/coach/offer/keys`, so this page saves through `PUT /api/coach/offer`
followed by `POST /api/coach/offer/publish` instead.

### Shared rules this needed and could not make

- **A horizontal `--coach-bubble-reserve`.** The token reserves the launcher's corner as page
  padding, which keeps a document-flow page clear of it, but a bar pinned to the viewport bottom is
  not in that flow, so the 60px launcher at its 32px offset lands on Save. The save bar carries its
  own right padding for now. `coach.css` wants a rule for sticky footers on coach.
- **A 48px coach button in the kit.** Same gap the Setup lane recorded. This file writes its own
  accent and secondary faces.

### Measured in Chrome against the dev server, seeded demo coach

Light and dark at 1440x900, light at 390x844, full page. No text node under 14px. No pressable
element under 44px. Exactly one accent fill in view, the Save button. No uppercase. Page
`scrollWidth` equals `clientWidth` at 390. No console errors.

Screenshots: `coach-agent-1440-light.png`, `coach-agent-1440-dark.png`, `coach-agent-390-light.png`
in the round's scratchpad.

### Verification limit

The `/login` "Sign in as coach" button lands on tenant `87000000-...-0001`, the phase 7 measurement
workspace, which has zero `offer_layers` and zero `keyword_goals` rows. The seeded offer layer,
keywords and questions sit on `81000000-...-0001`, whose only coach account is
`phase1-demo@example.invalid` and cannot be signed into. `seed-demo-gaps.mjs` already documents this
drift in its own comments. So the live pass verified the empty state honestly on every card, and
populated rendering is covered by the 31 fixture-driven tests beside the component rather than in
the browser. Seeding the login coach's tenant would move shared demo data while seven other surface
agents are verifying against it, so it was left alone.

---

## Inbox, what shipped

Built from `design/coach/Inbox.dc.html` against section 3 of `docs/plans/2026-09-04-coach-visual-audit.md`
and the Conversations block of `docs/plans/2026-09-04-coach-mobbin-research.md`. Files:
`src/components/workspace/rehaul/coach-inbox.tsx`, its two test files, and
`src/app/(workspace)/coach/conversations/page.tsx`.

**One bar, then three panes.** The page has no title of its own beyond a screen-reader `h1`, which
is the artboard: the 32px heading the audit measured as the only coach page not at 46 is gone
rather than resized, and the row it stood in now carries the whole control set. Three views as
links (`?view=needs-you|agent-handling|everything`), one search box, one channel filter, and the
context eye at the coach's own 46px scale, which it now inherits from `CoachContextEyeSurface`
instead of passing `placement="header"` and landing at owner scale as it did before.

**The agent toggle is the fix the audit put first, and the first attempt at it lied.** The old
control was a 111x46px slab with foreground equal to background, measured at 1:1 contrast, labelled
"Take over". The rebuild made it a 52px labelled switch, and the review caught the switch reading
"Your agent is answering", on and green, over a thread whose own transcript said the agent had
stopped and would not resume. The switch was reading "nobody has taken this" rather than "the agent
is running it".

The states are three, not two, and `bandControlFor` now derives which from `status` alone.

| the thread | the band | pressing it |
|---|---|---|
| the agent is running it (`agent`) | switch, on, good family, "Your agent is answering" | `claim` |
| you are running it (`human`, you hold it) | the same switch, off, warning family, "You are answering" | `release` |
| a handover rule stopped it, nobody holds it (`needs_human`, `scope_blocked`) | a button, warning family, "Answer this yourself" | `claim` |
| someone else holds it (`human`, not you) | switch, off, disabled, "Someone on your team is answering" | nothing |
| `closed`, `opted_out` | the fact in words, nothing pressable | nothing |

The third row is a button rather than a third switch position because the backend decides it:
`release` refuses an empty `expectedHolderId`, so an escalated thread nobody holds cannot resume,
and `claim` is the only write the route accepts. A switch there would either sit on while the agent
is stopped, or sit off and refuse to move when pressed. The band still offers exactly one pressable
thing in every state, the state is always the truth, and the reason the agent stopped stays in the
transcript's centred line, so the state and the reason are each stated once.

The composer's placeholder follows the same reading: "Turn your agent off to reply" only where the
agent is actually answering, "Take this thread to reply" where it has stopped, and the closed and
opted-out threads say so instead of inviting a write that would be refused.

`coach-inbox-toggle.test.tsx` still pins the structural half of the original defect, that the
control's class list names one background and one text colour and that they are different tokens,
now across all three drawn arms.

**The transcript is the audit trail.** Lead left on `--raised` with `--shadow-card`, agent right on
`--accent-wash-strong`, both at 16px ink with the sender and the time under them at 14px, which is
the Plain byline rule from the research and the opposite of the seven near-black fills the audit
counted. Handovers are centred system lines carrying the named line `claim_conversation` now
writes; the viewer's own most recent takeover reads "You joined the conversation, 2:14 pm", which
is the Pipedrive shape verbatim. The agent's stop reason is a centred line naming the recorded
handoff rule, never a stock sentence about prices. Internal notes render as their own centred
block saying only the coach sees them.

**The composer is two tabs over one field.** "Reply to <first name>" and "Note to yourself" write
through the two write paths that already existed, `sendHumanReply` and `send_human_message` with
`kind=internal_note`. The quiet-hours refusal is now answerable: the 409 the route returns puts its
own sentence under the field and a secondary "Send it now anyway" beside it, rather than printing
an error a coach cannot act on.

**The rail is facts.** Credit range, funding goal, timeline, questions answered, decision and
booking, with no controls at all. The three buttons in three treatments and the 240px of dead space
the audit measured are gone, and so are the two disabled buttons that were never wired to a route.
It hides behind the band's one chevron, which stays in place as a 76px strip so the same control
brings it back.

**Deliberate departures from the board.**

- **The board draws no export and this screen no longer has one.** The old surface carried the
  server `ExportMenu` the console had. The bar the artboard draws is three views, a search box and
  a channel filter, and a fourth control competing in that row is what the simplification spec cut.
  Flagged rather than smuggled: if the conversations export has to live somewhere, it needs a home
  the board has drawn.
- **The views are in the URL; search and the channel filter are not.** One control owns one piece
  of state, so the page no longer reads `?q=` and `?channel=` into a server filter that a client
  control also wrote. Search and channel narrow the loaded set instantly; the view is a link,
  because a coach shares a lane and not a search.
- **One read, not one per view.** `listConversationSet` takes a `view` and filters in the query,
  which is the right shape for a caller that wants one lane. This screen prints the size of the two
  lanes it is not showing, so a filtered read would need a second and a third round trip to count
  what it did not fetch, against the playbook's own measurement of 300 to 360ms per bare Supabase
  round trip. The set is read once and the view boundary comes from `conversationViewStatuses`,
  the repository's own lookup, applied on the server. If a tenant ever outgrows one read, the
  filtered read plus a count function is the replacement, and the count function does not exist.
- **The lane pill drops in both single-lane views, not just Needs you.** Agent handling is also one
  lane, and a pill saying "Agent handling" on all 62 of its rows is the same defect the brief named
  for Needs you. Only Everything mixes lanes, so only Everything says which.
- **The rail's "Questions answered" counts four.** `ConversationRead.qualification` carries credit,
  goal, timeline and business, so the denominator is 4 and the row says so. The artboard's "4 of 6"
  needs the size of the agent's own question set, which is not on this read.
- **The composer is disabled while the agent holds the thread**, with the placeholder saying "Turn
  your agent off to reply". Both write paths require `expectedState: "human"`, so a field that
  looked ready would fail on Send. The artboard's "Type your message" is the placeholder in the
  state the artboard draws, which is the thread the coach already holds.
- **On a phone the bar goes with the list.** The list hands the screen to the thread on selection,
  and three rows of list controls above a pane that is not on screen cost the transcript half its
  height, so they hide with it. The back control brings both back.

**Local workarounds a shared rule would have solved better.** `coach.css` was frozen for this
round, so three things are written into the component that arguably belong to the sheet.

- The phone tab bar's reserve. `coach.css` resets `main#main` padding to `var(--s-6)` on a
  `data-layout="fixed"` page, which is correct for the desktop but leaves nothing under the
  composer for the fixed 56px tab strip, so this page pads its own root by 72px plus the safe-area
  inset below `sm`. A `@media (max-width: 639px)` arm on that same rule would carry it for any
  future fixed-layout coach page.
- The support launcher's corner. The sheet's 108px `::after` inside every `overflow-y-auto` region
  of a fixed page is right for a list and wrong for a transcript, whose scroll region does not end
  at the screen: the composer does. The transcript uses `overflow-auto` to opt out and the composer
  reserves the corner with padding instead, 84px on a phone and 108px below `xl`, dropping to 28px
  at `xl` when the rail is open and holding that corner itself.
- The 48px button. `kitButtonClass` tops out at 34px, so Send and the quiet secondary are written
  locally, the same note `coach-agent.tsx` and `coach-billing.tsx` already record.

**Backend gaps hit, for Codex round 2.**

- **No question-set size on the conversation read.** The rail can only say "3 of 4 answered" off
  the qualification block. The artboard's "4 of 6" needs the count of enabled questions in the
  tenant's own set, which `coach-questions.ts` has and `ConversationRead` does not.
- **No lane counts without reading the lane.** There is no count-only path for
  `CONVERSATION_VIEWS`, so the tab figures cost a full-set read. A `countConversationsByView`
  returning the three sizes in one round trip would let this page take the server-side view filter
  and stay at one trip.
- **The live conversation summary is still absent**, as round 1 recorded. The rail states facts
  and no summary; nothing on the screen pretends otherwise.
- **`qualification.business` is read and not drawn.** Round 1 added it for the rail and the
  artboard's rail does not list it. It counts toward "questions answered" and nothing else, so if
  the business stage should be a visible row, that is a board change rather than a code one.
- **Older threads carry the pre-migration handover line.** Seeded rows still say "A person joined
  this conversation." with no name; the named line only appears on takeovers written since
  `20261012000003`. The screen renders whichever it finds rather than rewriting the old ones.

**Measured in Chrome against the dev server, seeded demo coach.** 1440x900 and 390x844, light and
dark. No text node under 14px in the page's own content at either width; the only sub-floor text at
390 is the shell's own 13px phone tab bar and its 12px count. No pressable element under 44px
except the shell's "Skip to main content" link. Exactly one accent fill in view, on Send, beside
the active navigation pill. Page `scrollWidth` equals `clientWidth` at 390 in all three phone
states: list, thread and the lead-details sheet. The transcript opens on the newest message, which
was checked as a scroll position rather than read off a screenshot, because a full-page screenshot
of a viewport-owning page renders the pane from the top whatever its scroll offset is.

Screenshots in the round's scratchpad: `Inbox-1440-light.png`, `Inbox-1440-dark.png`,
`Inbox-1440-agent-handling.png`, `Inbox-1440-everything.png`, `Inbox-390-light-list.png`,
`Inbox-390-light-thread.png`, `Inbox-390-dark-thread.png`, `Inbox-390-light-sheet.png`.

**One guard row deleted outside this lane.** `coach-mono-labels.test.ts` carried a `SCREEN_DEBT`
row for `coach-inbox.tsx` naming "not asked yet, not readable, not yet". The rebuild took every
mono label off this screen, and the guard's own last assertion fails on a debt row for a clean
file, so the row went with the labels.

**One shared constant taken rather than retyped.** The thread's title is the title-led card's
title, 22px/600 at -0.015em, and it was spelled out here until `deck-panel.test.tsx` caught the
fork. It imports `TITLE_PANEL_TITLE_CLASS` from `@/components/kit/deck-panel` now, so the leading
is that file's 1.25 rather than this file's 1.2 and the two cannot drift.

## Onboarding, what shipped

The six-step setup rail at `/onboarding` and its six sub-routes were rebuilt against
`OnboardingOverview.dc.html`, `OnboardingStep.dc.html`, `OnboardingConnect.dc.html`,
`OnboardingGoLive.dc.html` and `OnboardingStepMobile.dc.html`. The live components now sit under
`src/components/onboarding/`, not `src/components/workspace/rehaul/`; the rehaul onboarding modules
are left on disk and unmounted rather than deleted, because they belong to another lane.

**The counter Note 3 recorded, closed by construction rather than by a corrected number.**
`stepsDone(rows)` counts the same array `rows.map(...)` renders, so the numerator and denominator
are two readings of one list and cannot be edited apart. The headline, the rungs and the resume
button all come out of `onboardingSteps(evidence)` in one pass.

**Which read each rung makes, and why they are not all one table.** The first pass read every
non-channel rung off `provisioning_steps` and the demo coach broke it immediately: their
`calendar_connections` row is `ready` and there is no `calendar_connect` provisioning row at all,
so the rail said "waiting on you" over a step screen that said "availability verified". The
provisioning table records what the worker did; the connection tables record what is true. Each
rung now reads the same row its own step screen reads.

| Rung | Read |
| --- | --- |
| Business profile | a `business_profiles` row for the tenant |
| Connect Instagram and Messenger | `listChannelConnections`, `state === "live"` only |
| Texting eligibility | `loadCoachA2pRegistration` through `carrierReviewFrom` |
| Calendar | `calendar_connections`, `is_primary` true and `state === "ready"` |
| Your offer | `createOfferLayerRepository().loadOffer({ status: "published" })` |
| Go live | `provisioning_steps`, `step_key = "go_live"`, `state === "done"` |

The connect step's calendar row and the calendar step's own verified state read that same
`calendar_connections` row, so three surfaces cannot disagree about whether a calendar is
connected. A read that fails is `null` and renders as "We could not check this" in the pill and
"Some of your setup could not be read just now" in the headline. It is never a zero.

**Coach Home reads something different, and now says so in different words.** `/coach/home` prints
"N steps are waiting on you" from a count of `provisioning_steps` rows in `blocked`, which is the
worker refusing a step, not the coach not having reached it. On the demo coach that read lands on
one while the rail's unfinished count lands on five, on the same afternoon. Both sentences are
true about their own fact and neither is wrong, so the fix inside this lane was to stop them
sharing a sentence: the rail says "Five steps are still yours to finish" and leaves "waiting on
you" to Home. `coach-dashboard.tsx` is not in this lane's ownership. If one lane later owns both,
the honest merge is for Home to draw the blocked count as a named exception ("Texting eligibility
is blocked") rather than as a bare number that reads like progress.

**The 390 overflow, defect 9.** The old `onboarding-shell.tsx` packed a mark, five dots, a mono
"Step 2 of 5" and "Save and exit" into one non-wrapping 76px flex row, giving every sub-route a
`scrollWidth` of 416 against a `clientWidth` of 390. The header now carries the mark and the
context eye only; the position moved into the page as words under a hairline rail, and the
Continue button becomes a sticky full-width footer at 390 out of the same DOM node that is an
inline row above `sm`. There is no tab bar on a step.

**Deliberate departures from the boards.** The step header omits the board's bell and account chip:
a step is a task, and neither control does anything on it. The business profile step draws ten
fields where the board draws four illustrative ones, because the carrier registration needs all
ten and a form that collects four of them would fail at filing. Go live keeps its primary button
refused, not hidden, while anything is outstanding, and it paints no accent fill in that state, so
the one-fill rule reads as zero fills on that route rather than one.

**Measured on the demo coach, signed in, at 1440x900 and 390x844.** Every one of the seven routes:
`scrollWidth` equals `clientWidth`, no text node under 14px, no pressable element under 44px, and
exactly one accent fill except go live, which has none while the action is refused. Screenshots in
the round's scratchpad as `onb-{root,profile,connect,sms,calendar,offer,golive}-{1440,390}-light.png`.

**Two guard debt rows went stale outside this lane's ownership.** `coach-mono-labels.test.ts`
carries `SCREEN_DEBT` rows for `rehaul/onboarding-calendar.tsx` and `rehaul/onboarding-sms.tsx`.
Those files are no longer reachable from any route, so the guard's "no debt row for a clean file"
assertion now names them. The file sits under `src/app/(workspace)/coach/`, so the rows were left
for the lane that owns it to delete.

## Chrome and settings, what shipped

Boards: `design/coach/AccountMenu.dc.html`, `Notifications.dc.html`, `SupportBubble.dc.html`,
`Tips.dc.html`, `NotFound.dc.html`. Audit sections 8, 9 and 10; spec sections 2.7, 2.9 and 2.10.

**The account menu.** `app-topbar.tsx` fell through to the sheet for every non-affiliate role, so a
coach pressing their own name got the console's account panel. The sheet branch is now `admin` only
and hard-codes `variant="owner"`; coach reaches the dropdown. The menu is the board's: Tips and
trainings, Billing, Settings as one block at 44px rows, an Appearance segmented control under a
rule with Light, Dark and System in one trough, and Sign out alone at the bottom. Help and Account
security are gone from the coach's copy of it; the console's menu is untouched. The popup is
stamped `data-shell-role="coach"` because Base UI portals it to `document.body` and every rule in
`coach.css` is scoped to that attribute. The menu header now runs the account's own name and
workspace through `displayName` and `displayText`: the console answers the seeders' marker with a
Demo pill beside the name and the coach shell has no such pill, so `(demo)` would have been the
only demo signal on the screen and it would have been sitting inside the person's own name.

**Settings.** One page, one question. `Where do you want to be told?` as three large choice rows,
Email, Text and Both, bound to `GET` and `PUT /api/coach/notification-preference`, then a list of
statements of what SetterFi already sends with nothing pressable in it. The 29-notice, 58-checkbox
matrix is gone and with it the audit's 42 accent fills; the page spends one, on Save. Text and Both
render as `Not ready yet` and refuse to be picked, because `claim_notification_deliveries` still
only claims email: there is a preference store and an audit trail behind SMS and no delivery worker
at all. A preference already stored as text or both still renders as chosen, so the screen never
misreports the account back to its owner. A preference the route cannot read is said in words where
the answer would be rather than drawn as an unpicked group.

**The support bubble.** It was a menu of three canned questions; it is now the conversation. It
opens on the newest thread, heads it with the person who actually answered, derived from whoever in
the thread is not the coach who opened it, and carries one field, Send, and links to the guides and
to Tips. The read happens on open rather than on mount, because the bubble is on every coach page
and a read on mount is one Supabase round trip per navigation for a panel most coaches never open.
Only what the server hands back is rendered; a message that exists in this browser alone is the one
thing a coach must not be shown as sent.

**Tips and trainings.** Six equal cards, each duration in the header band's meta slot in mono and
one named action in the body. The featured hero, the play tile and the search box are gone. There
is no trainings repository and no route that serves a catalogue, so what ships is the real head and
an honest absence at 20px in a real panel, with the card shape behind a `trainings` prop.

**Help.** The route keeps its path, because the bubble links to it and `workspace-navigation.test.ts`
asserts it, and its title is now `Guides`. The two-pane centre is gone: no composer, no tabs, no
thread selection, no export. What remains is the guides list the bubble points at, which states its
own absence because no coach guide catalogue exists anywhere in the tree, and a read-only record of
what the coach has already asked. The record is a deliberate addition to the board: the bubble
shows only the newest thread, and a coach with more than one would otherwise lose the rest.

**Departures from the boards, and why.**

- **The launcher is 60px, not the board's 56px.** `coach.css` sets
  `--coach-bubble-reserve: calc(32px + 60px + 16px)` and `coach-kit-boundary.test.ts` asserts
  `h-[60px] w-[60px]` against it. The stylesheet is frozen this round, so the button matches the
  reserve rather than the drawing.
- **No "Usually replies within the hour" and no "Open until 6pm".** Nothing in the codebase or the
  copy files records an SLA, a first-response target or staffed hours. Either sentence would be the
  product committing a support team that has never agreed to it. A test holds the absence.
- **Settings prints no email address, no carrier day count and no card number.** No coach-reachable
  read returns the address; "day 14 of about 21" is a predicted date rather than a fact; the card is
  Billing's to state. All three are plausible inventions, so a test asserts none of them appears.
- **Not found is served by `src/app/not-found.tsx`, not by a coach segment file.** A nested
  `not-found.tsx` under `(workspace)/coach` only renders when something in that segment calls
  `notFound()`, and nothing does, so the one written for this round was dead code and was deleted.
  The root file already draws the board's heading and sentence at coach density and is role-aware,
  but it prints a mono `404` above them and offers two recovery links where the board asks for no
  code and one button. It serves three roles and is outside this lane's ownership, so the change is
  left as a decision: gate the figure and the second link on the coach role.

**Backend gaps, for Codex round 2.**

- **No SMS delivery.** `claim_notification_deliveries` claims email only. Until a worker exists,
  Text and Both stay unpickable and the audit trail behind them records intent nobody can honour.
- **No coach-reachable read of the coach's own email address.** The Settings board names the
  address the notices go to and nothing on a coach route returns it.
- **No A2P registration read on a coach route.** The board prints how far through carrier review
  the tenant is. Without a read, a day count would be a guess with a date attached.
- **No coach guide catalogue.** `lib/admin-help-guides.ts` is operator runbooks whose own docblock
  says a coach must never see them. Guides is a real surface with no content behind it.
- **No trainings store.** Same shape: `src/lib/repositories` has no trainings table, nothing under
  `src/app/api` serves one, and the intake never asked the client where the videos would live.
- **Support threads have no unread state.** The launcher cannot say a reply is waiting, so it says
  nothing rather than a count it would have to invent.

**Shared rules needed and not made.** The kit floor is frozen, so two rules were worked around
locally rather than written: the 48px control height, which `kitButtonClass` tops out at 34px for,
restated in every coach file that needs it; and the segmented-control trough, which is written with
Tailwind arbitrary values carrying `!` to beat two-class specificity from `coach.css` and would be
one `.coach-segmented` rule in the stylesheet.

**Guards this round invalidated.** One row deleted, the rest reported. `coach-type-floor.test.ts`
listed the support bubble in `ATTESTED_SURFACE_TITLES` as carrying `COACH_SURFACE_TITLE_CLASS`,
citing a 20px/600 header line the current artboard no longer has: the panel is headed by the name
of the person answering, at 17px/500 over a 14px status, which is a person rather than a surface.
The role left the surface, which is the first of the two outcomes that register's own failure
message names, so the row went with it. It named this lane's own file and nobody else's.

Two more are round-level and were left alone, because their positive controls and debt rows span
several agents' files at once. `coach-mono-labels.test.ts` requires `data-table.tsx` to stay
reachable from a coach route as its positive control, and the Settings rebuild removed the last
coach path to it; its count control now needs more than five findings and has exactly five; and it
carries five stale `SCREEN_DEBT` rows, for `meet-your-agent.tsx`, `leads-surface.tsx`,
`coach-billing.tsx`, `onboarding-calendar.tsx` and `onboarding-sms.tsx`. `coach-shared-type-floor.test.ts`
has the same shape: `anyMounted.length > 5` with `DataTable` required present, and seven stale
`SHARED_MOUNT_DEBT` rows for `Callout`, `DataTable`, `KeyValueList`, `MonoMeta`, `QueueItem`,
`SettingRow` and `StatusAbsent`. Both files' real assertions pass; only the controls and the
registers are stale, and both need one pass at the end of the round rather than eight partial ones.

**Measured in Chrome against the dev server, seeded demo coach, light theme.** 1440x900 and
390x844, full page. Settings, Tips, Guides and the 404 each have no text node under 14px and no
pressable element under 44px; the only sub-floor text at 390 is the frozen kit's own 13px phone tab
bar and its 12px count. Exactly one accent fill in view on every state measured: Save on Settings,
Send in the open bubble, `Back to Home` on the 404, and none at all on Tips and Guides, which have
no verb to spend one on. The open account menu spends none. Page `scrollWidth` equals `clientWidth`
at 390 on all five surfaces and with the bubble open. The open bubble covers page content, which is
what a non-modal overlay panel does and what the board draws; the closed launcher sits inside the
reserved inset and covers nothing at either width.

Screenshots in the round's scratchpad: `chrome-settings-1440.png`, `chrome-settings-390.png`,
`chrome-tips-1440.png`, `chrome-tips-390.png`, `chrome-help-1440.png`, `chrome-help-390.png`,
`chrome-notfound-1440.png`, `chrome-notfound-390.png`, `chrome-accountmenu-1440.png`,
`chrome-accountmenu-390.png`, `chrome-bubble-open-1440.png`, `chrome-bubble-open-390.png`.

## Home, what shipped

`/coach/home` is rebuilt against `Main.dc.html`, `HomeFirstRun.dc.html`, `HomeMobile.dc.html`,
`Loading.dc.html` and `ErrorState.dc.html`. The surface is now four modules rather than one: the
composition and the setup rail stay in `coach-dashboard.tsx`, and the date range control, the six
bubbles, the six-month bars and the keyword table each moved to a `coach-home-*` module beside it.

**The live composition.** Greeting, one status sentence, and the range control on the same row.
The sentence is prose assembled from reads that exist: which channels are live, and what day of the
carrier's typical window a text registration is on. The six bubbles are a three by two grid with one
anatomy each, a band carrying an eyebrow, a name and at most one action, then the figure, then a
two-line sentence slot, then a two-row footer. Every card in a row is the same height because the
sentence slot and the footer rows carry minimums rather than content-sized boxes: measured at
1440x900 the rows come out 354/354/354 and 241/241/241.

**Only footers the measurement can pay for.** `read_coach_measurement` supports three footer rows
and no more: the show count under Booked calls off `coach.show_rate`'s numerator, the agent handling
and needs you split under Active leads, and nothing under the other four. The artboard's prior
period deltas, channel split and disqualification reasons have no reading anywhere in the evidence
model, so those rows are omitted and the card keeps its anatomy and its height without them. The
active leads split is the one row that states its own absence in words when the RPC does not carry
it, because it landed, was reverted and landed again during this round.

**The chart is two renderings, not two boxes.** The desk gets six SVG bars with all six months
labelled, the partial month solid and marked " so far", and a sentence saying how many days that
month has had, counted in the tenant's timezone off the composition's own `asOf`. The phone gets
the same six readings as HTML rows: month name, a bar that is a share of a full-width track, and
the count in its own column. An SVG scales its type with its viewBox, so a 1300 unit chart in a
330px column renders 15px labels at four pixels, and narrowing the viewBox only moves the problem
because the scale is still the column width over a constant. Rows are laid out by the browser at
the size they are written at, so the floor holds at any width. Under six monthly points the panel
prints how many months it has instead of drawing a shorter chart.

**The keyword table carries its denominators.** Every rate reads against the leads who sent that
keyword, printed on the row as "60 of 86 leads", and the "No keyword" row says which population it
covers instead. Rows under ten senders replace all three readings with the reason and their own
count. The count-versus-percent toggle and the four stage funnel sparkline are gone: a bar strip in
a 100px cell was the row's own numbers with none of their magnitudes, printed beside the numbers.

**Loading and failure.** `coach/home/loading.tsx` is a client component so the greeting is real,
read from `WorkspaceEnvProvider` above the boundary. Six bones for the six range stops, six panels
with real names and sentences and a bone only where the figure lands, and a sentence where the chart
lands rather than a chart-shaped block. `coach/error.tsx` is one panel, one amber lead tile, one
sentence and one Retry; the second link and the trailing footnote are gone and the footnote's claim
merged into the sentence.

**Measured in Chrome against the dev server, seeded demo coach.** 1440x900 and 390x844, light and
dark, full page, with the demo setup override off and on. No text node under 14px and no pressable
element under 44px inside the surface at any of those. Page `scrollWidth` equals `clientWidth` at
390. Exactly one accent fill on the live composition, the active navigation pill, and two on the
first run, the pill plus the rail's one primary, which the vocabulary allows. Document height at
1440x900 is 1648px against the 900px viewport, so the audit's "two thirds of the page is empty"
finding is closed. The loading boundary was measured under a temporary nine second delay and the
error boundary under a temporary throw, both removed.

Screenshots in the round's scratchpad: `home-v2-live-1440-light.png`, `home-v2-live-1440-dark.png`,
`home-v2-live-390-light.png`, `home-v2-live-390-dark.png`, `home-v2-firstrun-off-1440-light.png`,
`home-v2-firstrun-off-1440-dark.png`, `home-v2-firstrun-off-390-light.png`,
`home-v2-firstrun-off-390-dark.png`, `home-v2-firstrun-on-1440-light.png`,
`home-v2-firstrun-on-390-light.png`, `home-v2-loading-1440-light.png`,
`home-v2-loading-390-light.png`, `home-v2-error-1440-light.png`, `home-v2-error-390-light.png`.

**Still open for the backend.** The hosted demo tenant returns no keyword rows at any window, so
the table renders its empty sentence in the browser and only the unit tests exercise the populated
shape. Prior period figures, a channel split, disqualification reasons and a fastest time to book
have no reading in `read_coach_measurement`, and each would pay for one more footer row.

## Note 6 (2026-09-04): integration

Eight surface lanes and two Codex rounds landed on `main` between `ee4db83` and `94e8b30`, one
commit per surface with an explicit file list. The shared guards were reconciled once at the end
rather than per lane (`fd4afb9`): the mono-label and shared-type-floor debt registers are empty of
files no coach route mounts, both positive controls now read `DeckPanel` because the Leads rebuild
took the coach's last table off `DataTable`, and `--measure-sentence` (56ch) joined `tokens.css`
so the lead lines written at 54 to 60ch can bind to a token instead of a literal.

Two rulings made at integration rather than by a lane:

- **Agent's layout is three bands, not two columns and a rail.** The board's right-hand
  objections rail either stopped after row one or, stretched, left a 700px void under two rows.
  The cards are a two-by-two grid, Top objections sits beside Keywords and questions at half
  width so two list panels grow together, and What SetterFi handles for you closes the page.
- **Inbox's thread band derives one control from `status`.** The switch read "nobody holds this"
  as "the agent is answering". A thread a handover rule stopped can only be claimed, so it gets a
  button, not a switch position; the table of states is in the Inbox section above.

Codex's mid-round `git stash` swept every lane's tracked edits once; the restore was file by file
from `stash@{0}` and nothing was lost. The rule for Codex rounds is now written into the prompt:
no git command that writes, on a shared checkout.
