# UI rehaul: running notes

**Started:** 2026-09-03 · **Source:** Alec Delpuech call of 2026-09-02 (Fathom, 28 min) and
Ayman's notes dropped during the design session.
**Rule:** every note is logged here verbatim as it arrives, before it is acted on. Decisions
derived from notes are recorded under "Decisions" with the note they came from.

## Decisions so far

1. **Visual base:** round-3 voice (`40c58b5` in the frozen internal repo: light, "Welcome back",
   big figure + one sentence per panel, top pill nav) rebuilt on the current `tokens.css` light
   and blue palette. Not a new design language. (Ayman, 2026-09-03)
2. **Mural board:** design from the call transcript; Alec corrects against the board at review.
   (Ayman, 2026-09-03)
3. **Approach:** rebuild the coach pages as new components on the current kit, Dashboard and
   Agent flow first, shipped to the demo tenant for Alec's reaction before Inbox and Leads.
   (Ayman, 2026-09-03)
4. **Nav:** five pills, relabelled Dashboard · Inbox · Leads · Agent · Billing; demoted items stay
   in the account menu and Home setup card. (proposed, section 1, awaiting Ayman)
5. **Qualification questions:** drag-to-reorder with per-question on/off returns as a real coach
   control, reversing SIMPLIFICATION-SPEC Q3's default, because Alec asked for it again on
   2026-09-02. (proposed, section 1, awaiting Ayman)

## What the 2026-09-02 call asked for (from the transcript)

- **Dashboard:** per-keyword funnel table (opt-in % → qualified % → booked %), count/percent
  toggle, one monthly graph (leads per month, booked calls per month), a few KPIs such as
  average time to book. "Say the most in the least amount of words."
- **Agent page, one linear flow:** keywords list → purpose per keyword (send a resource, or
  straight to book a call) → resource link + description + exact message → optional follow-up
  ("have you seen the resource?") → qualification questions, drag-and-drop, on/off, custom
  questions allowed → how qualified are they (tiers; some can be lifted with follow-up) → what
  happens when disqualified (e.g. send to YouTube) → custom conversion event to optimise for
  (Hyros-style) → book via calendar (GHL or Calendly) → after booking: hype-up message + resource
  link (thank-you / invite page).
- **Inbox:** too much extra text, chunked up, too tight, does not fill the screen; must work on
  every monitor.
- **Agent section today:** "a whole mess."
- **Nav:** fewer top items, the rest in a sidebar.
- **Miro action item:** add the follow-up field under the resource link/description.
- **Timeline:** launch at the event in about five weeks (early October 2026): UI, logic, Facebook
  connections, tested with a couple of clients.
- **Other action items:** Alec shares GitHub username + email for repo invites; SetterFi landing
  page with privacy policy is needed for Google OAuth app verification.

## Ayman's notes (verbatim, in arrival order)

### Note 1 (2026-09-03, screenshot)
> "this is broken"

Screenshot: a crop of the coach topbar's right end. Visible: the tail of a pill cut off at the
left edge ("X"), the bell button, a "DH" avatar circle, and a chevron. No workspace name or
"Coach view" caption beside the avatar, and the cluster sits tight against the right edge.
Interpretation pending Ayman's detail.

**Resolved (2026-09-03, uncommitted):** the account chip was a `size="icon"` Button (`size-8`,
a fixed 32px square). Named variants override the height but never the width, so the first name
truncated to nothing and the chevron pressed against the initials. Fix in
`src/components/kit/app-topbar.tsx`: a chip with a first name uses the content-sized `default`
variant; the unnamed fallback keeps its square. Regression tests added in `app-topbar.test.tsx`
(fail on the old code, pass on the new). Lint and typecheck clean.

### Note 2 (2026-09-03)
> "which screens did alec point out as the problem screens because we definitely have wayyy too
> much text on here"

Answer from the transcript, in the order Alec walked the app (timestamps are the Fathom recording):
- **Dashboard / Overview (~7:30–8:38):** "now it's kind of a mess"; several blocks "don't have to
  be here"; the keyword section "needs to be better"; the KPIs he kept were average time to book
  and the earlier KPI set. Wants: keyword funnel table + one monthly graph + a few KPIs.
- **Inbox (~8:40):** "extra text that's not needed", "all chunked up", "too tight", "I can't even
  read what's going on", and it doesn't fill the screen on his monitor.
- **Leads board (~9:14):** read the "Board, decision recorded" label aloud, confused; no other
  comment.
- **Agent (~9:20):** "this whole section is just a whole mess now"; on the flow page generally,
  "all kinds of extra wording that's unnecessary", descriptions should be a hover/pop-up icon,
  not inline prose.
- **Billing:** no complaint.
- **Global:** "say the most in the least amount of words", "the least amount of features."

