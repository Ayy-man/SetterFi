# The coach redesign playbook

**Written:** 2026-09-04, from the owner console rehaul that landed between 2026-09-01 and
2026-09-04. Sources: `docs/plans/2026-09-03-ui-rehaul-notes.md` (notes 1 to 26), the design canvas
indexed at `docs/REDESIGN-CANVAS.md`, and the commits from `99eb3c5` to `d5ed763`.

The owner console is finished and good. The coach side is roughly three times the work and has
failed to land twice. This document exists so the third attempt inherits the reasoning rather than
the screenshots, because reading the source is what made the owner pass work and reading the
pictures is what made the first pass fail.

Read this with `docs/DESIGN.md` for the tokens, `docs/SIMPLIFICATION-SPEC.md` for what changes on
each coach screen, and `docs/REDESIGN-CANVAS.md` for what the result should look like.

---

## Part 1. The rules that made the owner console work

These are not style preferences. Each one was learned by getting it wrong first, and most now have
a test behind them. They transfer to the coach side unchanged.

### 1. Absence is content, and it must be stated, not drawn

The single most repeated fix in the whole rehaul. A screen that cannot measure something says so in
words, in the place the figure would have been, and never fills the hole with a shape.

Concretely: churn rate and median time to live carry no period series, so their cards end shorter
rather than printing a line borrowed from a neighbour. The Clients table prints `not measured`
rather than a zero. The Overview signups card prints `no prior period recorded` when there is no
prior period. A card whose snapshot measured nothing disappears entirely rather than sitting as a
label over blank space.

The reason is that a zero and an unmeasured value are different facts, and a chart cannot tell
them apart. Once a screen is allowed to draw an honest-looking zero, every number on it becomes
unfalsifiable to the reader.

### 2. Never draw a shape the data does not support

`SPARKLINE_MIN_POINTS` went from 2 to 6 because a smoothed spline through three thirty-day periods
reading 0, 0, 7 asserts a curve those readings never held. Two points is enough to compute a
direction and nowhere near enough to draw one.

The same rule caught the coach dashboard's keyword funnel, which was drawing a spline between four
discrete stages, so the curve between stages meant nothing. It is bars now.

Match the form to what the data is: a series over time is a line or bars, a set of discrete stages
is bars, a single reading is a figure, and a comparison of two readings is a sentence.

### 3. Fix the label before you fix the picture

The Clients Performance tab had a chart the owner called weird. It was drawing the platform signup
history under a heading that said "Booked calls across the platform". Promoting it to a better
chart would have drawn the wrong series beautifully.

When a visual looks wrong, check what it is bound to before you restyle it. Twice in one session
the presentation was innocent and the binding was the bug.

### 4. The screen says each fact once

Seeded rows carry a trailing `(demo)` in the database on purpose, so provenance is legible in a
query. On screen it was appearing up to six times per pane: in the tenant name, beside a Demo pill
that said the same thing, in the assignee, in the message body, in the plan name.

`displayName` in `src/lib/format/display-name.ts` strips it exactly where a human reads a name, and
only there. Exports, audit rows and anything a log search must match keep the raw string.

The general rule is that a repeated fact is clutter with a plausible excuse. The notification matrix
said "Required" sixteen times and drew a lock glyph beside every locked checkbox; one counted
sentence above the sections replaced all of it.

### 5. Explanation lives in the eye, not on the page

Every screen has a `ContextEye` holding the sentences that used to be printed as help text under
headings. The page carries figures and controls; the eye carries the prose that explains them.

This is what let the console lose most of its explainer lines without losing the explanations. When
you are tempted to add a sentence under a heading on a coach screen, that sentence belongs in the
eye.

### 6. One control, one piece of state

The client detail pane and the page tab row both wrote the same `tab` search parameter, so moving
the pane's section silently reordered the table behind it. Two controls that look independent were
one value.

Related, from the canvas: a panel's header band offers exactly one pressable thing, so the band
never presents two competing actions.

### 7. Measure before you fix, and let the measurement pick the fix

The Money page felt slow and every instinct said the database. The database was innocent: queries
run in 0.1 to 17 milliseconds while a bare round trip to the Supabase region costs 300 to 360. The
table was making three extra trips after hydration by fetching itself through an export route.

The fix followed the measurement rather than the instinct. No Suspense skeleton was added, because
a skeleton hides a removable cost. See `docs/BACKEND-SPEC.md` section 9.1 for the round trip budget;
the coach pages read through the same repositories and will have the same shape.

### 8. Move the accessibility, never delete it

The focus ring escaped the password field because two indicators were drawn for one control. The
tempting fix is to delete one. The shell's tint measures about 1.2 to 1 against the card, far under
the 3 to 1 a focus indicator needs, so deleting the outline would have traded a cosmetic bug for an
accessibility failure.

The ring moved onto the shell instead: same width, colour and offset, different element. When a
visual fix means removing something, check what that something was load-bearing for.

### 9. Every rule gets a guard, and the guard is the authority

The repo's tests encode design rules: no native `<select>` on live surfaces, the accent-fill
spelling, the em-dash ban, the CSS line budget, the coach type floor, the server and client
boundary, each text role staying 1.3 of contrast clear of the role above it.

