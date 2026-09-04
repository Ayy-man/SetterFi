# Coach visual audit, 2026-09-04

A screen by screen pass over every coach surface, read against `docs/COACH-REDESIGN-PLAYBOOK.md`,
`docs/SIMPLIFICATION-SPEC.md` and the finished owner console. This is the input to the coach
redesign canvas.

**Method.** Headless Chrome against the dev server as the demo coach (`Sign in as coach`), every
screen at 1440x900 and 390x844 in light, plus home, agent and inbox in dark, all full page. Owner
Overview, Clients, Inbox and Money captured as the owner at 1440x900 for comparison. Geometry was
measured in the page rather than read off the pictures: computed font size of every visible text
node, bounding boxes of every interactive element, and the count of elements painted with
`--accent` or `--accent-fill`. The playbook says reading pictures is what made the first coach pass
fail, so every figure below is either a measurement or a source citation.

Screenshots: `/private/tmp/claude-501/-Users-aymanbaig-DEV-setterfi-client/f26284af-a375-4da9-9757-0676dd3ebb5f/scratchpad/audit/`
Raw measurements: `geometry.json` and `geometry2.json` in the same directory.

---

## The two findings that outrank everything else

**1. The Inbox agent toggle is invisible.** `/coach/conversations`, the button at x=941 y=76,
111x46px, label "Take over". Its computed `color` and `background-color` are the same value,
`lab(10.8495 -0.285514 -8.36813)`. Contrast is 1:1. It renders as a black slab with the word
"Logged" underneath it and nothing else. This is the single most important coach action in the
product by the spec's own reckoning (2.2, and R3-4 by name), and no coach can read it. Visible in
`conversations-1440-light.png` and, worse, in `conversations-390-light.png` where the same slab
lands on top of a lead row.

**2. Billing does not load.** `/coach/billing` renders "Billing details could not load" and
"Checkout status could not be verified. No payment session was created." on the demo coach. None
of the plan, the period, the allowance, the attendance question or the correction request is on
screen. Roughly 60 percent of the viewport below y=530 is empty grey. Whatever the redesign draws
for Billing has to be drawn against a working read first.

---

## Two densities: what the code actually does

The playbook's rule 11 table is the target. Measured, the coach side sits between the two:

| | spec target | measured |
|---|---|---|
| page title | 46px | 46px on ten of eleven coach pages, **32px on `/coach/conversations`** |
| body copy | 16px floor | 16px where `COACH_READING_CLASS` is used, 13 to 15px everywhere else |
| absolute floor | 14px, never below | breached on nine of eleven screens |
| interactive target | 44x44 | breached on six screens, 201 times on `/coach/pipelines` |
| accent spend | at most one filled action | one on eight screens, **42 on `/coach/settings`** |

The cause is structural rather than cosmetic. `src/components/workspace/live/coach-type.ts`
explains it in its own docstring: the `--t-*` scale is the owner console's, `--t-body` is 13px, and
a coach screen built out of `text-body` renders at console density however loud the shell's root
is. Five coach routes mount rehauled components that opt into `COACH_READING_CLASS`; six do not.

**Which route mounts what** (this is the real map of how far the rehaul got):

| route | component | rehauled |
|---|---|---|
| `/coach/home` | `rehaul/coach-dashboard.tsx` (1341 lines) | yes |
| `/coach/agent` | `rehaul/coach-agent.tsx` (2160) | yes |
| `/coach/conversations` | `rehaul/coach-inbox.tsx` (748) | yes |
| `/coach/contacts` | `rehaul/coach-leads.tsx` (446) | yes |
| `/coach/billing` | `rehaul/coach-billing.tsx` (724) | yes |
| `/coach/pipelines` | **`live/leads-surface.tsx`** | no |
| `/coach/integrations` | **`live/coach-integrations.tsx`** (1936) | no |
| `/coach/settings` | **`live/alert-settings.tsx`** (943) | no |
| `/coach/help` | **`live/coach-support.tsx`** (542) | no |
| `/coach/tips` | **`live/coach-tips.tsx`** (354) | no |
| `/coach/get-started` | `onboarding/get-started-checklist.tsx` | partly |
| `/onboarding/*` | `rehaul/onboarding-*.tsx` | yes |

The nav demotion itself is done and guarded. The pill bar carries five destinations, and
`workspace-navigation.test.ts:186` pins the demoted four staying reachable. What did not happen is
the second half of each demotion: Connections, Settings, Help and Tips are off the rail and still
full destination pages with their pre-rehaul chrome.

---

## 1. `/coach/home`

**What it is for.** The coach's landing screen: a greeting, what the agent is doing right now,
and the few figures that say whether it is working (`PRODUCT.md` coach dashboard; spec 2.1).