### Note 3 (2026-09-03, three screenshots of the owner console Overview, `/admin/overview`)
> "On the overview page, the blue card is pretty good and fine, but there is an empty space on the
> right side for no reason. We can probably collapse that and make it slightly taller.
>
> The spacing on the texture doesn't look very professional either. It looks fine in white mode
> but it's the exact same color as the dark mode as well, I'm pretty sure. It feels a little weird.
>
> For the fleet snapshot, there are no clients so there is no fleet to count. What is this fleet
> card supposed to be? This doesn't make any sense either.
>
> For all of these cards, I'm wondering if we can add very pretty little mini graphs showing the
> new signups in the last 30 days. Maybe we can have a little graph showing the peaks and drops
> over there, and the active subscriptions as well. For example, I'm wondering if clicking on
> these cards could open a pop-up with a very nice animation that shows more details in these
> analytics. The goal is to make it as minimal as possible on the frontend while each card should
> have a pop-up that gives you much more information.
>
> Overall this dashboard generally makes it hard for me to make sense of it because none of the
> data is here. I need you to see data here so that I can actually make some decisions about the
> screen. Of course log all of these issues into a document and also then Add the actual data"

Issues, itemised:
1. **Platform pulse card:** keep. The "Fleet" panel to its right is empty space; collapse it and let
   the pulse card be slightly taller.
2. **Pulse card texture/gradient:** spacing reads unprofessional; the navy is the same in light and
   dark mode, which feels wrong in light mode.
3. **Fleet panel:** "This snapshot names no client, so there is no fleet to count." Purpose unclear;
   with no clients it says nothing.
4. **Five KPI cards** (new signups, active subscriptions, churn rate, median time to live, margin):
   add small sparklines (last 30 days, peaks and drops) at least for new signups and active
   subscriptions; clicking a card opens an animated pop-up with the deeper analytics. Front stays
   minimal, detail lives in the pop-up.
5. **No data:** every figure is 0 or "—", so the screen cannot be judged. Get real-looking data
   onto this console before design decisions are made.

### Note 4 (2026-09-03, screenshot of the owner console Inbox, `/admin/inbox`)
> "Here in the inbox as well, we have everything coming first and then assigned to me coming
> later, which is not good. Assigned to me should ideally come first.
>
> Over here there is way too much explainer text. I need you to design the pages without the
> explainer text in mind.
>
> On top of that, we need a system-wide system that is basically like a floating button or an
> eye, with a clearly different vibe from the rest of the system. When you click it, it gives you
> a tooltip and you can choose to hide it. Hiding it will close that message until you are still
> on the screen. Maybe refreshing it can bring that message back.
>
> The idea is that for the next couple of weeks we can read that when we are looking through the
> system for some context. It will be very easy for us to get rid of those messages once we
> actually launch"

Issues, itemised:
1. **Inbox view toggle order:** "Assigned to me" must be the first (and default) segment; "Everything"
   second.
2. **Explainer text:** the banner under the title ("Longest wait first, in both lanes…"), the grey
   footer note ("Nothing records who is working a system problem…"), the blast-radius caption, and
   the "No implemented command restarts an agent…" line are all explainer prose on the page. Rule
   going forward: design every page with no inline explainer text.
3. **System-wide "context eye":** one floating control per screen, visibly different in style from
   the product chrome. Click opens a tooltip/popover carrying the explainer text that used to be
   inline. It can be hidden; hiding lasts for the current visit to that screen (a refresh may bring
   it back). Meant for the review period only, removed at launch. This is where the removed
   explainer prose from every page goes, so nothing is lost.

**Finding on note 3 item 5 (2026-09-03):** the screenshot is production (`setter-fi.vercel.app`),
signed in as the seeded owner Delia Hartman (demo). Hosted holds 8 tenants, all `is_demo`, and
every `analytics_*` view excludes demo and test rows, so the real console is correctly empty. A
labelled synthetic snapshot exists (`platform_measurement_preview_snapshots`, key
`staging-demo`, seeded 2026-08-23: 3 signups, 6 active subscriptions, $2,982 gross MRR, 24 booked
calls, tenant and follow-up performance) and `platformPreviewDataEnabled()` in
`src/lib/env-contract.ts` selects it only when `SETTERFI_PHASE7_LIVE`,
`SETTERFI_PHASE7_ANALYTICS_LIVE`, `SETTERFI_DEMO_LOGINS` and `SETTERFI_PLATFORM_PREVIEW_DATA` are
all true **and the deployment is not production**. Verified with the actual `.env.local`: local
dev shows the snapshot, a Vercel preview deployment shows it (the preview environment carries all
four gates), production never does. The production block is a written rule in the code comment:
"platform measurements must be real or report unavailable there."

