# The redesign canvas

**Written:** 2026-09-01 · **55 artboards, coverage complete**
**Artifact:** <https://claude.ai/code/artifact/3b86b932-49a7-45f9-ba64-143c6ecd82f7>
**Status:** in review with Alec Delpuech. Nothing here is signed off yet.

This is the visual authority for Phase 12. `docs/SIMPLIFICATION-SPEC.md` says *what changes on
each screen and why*, pinned to the code it touches; the canvas says *what the result looks
like*. Where the two disagree, the canvas wins on appearance and the spec wins on behaviour.

The canvas is a live editable page, not a picture: Alec can select an element, change it, retype
copy in place, and save a new version for everyone. Treat the published artifact as current and
this document as an index — if a screen here and a screen there differ, the artifact is right.

## The rule every screen follows

**The visual language is the one already in the code.** Geist Sans and Geist Mono, the
`--card-top` → `--card` navy gradient, the teal `--accent`, the exact hairline alphas — every
value lifted from `src/app/tokens.css` rather than re-derived. Nothing on the canvas introduces a
colour the product does not already have.

**The layout is the round-3 build's**, recovered from `40c58b5` (`workspace-screens.tsx`,
`workspace.css`, `workspace-coach-redesign.css`) rather than from the screenshots in
`docs/reference/branding/preview-shots/`. Reading the source mattered: the screenshots do not
show that the old card was a `RouteDeckPanel` with a specific anatomy, and a first pass built
from the pictures alone produced a flat, uniform grid that missed the point.

That anatomy, which every panel on the canvas reproduces:

- `border-radius: 24px 24px 17px 17px` — asymmetric, larger on top. Hero panels use `30px`.
- A header band, `padding: 19px 20px` on a `min-height: 78px` floor, closed by a hairline, carrying a small `--muted` eyebrow
  above the panel's name, with the action at the right of the band.
  - **Two static slots either side of the name, added 2026-09-01.** `lead` sits before the eyebrow
    and name, `meta` after them at the band's right edge; `action` is unchanged and is still the
    band's only control, so the band never offers two pressable things. They exist because the
    artboards put content at both ends and the end is the point of each: `CoachError.dc.html` opens
    its panel with an amber warning tile *before* the eyebrow, and `CoachTips.dc.html` sets each
    training's duration hard right against the name, which is what lets a row of three cards show
    three lengths on one line rather than at three different heights. One slot could not serve both
    — it would have made one of them the wrong shape, and it would have pushed the flex row into
    every call site, where the same layout gets re-derived and drifts. `deck-panel.test.tsx` pins
    the two boxes and their order, so this bullet and the component cannot disagree quietly.
- The figure: mono, weight 500, `letter-spacing: -0.075em`, `line-height: 0.92`. Large.
- One sentence, `max-width: 34ch`, in `--muted`. Never two.
- A footer widget pushed down with `margin-top: auto`.

**At most two drenched panels per screen and nothing else fills.** `--drench-live` is the old
`--sf-route-live` gradient, unchanged because its hue was already in the product's family;
`--drench-info` is the old electric-blue `#2050c8` re-hued onto the teal the product uses now.

**Every 9.5px uppercase mono overline is gone.** They were the single worst legibility case in
the product and coach Home carried thirteen of them.

## Two densities, on purpose

The coach side and the owner console are deliberately not the same product.

| | coach, affiliate, consumer, onboarding | owner console |
|---|---|---|
| body | 16px | 13.5px |
| page title | 46px | 30px |
| minimum interactive target | 44px, no exceptions | 30–34px |
| navigation | five destinations, top pill bar | 246px grouped rail, nineteen destinations |
| table row padding | 19px 26px | 12px 18px |

The coach side is built for people over 55 who found the Phase 11 console confusing. The owner
console is for the client's own team, in it all day, and seventeen destinations cannot live in a
pill bar. **The admin console is out of Phase 12's scope**; it appears on the canvas so the two
densities can be compared side by side, and because several admin screens needed drawing anyway.

Cost, margin, model spend and cost-per-call appear on owner-console screens and nowhere else.

## Coverage

Four pages in the canvas. Flip between them from the toolbar's pages menu.