**What is on it now.** `rehaul/coach-dashboard.tsx`, mounted by
`src/app/(workspace)/coach/home/page.tsx:343` behind a dynamic import. It reads
`CoachChannelStatus` derived from `provisioning_steps` and `channel_connections`, the A2P
registration through `loadCoachA2pRegistration`, and the measurement projection for the window in
`searchParams`. On the demo coach it renders: h1 "Welcome, Reid" at 46px; a status line "1 step is
waiting on you"; the provenance line "Demo data, excluded from real analytics"; a two column body
with "Your setup" (an icon spine plus three step cards, counter "0 of 3 done") on the left and
"Your numbers" (three figure cards, Leads 67, Booked calls 17, Time to book 72 hr) on the right.
There is a `ContextEye` in the header carrying a 180 word methodology paragraph and the demo
override control (`home-eye-open-1440-light.png`).

**Defects.**

1. **Two thirds of the page is empty.** Content ends at y=640; the viewport is 900 and the document
   is 927. The region x=32 to 960, y=640 to 900 is blank. With the demo override on it gets worse,
   not better: the blocked card disappears and the empty region grows to y=530 upward
   (`home-demo-override-1440-light.png`). Note 1 item 5 called this the absence rule applied at
   page scale, and it is still unfixed. Rule 1 says state the absence; it does not say leave a
   third of a monitor blank.
2. **No trend chart and no keyword table.** Measured: `charts: 0`, `tables: 0`. Spec 2.1 keeps both
   as two of the four blocks, R3-2 and R10 asked for them by name, and the seeded data supports
   them (200 contacts over six months, per the reseed). Not started.
3. **Three figure cards, not six bubbles.** Each card is roughly 155px tall with the number in a
   band and 60px of nothing beneath the baseline. Note 1 item 6, unfixed.
4. **`72 hr` sets the unit at figure size in mono**, so "hr" reads as part of the number. The owner
   console's `5.8d` on Overview solves the same problem by keeping the unit inside the figure's own
   glyph run at the same weight, which is why it reads as one token.
5. **The step cards do not share an anatomy.** Card 1: eyebrow, name, "Not live yet" pill, an
   accent-filled button. Card 2: eyebrow, name, "Not filed" pill, no action at all. Card 3:
   eyebrow, name, amber "Blocked" pill, a ghost button. Note 1 item 2, unfixed.
6. **The header and card 3 state the same fact.** "1 step is waiting on you" at y=169 and "Blocked"
   at y=527. Playbook rule 4.
7. **Three words for one axis.** "Not live yet", "Not filed", "Blocked" are three vocabularies for
   three rungs of one setup. The owner console's Clients table uses one word per state from one
   list.
8. **`0 of 3 done` is mono at 14px**, used as a label rather than a number in a table. The
   simplification spec's do-not-include list names mono as a label.
9. **Two support entry points in view.** The "Ask us" button at (1305,189) and the floating support
   bubble at (1370,838). One state, two controls, playbook rule 6.
10. **The nav pill says "Overview", the page says "Welcome, Reid".** No heading on the screen
    carries the destination's name. `coach-pillbar.tsx:34-39` argues the label divergence for the
    phone bar; the desktop mismatch with the h1 is a separate thing.
11. **The icon spine still runs past its last card** under the override, where two icons thread two
    cards and the connector continues below the second.

**Inherit from the owner console.** Overview's composition is the answer to defect 1: a drenched
hero panel carrying the headline figure plus a `BarChart` strip inside it, a four-up stat row where
each card carries figure, delta and one sentence, then a two-up bottom row of one chart and one
decision list. It fills 1440x900 with real content and no filler. Also inherit Overview's honest
absence treatment: "no prior period recorded" printed where a figure would be, and a card that
measured nothing removed entirely rather than left as a label over blank space.

**Do not inherit.** The four-up stat row's density (13.5px labels, 30px expand chevrons), the
grouped rail, the command palette, or the `⌘K` chip. Coach figure cards stay large; what they need
is a second line under the number, not a smaller one.

**Spec status.** Greeting and status sentence: done. Date range control: not started, no window
picker is on the page. Six bubbles: partly, three cards exist. Trend chart: not started. Keyword
table: not started. Attention card removed: done. Allowance card off home (Q2): done. Get started
folded into a Home card: partly, the card links out to `/coach/get-started` rather than carrying
the steps.

**Phone.** Broken. `home-390-light.png`: in step card 1 the "Not live yet" pill paints on top of
the words "Instagram and Messenger" and the accent button is clipped mid-label at the card edge. In
card 3 the "Blocked" pill overlaps "Opt-in pages" and the "Fix this step" button wraps to three
lines inside a fixed box with the support bubble sitting on it. The fixed bottom pill bar paints
over page content mid-document. The card header row is a flex row that never wraps.

---

## 2. `/coach/agent`

**What it is for.** The four things a coach owns, and a statement of everything SetterFi runs
(spec 2.4, 4).

**What is on it now.** `rehaul/coach-agent.tsx` (2160 lines) with `live/coach-page-head.tsx`,
reading the offer layer repository, `readCoachQuestions`, `listCapiDatasets`,
`loadCoachA2pRegistration` and `resolveChannelCapability`. It is now a seven step ladder rather
than six tabs: Keywords, The resource, Questions your agent asks, How qualified are they, Book the
call, After they book, If they go quiet, with an icon spine down the left and a right rail of six
cards. Document height 2693px.