Two consequences learned the hard way. First, **read the test, not the document that describes it**;
`docs/REDESIGN-CANVAS.md` records a session lost to trusting a document that was behind the code,
and says it has now cost three sessions. Second, when a guard blocks you, meet it rather than weaken
it: the bar chart's value label went to 14px because the coach type floor demanded it, and the dark
muted colour landed at 0.81 rather than 0.82 because the contrast-spacing guard rejected 0.82.

### 10. A decision nobody can find gets re-litigated

The move from teal to blue was recorded only as a code comment for a day, and the canvas notes call
that the same failure as the earlier glow ruling. Rulings go in the notes file and in the permanent
document they affect, on the day they are made.

This document exists for the same reason.

### 11. Two densities on purpose, and coach is the generous one

The coach side and the owner console are deliberately not the same product, and mixing them is a
regression rather than consistency.

| | coach | owner console |
|---|---|---|
| body | 16px | 13.5px |
| page title | 46px | 30px |
| minimum interactive target | 44px, no exceptions | 30 to 34px |
| navigation | five destinations, top pill bar | 246px grouped rail, nineteen destinations |
| table row padding | 19px 26px | 12px 18px |

The coach side serves people over 55 who found the previous console confusing. The owner console
serves the client's own team, in it all day. Cost, margin, model spend and cost per call appear on
owner screens only.

---

## Part 2. Why the coach side is three times the work

The owner console was mostly reshaping screens that already had the right information. The coach
side is not, for four reasons.

**The Agent page is a flow, not a screen.** The 2026-09-02 call asked for one linear path: keywords,
then purpose per keyword, then resource link with the exact message, then an optional follow-up,
then qualification questions with drag ordering and per-question on and off, then qualification
tiers, then the disqualified path, then a custom conversion event, then calendar booking, then the
post-booking message. The client called the current Agent section "a whole mess". This is a
sequence design problem, and no amount of card styling solves it.

**The navigation demotion is four re-homing decisions that must land together.** Cutting the coach
rail from nine destinations to five runs into `workspace-navigation.test.ts`, which pins the list
precisely because Connections and Notifications were added when those pages had no route to them.
Get started and Connections move into the Home setup card, Notifications into the account menu, Help
into the support bubble. Ship them apart and live pages become unreachable again.

**The canvas is behind the code on colour.** Every artboard is dark and teal. The code now carries a
real light palette and a blue accent, changed after review. On layout, anatomy, copy and ordering
the canvas is still the authority; on colour it is not.

**Shared components have three consumers.** `meet-your-agent.tsx` is mounted by the coach route,
onboarding, and the admin eval playground, where the preview control, adversarial chips and
eval promotion form live. Building the canvas literally would have deleted working admin capability
to match an unsigned drawing. The ruling was to build the coach playback additively as a new
component. Expect more of this: check every consumer before rewriting anything shared.

---

## Part 3. The sequence that worked

1. **Draw it first, on a canvas, from the source rather than from screenshots.** The first canvas
   pass built from preview screenshots produced a flat uniform grid that missed the panel anatomy
   entirely, because the screenshots did not show that the old card had a specific structure.
2. **Build as new components on the current kit, behind a flag.** The owner rehaul lived under
   `SETTERFI_UI_REHAUL` with each page rendering the new component when on and the old surface when
   off, until the flag was deleted in `99eb3c5` and the rehaul simply became the app.
3. **Ship one surface at a time to the demo tenant for reaction**, rather than presenting a finished
   set. Every good correction in the notes came from a screenshot of a real screen with real data.
4. **One agent per surface, with explicit file ownership.** Shared kit changes belong to one agent,
   never two, and the boundaries have to be stated up front or two agents will edit one file.
5. **Verify headlessly against a real page with real data.** The browser extension produced false
   failures on this app; headless Chrome against the dev server or the preview deployment is the
   honest path, and measuring geometry in the page beats reading CSS.

---

## Part 4. Traps that will recur

- **The server and client boundary.** Importing a value from a `"use client"` module into a server
  page replaces it with a client reference that throws in production. This has now happened four
  times. Shared constants go in a directive-free module such as `src/lib/console-tabs.ts`.
- **The CSS budget is at its ceiling.** The cap has been raised twice and the stylesheets sit just
  under it. The coach redesign should reclaim dead rules rather than raise it a third time.
- **Stored snapshots hide formatting bugs.** The Overview read a pre-rounded synthetic snapshot,
  which concealed a percentage that printed seventeen digits and overflowed its card the moment the
  console read real data. Build coach screens against real seeded data, not fixtures.
- **The coach type floor applies to shared kit.** Any component the coach side mounts is held to
  14px minimum, including a chart's own labels.
- **Demo markers.** Anything rendering a name needs `displayName`, and anything rendering provenance
  needs the pill instead.

---

## Part 5. What is still open

- The Brain view had its redesign round on 2026-09-06 (design source in `design/brain/`, screen in `src/components/workspace/rehaul/owner-brain.tsx`).
- The five coach navigation pills are proposed and awaiting confirmation, along with the
  qualification question ordering control, which reverses the simplification spec's default because
  the client asked for it again.
- The canvas's six open questions in `docs/REDESIGN-CANVAS.md` are answered by the canvas taking the
  simplest option so there is something concrete to react to. None is signed off.