**Coach** (18) — Home, Inbox, Leads as a list and as a board, Your agent, Billing, Setup, Meet
your agent, Inbox with nothing waiting, the account menu, the notification question, the support
bubble, changing plan, Home loading, the error state, page not found, tips and trainings, and Home
on a phone.

**Owner console** (25) — all nineteen rail destinations across Run, Clients, Money, Brain and
Platform, plus four drill-downs (client detail, reading a lead conversation across a tenant
boundary, the eval playground, the success team), the impersonation banner, and a Money page
refused by role.

**Signup and onboarding** (6) — sign in, sign up, connect channels, your offer, go live, and the
public marketing page.

**Affiliate and lead** (6) — the partner portal, affiliate signup, and the lead's phone screens:
conversation, picking a time, confirmed, and opted out.

## What implementation is blocked on

> **Both blockers below were already gone when this section was written, 2026-09-01.** Neither
> stands. The overline test no longer pins an overline under `.agent-shell` — it pins the
> **absence** of one there (`overline-size.test.ts:84-93`), with a positive control proving the
> slice it reads is the real stylesheet rather than an empty string from a moved marker. And the
> coach rail was already cut nine to five in `ff25de9`, a commit that predates this document:
> `workspace-navigation.test.ts:186` pins the five, and the test below it pins the four demoted
> destinations' reachability, which is the guarantee that replaces the rail. So a Meet Your Agent
> rebuild does not need a `docs/DESIGN.md` ruling to move first, and the nav demotion is not four
> pending decisions — it is done and guarded.
>
> Recorded rather than deleted, because the reasoning underneath is still right and the mistake is
> the instructive part: this section was written from the plan of record instead of from the tests
> it names, and the plan of record was behind the code. The design ledger has an entry
> saying the same thing about the glow ruling. **Read the test, not the document that describes
> it** — that is the whole lesson, and it has now cost three separate sessions.
>
> What is genuinely still open is smaller and is a product question, not a test: `MeetYourAgent.dc.html`
> draws a scripted five-bubble playback with no composer, but `meet-your-agent.tsx` is mounted by
> three callers — `/meet-agent`, onboarding, and the admin eval playground, which is where the
> "Preview as" control, the adversarial chips and the eval-promotion form live. Building the canvas
> literally would delete working admin eval capability to conform to an unsigned drawing. Ruled
> 2026-09-01: build the coach playback additively as a new component and leave the sandbox alone.

The two paragraphs below are what this section said before that correction.

Two pinned tests stand between the canvas and the code, and neither should be edited without
Alec's sign-off on the canvas, because each guards a rule someone wrote down on purpose.

**The overline.** `src/app/overline-size.test.ts` pins the 9.5px mono uppercase overline in five
places — the atomic, the grid-table header, the consumer stylesheet, the Meet Your Agent sheet,
and the sentence in `docs/DESIGN.md` that is its authority. It exists because the size had already
drifted three times and because a docstring asserting the rule is what let the mistake survive
being read. The canvas removes the overline entirely, so landing it means moving the rule in
`docs/DESIGN.md` first and the test with it — not deleting an assertion to get a screen through.

Worth stating while we are here: `docs/DESIGN.md` was deleted at `74f5e55` and written again from
scratch at `c9c1c66`, last touched on 2026-08-31. It is a current document describing the tokens
that actually exist, and it is the authority the overline test cites; the engineering brief now says
the same.

**The coach rail.** `src/lib/workspace-navigation.test.ts:185` pins the exact nine-item coach list,
covered under "The nav demotion's re-homing" below.

## Decisions the canvas makes that the spec left open

`SIMPLIFICATION-SPEC.md` ends with six questions for Alec. The canvas takes the simplest answer
to each so there is something concrete to react to. **None of these is settled** — each is a
sticky note on the canvas for him to strike through.

1. The amber "needs you" queue is off Home. It survives as one line inside the Active panel and a
   count on the Inbox pill. Alec removed this twice before and Phase 11 put a larger version back.
2. The booked-call allowance is off Home and lives only on Billing, per R4-15.
3. Qualification question ordering and per-question on/off leave the coach surface entirely and
   read as a statement under "What SetterFi handles for you".