**Defects.**

1. **Save and Publish both still exist**, at (755,104) and (914,104), both disabled, with
   "Nothing published yet" under the h1. Spec 2.4 rules one Save and no draft lifecycle, and the
   do-not-include list names draft/published badges. Not started.
2. **Two uppercase 11px mono labels**, measured at font-size 11px, `text-transform: uppercase`,
   letter-spacing 0.935px: "OFFER DRAFT SAVE LOGGED" and "OFFER PUBLISH LOGGED". Spec 5 bans
   uppercase on coach surfaces and sets 14px as an absolute floor. Two violations in one string.
3. **The header band offers five pressable things**: a Ladder/Connections tab pair, "Test as a
   lead", Save, Publish and the eye. The canvas rule is that a band offers exactly one.
4. **The right rail is six near identical cards.** Five of them read "No X is saved, so your agent
   Y none." with an Export menu in each header band. Identical card grid over one repeated sentence
   shape is the slop pattern the brief names.
5. **An action collides with its own title.** "Export prices" at (972,638) overlaps the second line
   of "Prices your agent can quote". The `DeckPanel` band's `meta`/`action` slots do not reserve
   room for a two line name.
6. **The support bubble sits on content**, at (1017,622), on top of the prices card. This is the
   same defect `context-eye.tsx:41-47` records for the eye on the Inbox, fixed there by moving the
   eye into the header and never fixed for the bubble.
7. **Step 3 promises a control it does not offer.** The eyebrow reads "Step 3 · reorder or turn
   off" and the body reads "No questions are published yet." with no reorder affordance anywhere.
   This is playbook rule 3 in reverse: the label is making a claim the surface cannot honour.
8. **Mono microcopy as label**, at 13px: "Book a call", "Keep qualifying", "Turned away politely"
   under the Ready/Maybe/Not a fit trio, and "our default" repeated seven times down the Step 7
   column.
9. **The qualification rows are empty text inputs**, roughly 150x40px, with "unknown" set to their
   right. Spec 2.4 asks for six large stepper or two-way choice rows and no free text. Partly done:
   the six rows are right, the controls are not.
10. **Seven step cards each hold one sentence of absence** inside a card roughly twice the height
    of its content, which is what stretches the page to 2693px. Rule 1 is being obeyed at card
    scale and is producing the page scale problem again.

**Inherit from the owner console.** The record sheet pattern: a row states its value on its face
and opens to edit, rather than presenting an empty control permanently. Also the Clients table's
"Nobody owns this" treatment, which states an absence in the same slot at the same weight as a
value, instead of a card whose entire body is the absence.

**Do not inherit.** The eval playground's controls. `meet-your-agent.tsx` has three consumers and
the 2026-09-01 ruling stands: build coach playback additively, do not delete admin capability to
match a drawing.

**Spec status.** Six tabs to four cards: superseded by the 2026-09-02 ladder ask, and the ladder is
built. Your program and Marketing assets demoted to an intake request: done, they are not on the
page. Prices kept: done, in the right rail. Who qualifies enlarged: partly. How you sound kept:
done, a three stop slider is present. Follow-up simplified to one dropdown per touch: done. Stat
strip killed: done. Publish lifecycle to one Save: not started. Top objections rail: done.

**Phone.** Poor but not broken. The two column body stacks; the right rail's six cards fall below
2693px of ladder, so the objections rail is roughly four screens down. The Step 4 tri-column
Ready/Maybe/Not a fit footer squeezes three columns into 390px.

---

## 3. `/coach/conversations`

**What it is for.** The queue a coach works: threads needing a person, the conversation, and the
read only facts the agent learned (spec 2.2).

**What is on it now.** `rehaul/coach-inbox.tsx` (748 lines), mounted at
`src/app/(workspace)/coach/conversations/page.tsx:172`, reading conversations and messages for the
tenant with `STATUS_TO_LIFECYCLE` mapping status onto lanes. Three panes: list with two view tabs
and a search box, thread with a composer, and a "What your agent learned" rail.

**Defects.**

1. **The agent toggle is invisible.** See the headline finding above. 111x46px, label "Take over",
   foreground equal to background.
2. **The h1 is 32px**, the only coach page not at 46. Measured. Two densities on one side of the
   product.
3. **Two views, not three.** "Needs you 9" and "All". Spec 2.2 rules three: Needs you, Agent
   handling, Everything. Partly done.
4. **The eye is at owner scale.** Measured 32x44px at (338,121). `context-eye.tsx:52-58` names the
   two scales and says the coach app runs a 46px control row; this instance is running the owner's
   32.
5. **`(demo)` is printed roughly twenty times on one screen**: in every list preview, in every
   message body, and in the rail's title. `displayName` strips it from names, which is why the
   names read clean, but nothing strips it from message text. Playbook rule 4 and the "demo
   markers" trap, both named in the playbook.