4. No draft/publish lifecycle. One Save, and changes go live.
5. Integrations comes off the rail. Channel state is the setup card on Home plus one sentence
   when something breaks.
6. The notification matrix becomes one question — email, text, or both — in the account menu.

## Two things the canvas does not decide

**Light versus dark.** Alec's anchor build was light-only and every screen here is dark, because
dark is the design language that exists: `tokens.css` defines no real light palette — the
`[data-theme="light"]` block at line 605 carries the same dark values as `:root`, deliberately.
A true light coach theme is separate work with its own contrast pass, not a toggle.

> **Decided against the canvas, 2026-09-01.** Alec reviewed the redesign and asked for "the white
> and blue colors" back and for the whole thing to look softer, so the separate work above was
> done rather than deferred. `tokens.css` now carries a real light palette in the bare `:root`
> block and the forced-light island, the two dark blocks keep theirs so the toggle wins in both
> directions, and the accent moved from teal at hue 218 to blue at hue 264 in all four blocks —
> the teal existed so one accent could serve both design languages, which is the decision being
> reversed. Landed in `39f0cae`. **Every artboard on the canvas is still dark and teal**, so on
> colour the code is now ahead of the canvas and the canvas is not the authority; on layout,
> anatomy, copy and ordering it still is. The instruction was recorded only as a comment at
> `src/app/tokens.css:9-30` for a day, which is the same failure the glow ruling of 2026-08-30
> is an example of — a decision nobody can find is a decision that gets re-litigated.

**The nav demotion's re-homing.** Cutting the coach rail from nine destinations to five runs into
`workspace-navigation.test.ts:185`, which pins the exact nine-item list, and that test exists
because `f8d0381` added Connections and Notifications on 2026-08-31 precisely because those pages
had no route to them. Demoting them is therefore four re-homing decisions that have to land
together — Get started and Connections into the Home setup card, Notifications into the account
menu, Help into the support bubble — or live pages become unreachable again. The canvas draws all
four destinations, so the routes exist on paper; the implementation has to make them real in the
same change.

## The coach canvas, 2026-09-04

**Artifact:** <https://claude.ai/code/artifact/2f6a08eb-6ca9-471f-a02e-052d430976a5>
**Working files:** `design/coach/*.dc.html`, `design/coach/VOCABULARY.md`, `design/coach/canvas.json`

A second canvas, coach side only, drawn on the light palette and blue accent that `tokens.css`
carries now, so on colour it supersedes the 2026-09-01 canvas above; on layout, anatomy, copy and
ordering it inherits from it. Twenty-two artboards on three pages: Console (Home live and first run,
Inbox, Agent, Leads as list and board, Billing, Home on a phone, and the vocabulary sheet every other
board copies), Onboarding and setup (the overview, one step, connect, go live, the full setup page,
and a step on a phone), and Chrome and states (account menu, the one-question notifications page,
the support bubble open, tips, loading, the failed read, and page not found).

It was drawn from `docs/plans/2026-09-04-coach-visual-audit.md` and
`docs/plans/2026-09-04-coach-mobbin-research.md` rather than from screenshots, under
`docs/COACH-REDESIGN-PLAYBOOK.md`. Every board was measured in Chrome before it was placed: nothing
under 14px, no target under 44px, no uppercase, one filled accent button in view, mono only on
figures, absence stated in words, and no shape drawn over data that is not there.

Rulings the boards make that the spec left open are listed per board in
`docs/plans/2026-09-04-coach-rehaul-notes.md`, Note 5.

**Built, 2026-09-04.** Every board on the coach canvas is in the code on `main`: Billing
(`ee4db83`), Leads (`0be62bd`), Setup (`3235628`), Onboarding (`74bb921`), the chrome, Settings,
support bubble, Tips and Guides (`2d66f92`), Agent (`008b2a7`), Inbox (`157e6f5`) and Home
(`94e8b30`). Each surface's departures from its board are recorded under its "what shipped"
section in `docs/plans/2026-09-04-coach-rehaul-notes.md`. Where a board and the code differ now,
the code is the authority and the note says why.