6. **"Test data" is a pill on every one of the six visible rows**, beside a "Needs you" pill and a
   channel code, so each row carries three chips for facts that are constant down the whole list.
   The owner Clients table solves the identical problem with one `Demo` provenance chip per row and
   no repetition of the lane.
7. **Channel codes as mono micro-labels**: SMS, IG, WA, MSG at 13px mono. Mono as a label, and the
   codes are not words a coach uses.
8. **Agent bubbles are painted near black**, roughly `#0f1720`, seven times on one screen, against
   white lead bubbles. That is a heavy fill spent per message rather than the raised surface the
   owner Inbox uses.
9. **Three actions in the rail, three treatments**: "Book a call" and "Move to Not a fit" as
   full width ghost buttons, then "Move this lead on the board" as a 14px underlined link.
10. **Roughly 240px of dead space in the rail** between "Call booked, not yet" at y=500 and "Book a
    call" at y=746, and more below the composer.
11. **The support bubble sits on the rail's action area** at (1370,838).

**Inherit from the owner console.** Bubbles on `--raised` with `--shadow-card` rather than a
drench per message. The owner Inbox's empty state is also the model for a quiet lane: a centred
statement that fills its panel and counts what it is not showing ("Nothing in the three lanes is
waiting on a person. 1 notices were cleared in the last week."), rather than a shrinking panel.

**Do not inherit.** The owner Inbox's three lane header strip at 11px caps, and its 13.5px rows.
Coach rows stay tall.

**Spec status.** Seven views down to three: partly, it is at two. Objection cohorts demoted: done.
Filters merged to search plus channel: partly, search exists, no channel filter is visible. Bulk
select killed: done. Three panes kept: done. Lead details rail kept: done. Agent toggle enlarged to
44px: the height is 46 and the label is unreadable, so this is worse than not started. Composer
modes: the Reply and Internal note chips are not on the screen.

**Phone.** Broken, and the worst of the eleven. The three panes do not collapse. The thread header
"Kendra Eriksen / Text messages (SMS)" paints on top of the second list row, with the list row
visible behind it. The invisible toggle lands at (250,428) over the list. The composer's Send is
half covered by the support bubble and its "Logged" microcopy is cut. The lead details rail is not
reachable at all. The fixed bottom bar overlaps the composer.

---

## 4. `/coach/contacts` and `/coach/pipelines`

**What it is for.** One screen, everyone who has messaged, as a list or a board (spec 2.3).

**What is on it now.** Two routes, two different components, one nav pill. `/coach/contacts` mounts
`rehaul/coach-leads.tsx`; `/coach/pipelines` mounts `live/leads-surface.tsx`. Both read
`listContacts` and `listFollowups`. Pressing "Board" on the list navigates to a component that was
never rehauled, and the two disagree about everything: the list has four KPI cards, a "Display"
button and an Export menu; the board has a search box, a Filters button, a Download menu and a
third view called "Call back 43".

**Defects, list view.**

1. **Four KPI cards survive** (Open 109, Booked 36, Lost outcomes 55, Awaiting a decision 104).
   Spec 2.3 rules KILL the row, not reorder it a third time.
2. **No search box**, measured, despite a 15px paragraph above the table explaining in detail what
   search reads and does not read. Prose describing a control that is not there.
3. **Explainer prose on the page** in three places, with a `ContextEye` present on the same screen.
   Playbook rule 5.
4. **Text under the floor, 59 nodes.** The second line of every name cell is 12.5px mono ("Wants
   $50K to 100K", "goal not captured"), appearing 50 times. The stage column is 11.5 to 12.5px. The
   column headers are 13px. The "Display" button label is 12.8px.
5. **Column header sort buttons are 8px wide by 44 tall.** Five of them. An 8px hit width.
6. **A methodology footnote at 11.5px mono** under the table, 30 words about ordering.
7. **Every row carries a chevron and is itself clickable.** One state, two controls.

**Defects, board view** (`pipelines-top.png`, document height 8880px).

8. **The board clips.** At 1440 the "No show" column is cut mid card, with card text truncated
   mid-glyph, and the seventh column is entirely off screen with no scroll affordance drawn.
9. **The stage disabled state is stated four times in 160 vertical pixels**: an amber "Stage changes
   not switched on" callout, then "Stage changes are not switched on in this environment, so Move
   to is off.", then "Nothing has changed stage, and no lead was messaged.", then "Stage changes are
   not available yet." Playbook rule 4, four times.
10. **A stage legend of seven chips with counts sits 50px above a board whose seven columns carry
    the same names and the same counts.**
11. **The funnel is on the wrong screen.** "Where leads leak" with four tiles and drop percentages
    is analysis of how the agent is doing. R3-3, R11 and spec Q7 all put that on `/coach/agent`.
12. **The funnel states its own result three times**: a sentence above it, the tiles, and a sentence
    below it ("18% of the leads in view are booked. The biggest drop is between Decision recorded
    and Ready to book.").
13. **`−0%` is drawn as a drop.** Ready to book 36 to Booked 36 is not a drop, and printing a signed
    zero percent asserts a measurement that is really "no change". Playbook rule 1.
14. **A `<details>` under the figures**: "How these are counted: each lead's stage today, not the
    path it took". Collapsible methodology under a figure is on the do-not-include list, and there
    are two `<details>` on this page.
15. **201 interactive elements under 44px**, almost all of them the per card "..." menu at 28x44.
16. **174 text nodes under 16px**, and 304 nodes at exactly 14px.
17. **Card anatomy varies six ways**: some cards carry a goal and credit line, some a sentence
    ("Qualified, but did not book."), some an appointment time, some a "Stalled 13d" pill, some two
    of those, some one.

**Inherit from the owner console.** The Clients table is the model for the list: one search box, a
small set of named facet chips, a count ("24 of 24"), a Save view control, Export and the eye in the
header, one status word with one dot per row, and a `Demo` provenance chip rather than a suffix.
Also inherit its handling of an unknown owner, "Nobody owns this", which is a stated absence in the
value's own slot.

**Do not inherit.** 40px rows and 13.5px cells. The coach list already runs 84px rows, which is
right.

**Spec status.** Merge to one screen with a List/Board switch: not done, two components behind one
pill, and a third view added. Five KPI cards killed: not done, four remain. Eleven filters down to
search plus stage: not done on the list (no search), partly on the board. Merge/unmerge demoted:
done, neither is on the screen. Permanent delete demoted: done, "Tell us about a lead" is the only
request action. Kanban with larger cards: done. Export: done on both.

**Phone.** List works, in that it stacks and does not overlap, though the 12.5px second lines are
unreadable at arm's length. Board does not: seven columns in 390px with no horizontal affordance.

---

## 5. `/coach/billing`

**What it is for.** Plan, period, allowance, the attendance question, one correction request
(spec 2.8).

**What is on it now.** `rehaul/coach-billing.tsx` (724 lines) behind `phase6Live()`. On the demo
coach it renders two error blocks and nothing else. Document height 900, content ends at y=530.

**Defects.**

1. **It does not load.** "Billing details could not load. No subscription, invoice, allowance, or
   delivery value is estimated. No billing action was completed by this error state." with a Retry
   button.
2. **The failure is stated twice**, in the callout and again as "Checkout status could not be
   verified. No payment session was created." in red inside the subscription card, plus a third time
   as the "Checkout unavailable" pill. Three renderings of one fact.
3. **Roughly 60 percent of the viewport is empty**, and the page container's background changes tone
   at y=530, so the emptiness reads as a rendering fault rather than as a short page.
4. **The Retry button is 12.8px** and the "Checkout unavailable" pill is 11.5px, both under the
   floor.
5. **No accent-filled action in view.** "Ask us to change your plan" is a ghost button, and Retry is
   a ghost button, so the page's only recovery path has no visual priority.

**Inherit from the owner console.** Money's failure handling and its "Recurring revenue by month"
panel, which states the reading and the period together. More usefully, Overview's rule that a card
which measured nothing disappears rather than sitting as a label over blank space, applied here to
the whole screen: an unreadable billing state should compose as a first run page, not as the
ordinary page with its middle removed.

**Do not inherit.** Any cost, margin or model spend figure. The owner Money page carries those and
they are admin only.

**Spec status.** All of it blocked behind the load failure. Overlines killed: cannot tell. Plan
card, allowance, attendance question, "this count looks wrong": none rendered.

**Phone.** Same failure, stacked. No new break.

---

## 6. `/coach/integrations`

**What it is for.** Under the spec, it should not exist. Spec 2.6 kills the rail item and moves
channel state to the Home setup card plus one sentence when something breaks.

**What is on it now.** `live/coach-integrations.tsx`, 1936 lines, never rehauled. Off the rail and
still a full page: a four-up stat strip, five channel cards in a two column grid, and a prose panel.
Reads `listChannelConnections`, `listGhlInstallLocationsForTenant`, `listCapiDatasets`,
`listMessageTemplates`, `loadCoachA2pRegistration` and `metaOAuthStartAvailable`.

**Defects.**

1. **"SetterFi owns the next step." is printed four times**, once per channel card. Playbook rule 4.
2. **"Last message event / No activity yet" is printed five times**, at 12px mono. Under the floor,
   mono as a label, and the same absence stated five ways round.
3. **Five identical cards in a grid**, each icon, name, pill, two sentences, an inset and a footer
   line. The slop pattern.
4. **Explainer prose in three places on the page**: under the h1, under "Channels and calendar", and
   a four sentence closing panel of roughly 90 words. All of it belongs in the eye, which this page
   has, at (1385,183).
5. **"0 of 4" and "Checked Sep 3, 2026, 9:22 PM" in mono at 12px.**
6. **The "Check again" button is 12.5px.**
7. **The support bubble covers the WhatsApp card's inset** at (1370,838).
8. **Fourteen text nodes under 14px** by measurement.

**Inherit from the owner console.** System's treatment of per-provider state, where a provider is
one row with one word and a timestamp, not a card with a paragraph.

**Do not inherit.** Nothing on this page should survive as a coach surface. Reply windows,
connection history, last error and templates go to admin, per the spec.

**Spec status.** Rail item killed: done. The page itself, its 1500 words and its diagnostics: not
started. Channel state on the Home setup card: partly, Home carries three rungs and links here.

**Phone.** Works, in that the two column grid collapses cleanly and nothing overlaps. It is simply
very long.

---

## 7. `/coach/get-started`

**What it is for.** Spec 2.5 keeps the receipt-backed steps and the SMS day counter, enlarges them,
and demotes the technical record.

**What is on it now.** `GetStartedChecklist` from `src/components/onboarding/`. Off the rail, still
a destination. A channel strip, a "Right now" line, six numbered steps, and a receipts panel with a
`<details>`.

**Defects.**

1. **It counts six steps while `/onboarding` counts seven and `/coach/home` counts three.** Three
   surfaces, three denominators, one setup. This is Note 2 and Note 3's contradiction, still live
   and now three-way.
2. **Steps 2 and 3 are marked "Ready for you" and carry no action.** The coach is told a step is
   theirs with no way to start it.
3. **"Nothing for you to do" is printed three times**, on steps 1, 4 and 5, and "Owner:" is printed
   six times.
4. **The "Review go-live" button is 12.8px and disabled**, with "after step 5" set beside it as a
   separate fragment rather than as the button's own reason.
5. **The channel strip's connect affordances are 14px inline links**, not 44px buttons, and "This
   journey" dangles beside Text messages with no verb.
6. **Explainer prose under the h1** ("Six steps, in order. Three are with SetterFi and the carrier,
   and three are waiting on you.") duplicating the counter below it.
7. **Seven nodes under 14px**, including a 12px timestamp and a 12.5px "Not connected".

**Inherit from the owner console.** The Provisioning page's step treatment, where the owner of a
step and its evidence are one row rather than four stacked lines.

**Do not inherit.** Hashes and carrier decision codes on the face. Those are correctly behind "Show
the technical record" here already.

**Spec status.** Rail item demoted: done. Steps kept and enlarged: partly, they are kept and not
enlarged. Receipt detail behind "Show the technical record": done. SMS day counter kept verbatim:
present on `/onboarding/connect`, not on this page. Instructions and videos: not started.

**Phone.** Works. Stacks cleanly, no overlap.

---

## 8. `/coach/settings`

**What it is for.** Spec 2.7 reduces this to one question in the account menu: where do you want to
be told, email, text, or both.

**What is on it now.** `live/alert-settings.tsx` (943 lines), never rehauled, mounted directly by
the route with no `AppShell` page header. A delivery pair at the top, then 29 notices in eight
groups, each with two checkboxes.

**Defects.**

1. **The matrix is untouched.** 29 notices, 58 checkboxes, document height 5686px. Spec 2.7 is not
   started.
2. **The accent is painted 42 times on one page.** Measured. Every ticked checkbox is an accent
   fill. Spec 5 allows one filled accent in view.
3. **117 interactive elements under 44px**, the checkbox indicators measuring 16x16.
4. **"Required" appears eight times with a lock glyph beside each locked box.** The owner console
   hit this exact defect and fixed it with one counted sentence above the sections; the fix was
   never carried across.
5. **Section counts in 13px mono**, eight of them ("1 in the app · 6 by email").
6. **Explainer prose in three places**, including a closing footnote about there being no Save.
7. **No page title chrome.** The h1 is "Where should we tell you?" with a "Back to Home" link above
   it, so the screen has no destination identity and the pill bar shows no active pill.

**Inherit from the owner console.** The counted sentence pattern, exactly as landed: one sentence
above the groups stating how many notices are required and why, in place of a repeated pill and a
repeated glyph.

**Do not inherit.** The matrix at all. This is the clearest KILL on the coach side.

**Spec status.** Not started, on every point.

**Phone.** Works structurally. 5686px of checkboxes on a phone is its own verdict.

---

## 9. `/coach/help`

**What it is for.** Spec 2.9 demotes this to a floating bubble with the guides behind it.

**What is on it now.** `live/coach-support.tsx` (542 lines), never rehauled. Off the rail, still a
two pane destination with Support and Guides tabs, a request form, a thread list and a thread.

**Defects.**

1. **Two floating circles stack in one corner**: the support bubble at (1370,838) and a floating
   eye at (1362,1092). This page places the eye as `floating` while every other coach page places it
   in the header, so the corner carries two round dark controls 250px apart.
2. **Three support entry points on a support page**: the form, the bubble, and the thread reply.
3. **Two primary actions**: "Create request" and "Send reply", both accent, both in view.
4. **`(demo)` appears six times**: the sidebar item, the thread title, both author names and both
   message bodies.
5. **Explainer prose under the h1 and again inside the form card.**
6. **Eight nodes under 14px**, including 12.5px and 11.5px "Open" pills and a 13px "Subject" label.
7. **Roughly 400px of dead space** bottom right below the thread.

**Inherit from the owner console.** The owner Support page's thread anatomy, and its single Export
in the header rather than one per panel.

**Do not inherit.** Nothing structural. This page should stop being a page.

**Spec status.** Off the rail: done. Demoted to a bubble: not started, both exist at once. Guides
kept behind the bubble: partly, they are a tab on the page.

**Phone.** Works. Panes stack, no overlap.

---

## 10. `/coach/tips`

**What it is for.** R7's Tips and trainings, the coach's video library, reached from the account
menu.

**What is on it now.** `live/coach-tips.tsx` (354 lines). On the demo tenant it is empty: a dashed
440x170 box reading "No trainings have been published yet".

**Defects.**

1. **The empty state is 13px**, both the heading and the sentence. Measured. Under the absolute
   floor, on a page whose only content is that sentence.
2. **A dashed border box in a 1440x900 viewport with roughly 450px of grey beneath it.** The absence
   is stated, which is right, but at the scale of a form field rather than at the scale of the page.
3. **A two line explainer paragraph under the h1** while the page carries a `ContextEye` at
   (1385,236).
4. **The pill bar shows no active pill**, so the coach is on a page the navigation does not
   acknowledge.

**Inherit from the owner console.** The owner Inbox's empty state: a centred mark, a dated
statement, and a counted second sentence, sized to fill the panel it replaces.

**Do not inherit.** Nothing. This page is small enough to be drawn from scratch.

**Spec status.** In the account menu: done. Enlarged to the coach floor: not started.

**Phone.** Works.

---

## 11. `/onboarding` and its five sub-routes

**What it is for.** The setup companion a new coach lands on from the confirmation email: four pill
stages and five sub-routes (business profile, connect, texting eligibility, calendar, offer).

**What is on it now.** `rehaul/onboarding-shell.tsx` plus `onboarding-profile`, `onboarding-connect`,
`onboarding-sms`, `onboarding-calendar`, `onboarding-offer`. The root reads the fourteen step
provisioning contract and prints "3 of 7" confirmed. Chrome is different from `/coach/*`: no pill
bar, no support bubble, and the eye is floating rather than in the header.

**Defects, root.**

1. **"3 of 7" against Home's "0 of 3" and Get started's "Six steps."** Note 3 recorded this as a two
   way contradiction; it is three way.
2. **The visible step numbers skip.** The rail draws ticks for steps 1, 5 and 7 and circled numbers
   2, 3, 4 and 6, so a reader sees "2, 3, 4, 6" and concludes a step is missing. Same failure mode
   as Note 1's "0 of 3 done over four cards": honest, and reads as a bug.
3. **The accent is spent on an explainer.** The drenched blue panel "What happens when you press it"
   is the loudest object on the screen, while the actual go-live button beneath it is grey and
   disabled. Canvas rule: at most two drenched panels and nothing else fills. Here the one drench is
   on prose.
4. **"GO-LIVE LOGGED" at 11px uppercase mono.** Banned twice over.
5. **"Owner: you" four times, "Saved evidence confirmed, Sep 3, 2026" three times** at 12px.
6. **Explainer prose in two places under headings**, and this screen has no context eye at all, so
   there is nowhere for it to go.
7. **Roughly 700px of dead space** in the right column below "Not yet, take me back to my settings".
8. **Seventeen nodes under 14px**, including four 12.8px buttons.

**Defects, sub-routes.**

9. **All five overflow horizontally at 390px.** Measured `scrollWidth` 416 against `clientWidth`
   390, so the page scrolls sideways by 26px. The cause is the header row:
   `onboarding-connect-390-light.png` shows "Step 2 of 5" wrapping to three lines while "Save and
   exit" is pushed past the right edge, with a five dot rail competing for the same row.
10. **`/onboarding/sms-eligibility` carries seven drenched elements.** Measured. The canvas budget
    is two per screen.
11. **The eye is a floating dark circle** on every sub-route, which is the placement
    `context-eye.tsx:41-47` documents as the one with a known collision defect.
12. **`onboarding-connect` shows six accent-looking actions in one view** by label ("Connect
    Instagram", "Connect Facebook Messenger", "Send my details to the carrier", "Do this later",
    "Continue", "Save and exit"), and measured accent fills on that route are zero, so the primary
    path is unmarked in either direction.
13. **Key-value rows in mono, right aligned** ("Decided by / The carriers", "Starts at / Step 5"),
    which is owner console furniture on a coach surface.
14. **`business-profile`, `sms-eligibility` and `calendar` have no `<title>`** beyond "SetterFi",
    while `connect` and `offer` do.

**Inherit from the owner console.** Nothing directly. Onboarding's own root composition, which is
genuinely the best composed coach screen in the product, is what the other ten should inherit: a
real two column layout where both columns carry content to the fold.

**Do not inherit.** The owner's 13.5px density anywhere in this flow. Onboarding is where a new
coach forms their impression of whether the product is for them.

**Spec status.** The spec treats onboarding only obliquely. Note 2's open product question, whether
the companion survives or folds into the Home setup card, is still open and is the single decision
that unblocks the three way counter contradiction.

**Phone.** The root works. All five sub-routes overflow horizontally. That is a hard fail: a coach
on a phone gets a page that slides sideways under their thumb.

---

## Ranked: how far each screen is from the bar

1. **`/coach/settings`**: Not started at all. 5686px, 29 notices, 58 checkboxes, 42 accent fills,
   117 sub-44px targets. The spec wants one question. Furthest from the bar by a wide margin.
2. **`/coach/conversations`**: The most important control in the product is invisible, and the
   phone layout collapses into overlapping panes. Broken rather than merely unfinished.
3. **`/coach/pipelines`**: Pre-rehaul component behind a rehauled pill, 8880px, 201 sub-44px
   targets, a board that clips, and one fact stated four times in 160px.
4. **`/coach/billing`**: Does not load, so nothing the spec asks for can be judged.
5. **`/coach/integrations`**: 1936 lines the spec deletes, still rendering, with one sentence
   printed four times and five identical cards.
6. **`/coach/home`**: The shape is right and two thirds of the page is empty. The trend chart and
   the keyword table, both asked for by name, are not started.
7. **`/onboarding` sub-routes**: Horizontal overflow on all five at 390px, and a drench budget
   blown 3.5x on one of them.
8. **`/coach/agent`**: The ladder is a real improvement and the remaining defects are local: the
   publish lifecycle, two uppercase mono labels, a colliding export button, an empty right rail.
9. **`/coach/contacts`**: Closest of the leads pair. Four KPI cards to delete, a search box to
   restore, 12.5px second lines to raise.
10. **`/coach/get-started`**: Mostly a copy and counting problem, not a layout one.
11. **`/coach/tips`**: One empty state at the wrong size on an otherwise clean page.
12. **`/onboarding` root**: The best composed coach screen. Fix the counter, the skipped numbers,
    and move the drench off the explainer.

---

## Shared kit gaps seen on more than one screen

**The floating support bubble collides with content on six screens.** Measured overlaps on home,
agent, conversations, integrations, help and pipelines, at a fixed position around (1370,838).
`context-eye.tsx:41-47` records this exact defect for the eye, and fixed it by adding a `header`
placement. `CoachSupportBubble` never got the same treatment, and the corner it occupies is where
every pane's action row ends.

**`ContextEye` placement and scale are inconsistent.** Header placement at coach scale on home,
agent, contacts, billing, integrations and tips; header at **owner** scale (32x44) on conversations;
**floating** on help and on all five onboarding sub-routes; **absent entirely** on the onboarding
root. Four behaviours for one component.

**Nothing enforces the type floor at the shared kit boundary.** `COACH_READING_CLASS` is opt-in per
screen, so `.t-body` at 13px, `.t-mono-crumb` at 11.5px and `--t-badge` at 12px all render on coach
surfaces through kit components the screen did not author: `StateBadge` labels at 12.5px, table
column headers at 13px, `Button size="sm"` at 12.8px, timestamps at 12px. The playbook's trap list
says the floor applies to shared kit; today it applies only to callers who remembered.

**Mono is being used as a label, not as a number.** `0 of 3 done`, `of 4`, `our default` seven
times, `No activity yet` five times, channel codes, `Decided by / The carriers`, `Stage changes:
Logged`. The spec's do-not-include list is explicit that mono is for numbers in tables only, and
there is no guard.

**Absence is stated once per card and never once per page.** Rule 1 is being honoured locally and
inverted globally: home, billing and tips each obey it card by card and end up with a third to two
thirds of the viewport blank. The kit has no first-run or nothing-measured page composition, which
is what Note 1 item 5 asked for and what the owner Overview solves with a hero panel that always
has something to say.

**Panel header bands offer more than one control.** Canvas rule is one. Agent's band offers five,
home's setup rows offer a pill plus a button, and the agent right rail's cards each carry an Export
that collides with a two line name. `DeckPanel`'s `lead`, `meta` and `action` slots are pinned by
`deck-panel.test.tsx`, but nothing pins the count of pressable things in the band.

**`(demo)` and "Test data" leak into text the way `displayName` fixed for names.** Conversations
prints `(demo)` roughly twenty times, help six. `src/lib/format/display-name.ts` strips it where a
human reads a name; message bodies, thread subjects and support authors are not names and are not
covered. The owner console's answer is one `Demo` provenance chip per row, which is already built
as `ProvenanceChip`.

**The 44px target rule has no guard on kit primitives.** Sub-44px elements measured on six coach
screens all come from kit components rather than page code: sort buttons in `DataTable` at 8px
wide, kanban card menus at 28px wide, checkbox indicators at 16x16, `size="sm"` buttons at 12.8px
type. The floor is stated in the spec, in the canvas and in the playbook, and enforced nowhere.
