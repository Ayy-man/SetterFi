# Coach-Side Simplification Spec

**Written:** 2026-08-31
**Trigger:** Alec Delpuech rejected the Phase 11 redesign's direction for the coach workspace on
the call of 2026-08-31. His brief, verbatim intent: his coach base skews older, so everything must
be large and easy to click; give coaches as few options as possible and take decisions away from
them; the old version was "simple and dummy-proof" and he preferred it.

**Scope:** coach surfaces get the deep pass. Affiliate and consumer get a lighter one (their
sections are short and marked as such). **The admin console is out of scope entirely** — Alec's
team keeps the dense three-pane console, and nothing in this document applies to `/admin/*`.

**Status:** analysis and specification only. No product code was changed in this pass.

**The visual target now exists.** `docs/REDESIGN-CANVAS.md` indexes a design canvas that
draws every screen in this document, plus the owner console, onboarding, the affiliate
portal and the lead's phone screens. This document stays the authority on *what changes and
why*; the canvas is the authority on *what it looks like*. The canvas takes the simplest
answer to Q1-Q6 below so Alec has something concrete to strike through, which does not
settle them.

**The visual anchor** is commit `40c58b5` ("Merge round-3 client feedback"), deployed as
the round-3 preview: light theme, "Welcome back,
Marcus", six KPI bubbles each with one plain sentence, one trend chart, one keyword table. The
anchor is the *voice and the scale*, not the files: this spec defines a new IA and does not ask
anyone to revert `workspace-screens.tsx` from git.

---

## 1. What we actually found

Four things are wrong on the coach side, and only two of them are layout.

**The coach app grew from six destinations to ten, and home grew from four blocks to eight.** The
old rail carried Dashboard, Inbox, Contacts, Pipeline, Agent, Help under three group labels
(`workspace-navigation.ts` at `40c58b5`). Today's rail carries Home, Inbox, Leads, Your agent, Get
started, Connections, Notifications, Billing, Help — nine items in one flat "Workspace" group
(`src/lib/workspace-navigation.ts:234-263`) — plus `/coach/pipelines`, reachable only as a
`matchPaths` alias of Leads. Home went from *greeting + six bubbles + trend + keywords* to eight
stacked sections: the attention queue, the outcomes strip, "Yours to set", the performance window,
the six-month trend, the keyword table, and the billing allowance card
(`src/components/workspace/live/coach-measurement.tsx:906-1079`).

**The voice turned into an ops console.** `Overline` renders at **9.5px uppercase mono with 0.09em
tracking** (`src/components/kit/atomics/type.tsx:20-38`) and coach home uses thirteen of them.
"WHAT CAME OF IT", "YOURS TO SET, FOUR THINGS", "SIX-MONTH LEAD VOLUME" and "NEEDS YOU" are all
that treatment. The old build opened with `title="Welcome back, Marcus"` and a plain status
sentence under it. A 9.5px wide-tracked capital is close to the worst possible legibility case for
an older reader, and it is the first thing on every block.

**Half of Alec's reaction is empty numbers, not layout.** The phase-7 demo seed hard-codes every
contact, conversation, and message at `2026-06-01` and seeds exactly **six contacts, six
conversations, and five messages** (`scripts/seed-phase7-demo.mjs:235-283`). Home's default window
is `1m` (`coach-measurement.tsx:174`). On 2026-08-31 that window is roughly 1–31 August, and the
seed put nothing in it, so `metricAvailability` falls through to `needs-history`
(`coach-measurement.tsx:250-259`) and `StatStrip` prints the italic "not yet" over "day 31 · of
about 31 needed" (`src/components/kit/stat-strip.tsx:198-211`). Seven of eight figures on the
screen said that. The honest-states machinery is working exactly as designed; it is being fed a
dataset with no recent rows.

**The coach app is dark by default.** `tokens.css` defines the dark palette on bare `:root`, keeps
it under `prefers-color-scheme: dark`, and treats light as an opt-in island — `[data-theme="light"]`
at `src/app/tokens.css:606`. There is a Light / Dark / System switcher in the topbar
(`src/components/kit/app-topbar.tsx`), but nothing sets the coach's default, so a coach on a
system-dark machine gets the dark console. Alec's anchor build was light-only.

**Body type is 13px** (`tokens.css:767`) and the button scale is 26 / 30 / 34px
(`src/components/kit/atomics/button-class.ts:12-14`). Every one of those is below a 44px tap
target and the two smaller button sizes are below any reasonable minimum for a 60-year-old on a
laptop trackpad.

### Counts, current vs. old

Section counts are of top-level blocks on the screen. Control counts are interactive elements
(buttons, links-as-actions, tabs, form controls) reachable without opening a row. Word counts are
an upper-bound approximation — quoted string literals of eight characters or more, comments
stripped — so treat them as a ratio, not a census.

| Screen | Sections | Controls | Decisions asked of the coach | ~Words |
|---|---|---|---|---|
| `/coach/home` (current) | 8 | 3 buttons, 2 date inputs, 6-stop window picker, 4 links | Which measurement window; whether to open the outage dialog | ~520 |
| Old coach home (`40c58b5`) | 4 | 6-stop range picker, 2 date inputs, 6 bubble links, 2 export menus, 1 trend-metric switcher | Which date range | ~250 |
| `/coach/conversations` | 3 panes + rail | 13 actions, 6 filter controls, 7 named views + objection cohorts | Which view, which channel, which outcome, which thread, agent on/off, reply vs. note | ~920 |
| `/coach/contacts` (+ `/coach/pipelines`) | 5 KPI cards + table (+ kanban) | 5 actions, 11 filter/form controls | Which view, merge, unmerge, delete, stage moves | ~1,065 |
| `/coach/agent` | header + strip + attention card + 6 tabs | 20 actions, 32 form controls, 6 tabs | Six tabs' worth: program, qualification, voice, prices, assets, cadence — plus publish | ~2,500 |
| `/coach/get-started` | 4 receipt-backed steps | ~8 | Acknowledge, confirm consent, run safe test, review go-live | — |
| `/coach/integrations` | channel strip + per-channel detail | 9 | Connect / disconnect / reconnect per channel; templates | ~1,510 |
| `/coach/settings` | notification matrix | 3 control groups | Every rule × every delivery channel | ~310 |
| `/coach/billing` | 5 overline blocks | 18 actions, 6 inputs | Plan, attendance answers, correction requests, checkout | ~600 |
| `/coach/help` | 2 panes | 3 actions, 3 inputs, guide sections | Which request, what to write | ~310 |

Nine nav destinations, roughly **8,000 words** of coach-facing copy, and something like **120
interactive controls** before a single row is opened. The old build was six destinations and a
fraction of that.

---

## 2. Per-screen rulings

Ruling vocabulary: **KEEP** (already simple, ships as is), **ENLARGE** (survives, but bigger and
plainer), **MERGE** (folds into another screen), **DEMOTE** (leaves the coach surface — to admin,
to the account menu, or to a "request a change" action), **KILL** (gone).

### 2.1 `/coach/home` → **Home**

| Current element | Ruling | Why | What the old version did |
|---|---|---|---|
| PageHeader `title="Dashboard"`, description "Start with the queue, then scan the latest performance…" | **ENLARGE** | "Dashboard" is a category, not a greeting. Replace with `Welcome back, {first name}` and one plain status sentence. | `title="Welcome back, Marcus"` with a two-dot signal line: agent live on Instagram and Messenger; SMS registration still processing. |
| `MonoMeta` open-conversation count in the header actions | **KILL** | A mono readout in the corner is console furniture. The Inbox nav item carries a count already. | Not present. |
| "What needs you today" amber attention card (up to 3 tiles + blocked-channel dialog) | **DEMOTE** → one count on the Inbox nav item and one line in the Booked/Active bubble | **Alec already removed this twice.** R3-1: "remove this from dashboard". R4-4 deleted the mini-ledger footers and the ledger records that he accepted the consequence — "home now carries no needs-you signal at all". Phase 11 put a bigger version of it back, at the top, in amber. See open question **Q1**. | The Active bubble's mini-ledger read "Agent handling 27 / Needs you 4" and linked to the inbox. |
| Blocked-channel dialog (stopped-at, recorded state, unprocessed events, provider reason) | **DEMOTE** → admin + a plain sentence | Five diagnostic facts about a webhook backlog is an operator's screen. A coach needs "Instagram stopped answering on Tuesday. We're on it." and nothing else. | Not present. |
| "What came of it" — StatStrip of show rate, avg time to book, pipeline win rate | **MERGE** into the six bubbles | Two figure rows on one screen is the same object said twice, and the caps eyebrow is the worst offender in the product. | One row of six bubbles, no second strip. |
| "Yours to set, four things" panel + "Open your agent" link | **MERGE** into `/coach/agent` | It is a table of contents for another page, sitting on the page a coach opens most. The agent page already renders the same four with the same count. | Not present on home. |
| "Performance" section: heading, sub, 6-stop window picker, custom date pair, 5-tile StatStrip, "How these are measured" `<details>` | **MERGE** + **ENLARGE** | The five tiles become five of the six bubbles. The window picker stays — Alec asked for date ranges in round 1 and the old build had the identical six-stop control — but it moves up beside the greeting where the old build had it. | Identical `ChipTabs` 1D/1W/1M/3M/All/Custom in the page header's `actions` slot, with the custom date pair below it. |
| "How these are measured" methodology `<details>` (five denominators) | **DEMOTE** → one link, "How we count these", opening a single plain-English page | The denominators are real and must stay reachable for the technical reviewer. They are not a thing to put under a figure a coach is glancing at. | Not present. |
| "Six-month lead volume" overline + `TrendPanel` "Leads by month" + partial-month note + "About this trend" details | **ENLARGE** | This is R3-2 and R4-11, both of which Alec asked for by name. Keep one chart. Drop the overline, the sub, and the collapsible. | `ChartHero` under a "Company trend" heading with a metric switcher and an export. |
| Keyword performance panel (DataTable, export, "How keyword rates work" details) | **KEEP** + **ENLARGE** | R10 was a P1 ask in his own words ("FUNDS → 70% qualified leads…"). Keep the four columns, enlarge the rows, drop the collapsible. | Same four columns in a plain table with an export menu. |
| "Booked calls this billing period" allowance card | **KILL** from home | **R4-15 in his words: keep usage "only in billing".** The ledger records this as still open and needing his word before removal. See **Q2**. | Not present on home. The Booked bubble carried tier progress instead. |

**Resulting home:** greeting + status sentence + date-range control · six bubbles · one trend
chart · one keyword table. Four blocks. That is the old build's shape.

### 2.2 `/coach/conversations` → **Inbox**

| Current element | Ruling | Why | What the old version did |
|---|---|---|---|
| Seven named views (Agent handling, Needs you, Human handling, Follow-up, Closed, Scope blocked, Opted out) plus objection cohorts | **ENLARGE** down to three: **Needs you · Agent handling · Everything** | Seven views is six decisions before a coach reads a message. "Scope blocked" and "Opted out" are platform states a coach cannot act on. | Four chip filters: channel, All/Qualified/DQ, stage dropdown, search. |
| Objection cohort views (Qualified for a call / Not a fit / Still deciding) | **DEMOTE** → `/coach/agent` | These are analysis of how the agent is doing, not a queue to work. R11 already moved objection data to the agent tab. | Not present in the inbox. |
| Channel + outcome + stage filters and search | **MERGE** into one search box and one channel filter | Three faceted filters over a list a solo coach can scroll is more machinery than the list. | Search, channel chips, qualification chips, stage select — four controls; still one too many. |
| Bulk select + "Selected conversation actions" | **KILL** | Nothing in the four-things target requires acting on many threads at once, and a checkbox column is a mis-click surface. | Not present. |
| Three-pane layout (list / thread / lead-details rail) with a rail toggle | **KEEP** structure, **ENLARGE** the type | R2c asked for the toggleable rail by name and it works. | Same three panes, same toggle. |
| "Lead details" rail — Credit range, Funding goal, Timeline, Questions asked, Decision, Booking | **KEEP** | R4-2 renamed this to "Lead details" at his request. It is read-only facts, which is exactly the right shape for the coach side. | Same rail, named "Qualification". |
| Agent on/off toggle in the thread header | **KEEP** + **ENLARGE** to a 44px control | R3-4 is his: one toggle, not Take over / Hand back. It is the single most important coach action in the product. | `AgentToggle`, one control. |
| Composer with Reply / Internal note mode chips | **ENLARGE**; keep both modes | Notes are genuinely useful and the mode chips are two large targets, not a form. | Identical. |

### 2.3 `/coach/contacts` + `/coach/pipelines` → **Leads**

| Current element | Ruling | Why | What the old version did |
|---|---|---|---|
| Two routes, one nav item (`pipelines` is a `matchPaths` alias of Leads) | **MERGE** into one screen with a two-way **List / Board** switch | A destination a coach cannot navigate to is a bug the rail is hiding. One screen, one switch, two views. | Two separate rail items: Contacts and Pipeline. |
| Five KPI cards (Total · Convo active · Booked · Qualified · Disqualified) | **KILL** | Home already carries the figures. R4-3 reordered these because they were confusing; the simplification is to delete the row, not to reorder it a third time. | Same five-card row (this is the thing R4-3 was about). |
| Eleven filter and form controls above the table | **ENLARGE** down to a search box plus a **stage** filter | Everything else is a facet nobody asked for. | Search + a stage select. |
| Merge / unmerge duplicate contacts, with confirm dialogs and an undo bound to an audit row | **DEMOTE** → "Report a duplicate", one action, handled by support | The mechanism is good engineering and completely wrong for this audience. A coach should never be asked to reason about identity resolution. The audit-backed unmerge stays, operated by admin. | Not present. |
| "Delete this lead permanently?" with a `DELETE` type-to-confirm and a "What survives, on purpose" panel | **DEMOTE** → "Request deletion", one action | Irreversible destruction behind a typed confirmation is exactly what "take decisions away from them" means. Deletion has compliance obligations; route it through support so there is a record. | Not present. |
| Kanban drag-to-change-stage | **KEEP**, larger cards | R5-25 and D-12 bought this; it is the one direct-manipulation gesture that genuinely helps. | Drag-and-drop board. |
| CSV / JSON export | **KEEP** | Hard rule: every table exports. | Same. |

### 2.4 `/coach/agent` → **Your agent**

This screen is 3,487 lines, six tabs, twenty actions and thirty-two form controls. It is the
single largest violation of "as few options as possible", and R3-14 already records Alec's
umbrella verdict: *"we need to completely improve the My Agent section"*, and R3-13, *"clunky ugly
buttons. and text."*

| Current element | Ruling | Why | What the old version did |
|---|---|---|---|
| Six tabs: Your program · Who qualifies · How you sound · Prices · Marketing assets · Follow-up | **MERGE** to four cards on one page, no tabs | `COACH_OWNED_SECTIONS` already names the honest four — prices, voice, qualification, cadence (`coach-owned-sections.ts:46-67`). "Your program" and "Marketing assets" are content-supply tasks, not settings. | The old build had `ws-coach-offer-section` blocks and a rule toggle per row. |
| "Your program" tab (program name, description, results timeline, refund policy) | **DEMOTE** → an intake request | This is information SetterFi needs *from* the coach once. It belongs in onboarding or a "tell us about your program" form that support processes — not a permanent editable surface. | Present as an editor section. |
| "Marketing assets" tab (asset name, HTTPS link, proof, case studies) | **DEMOTE** → "Send us your materials", one upload/link action | R4-20 moved Proof here; R3-12 is still open with Alec's own "you already have this elsewhere". Making it an inbox rather than an editor settles both. | Present as an editor section. |
| **Prices** (add/remove rows, label, amount, billing period) | **KEEP** as a coach control | One of the four. It is the thing the agent quotes and only the coach knows it. | Editable. |
| **Who qualifies** (min credit, funding goal min/max, monthly revenue min, credit repair, refund posture) | **ENLARGE** to six large stepper/choice rows, no free text | One of the four. Six numeric bounds is the simplest control that can express it. | Editable rules with toggles. |
| Qualification question **order** and per-question on/off | **DEMOTE** → statement + "request a change" | R6 and item #2 [P1] asked for toggleable and reorderable questions. That is a drag-reorder list — precisely the interaction this audience cannot use. See **Q3**. | Toggle + reorder list. |
| **How you sound** (three-stop brand-voice slider + three short written answers) | **KEEP** | One of the four, and R4-17/R4-18 are Alec's own design for it: a three-stop slider and three short questions instead of a paste box. It is already the right shape. | Voice controls. |
| **Follow-up** (purpose per touch; platform owns count and timing) | **KEEP**, simplified to one dropdown per touch | One of the four. The platform already owns everything except the purpose. | Cadence purposes. |
| StatStrip of sections-set / price-count / escalation | **KILL** | A progress meter over a settings page is console furniture. | Not present. |
| In-page "AttentionQueue" of blockers | **MERGE** into the four cards — an unset card says so on its own face | Two things pointing at the same gap. | Not present. |
| Publish / draft lifecycle with `StateBadge` "Draft, unpublished" and a save bar | **ENLARGE** to one **Save** button; publish becomes automatic | A coach should not have to understand draft-versus-published. Platform review still runs; it just isn't the coach's verb. See **Q4**. | Save + publish with a dirty state. |
| "Top objections" rail | **KEEP** | R4-22 is his; it belongs here, not on home. | On home, then moved by R3-3/R11. |

### 2.5 `/coach/get-started`

| Current element | Ruling | Why | What the old version did |
|---|---|---|---|
| Nav item "Get started" | **DEMOTE** → a card at the top of Home that disappears when provisioning completes | It is a temporary state, so it should not hold a permanent rail slot. | Not a rail item. |
| Four receipt-backed steps (business details · carrier review · safe test · go live) | **KEEP** the steps, **ENLARGE** the presentation | This is the honest-states machinery and it is contractual. A coach genuinely needs to see the SMS day counter. | — |
| Receipt detail (welcome input hash, campaign hash, consent page version, carrier decision code, filed-by, filed-at) | **DEMOTE** → admin, behind "Show the technical record" | Hashes and carrier decision codes are evidence for the reviewer, not a coach's reading. | — |
| The SMS day counter | **KEEP** verbatim | Hard rule: real day counter, never a percentage, never a predicted date. | — |
| "Instructions and videos" (item #10, still open) | **KEEP** as a plan | The one place richer content genuinely helps this audience. Ties to R7's "Tips & trainings" Notion link. | — |

### 2.6 `/coach/integrations` → **DEMOTE off the rail**

Roughly 1,500 words and nine actions about OAuth state, reply windows, connection history, last
error, and "What to try". Every channel state is either fine (nothing to do), provisioning (a day
counter), or broken (SetterFi's problem).

**Ruling:** the rail item is **KILLED**. Connection state appears in exactly two places: the
Get-started card on Home during provisioning, and a one-line sentence on Home when something
breaks — *"Instagram stopped answering on Tuesday. We're fixing it."* The connect/reconnect action
survives as one large button on the Get-started card. Reply windows, connection history, last
error, and message templates move to admin. Conflict: **R3-10** added a Setup tab to My agent for
exactly this, and **item #4** was a decision about integrations in coach settings. See **Q5**.

### 2.7 `/coach/settings` (notification preferences) → **DEMOTE to the account menu**

A rule × delivery-channel matrix with required and optional rows, test-data scope, and saved-state
feedback. **Item #28** made coach-facing notification rules a P1, and **R7** put Settings
(notifications, integrations) in the account popover, which is where it should be — off the rail,
reachable, rarely opened. Reduce the matrix to **one question: where do you want to be told?
Email · Text · Both.** Everything else becomes a statement of what SetterFi already sends. See
**Q6**.

### 2.8 `/coach/billing` → **Billing**

| Current element | Ruling | Why |
|---|---|---|
| Five caps overlines (CHARGE · CORRECTION · NOTICES · OUTCOMES · PERIOD) | **KILL** the overlines, keep the blocks with sentence-case headings |
| "Your plan" + "Billing period" + booked-call allowance | **KEEP**, one card, large type | This is target (d) and R4-15 says usage lives here and only here. |
| "How did these appointments go?" attendance question | **KEEP** | It is a genuine question only the coach can answer, and it is two large buttons per row. |
| "Request a billed-count correction" (draft copy, reason, request-in-flight) | **ENLARGE** to one button, "This count looks wrong" → free-text box → sent | Right instinct, too much form. |
| "Billing notices" list | **MERGE** into the plan card as a single line when one is outstanding |
| Stripe checkout return handling | **KEEP** | Invisible plumbing. |

### 2.9 `/coach/help` → **DEMOTE to a floating support bubble**

**R9 is Alec's own ask**: "if we have this the coach needs it too. maybe add a support bubble in
their space." Two panes and a guide library is a help *centre*; a bubble is a way to ask a person.
Keep the guides behind the bubble, and add R7's Tips & trainings link to his Notion videos beside
it. Off the rail.

### 2.10 Global chrome

| Current element | Ruling | Why |
|---|---|---|
| Command palette (⌘K) | **KILL** on the coach side | A keyboard-shortcut launcher for a five-screen app aimed at non-technical users over 55. |
| Notification bell | **KEEP**, larger target |
| Theme switcher (Light / Dark / System) | **KEEP** the control; change the coach **default to Light** | Per the ruling on this pass: light default, toggle available. |
| Breadcrumbs (`Coach › Home`) | **KILL** on the coach side | Two levels of breadcrumb over a flat five-item rail is decoration. |
| Sidebar collapse toggle | **KILL** on the coach side | Five items always visible. One fewer state to be in. |
| Account menu | **ENLARGE** to R7's shape: Tips & trainings · Billing · Settings · Sign out |
| Impersonation banner (admin viewing a coach) | **KEEP** | Non-negotiable. |

### 2.11 Affiliate (lighter pass)

`/affiliate` is one route, 545 lines, three states, and one table titled "Your referrals". It is
already close to the target and R4-32 removed the approval queue in favour of a self-serve
referral link. Rulings: **KEEP** the referrals table; **ENLARGE** the type and the copy-link
button to the accessibility floor below; apply the same light default and sentence-case voice;
**KILL** any caps overlines. No IA change.

### 2.12 Consumer (lighter pass)

`/consumer` is the lead's experience, not the coach's, and the lead is not the older audience this
brief is about — leads arrive from Instagram and SMS across every age. Rulings: apply the **type
floor and the 44px target minimum** (they are on phones, where it matters more), keep the light
default, and change nothing structural. The hard rules about grounding and hard-gated pricing are
untouched.

---

## 3. The resulting coach IA

Five rail items, one group, no group label.

1. **Home** — greeting, date range, six bubbles, one trend chart, one keyword table. Plus the
   Get-started card while provisioning is incomplete, and a one-line outage sentence when a
   channel breaks.
2. **Inbox** — three views (Needs you · Agent handling · Everything), search, channel filter,
   three panes, the agent on/off toggle, the lead-details rail.
3. **Leads** — one screen, List / Board switch, search plus stage filter, export.
4. **Your agent** — four cards: Your prices · Who qualifies · How you sound · What each follow-up
   says. Plus the Top objections rail. One Save button.
5. **Billing** — plan, period, allowance, the attendance question, one "this count looks wrong"
   button.

Off the rail: support bubble (bottom-right, always), account menu (Tips & trainings · Billing ·
Settings · Sign out), notification bell.

Gone from the coach side: Get started as a destination, Connections, Notifications as a
destination, Help as a destination, the command palette, breadcrumbs, the sidebar collapse.

---

## 4. Every remaining setting, as a statement or a request

The rule: **no toggles, dropdowns, or forms on the coach side unless the item is one of the four
things.** Everything else is either a sentence stating what SetterFi chose, or one button that
sends a request.

**Coach controls that survive (the four things only):**

| Setting | Control | Why it is the simplest possible one |
|---|---|---|
| Your prices | A list of rows: name, amount, "per month / one time". One large **Add a price** button. | Only the coach knows the number. |
| Who qualifies | Six large rows, each a number or a two-way choice. No free text. | Bounds, not prose. |
| How you sound | A three-stop slider (Friendly · Balanced · Professional) and three short questions. | R4-17 and R4-18 are Alec's own design. |
| What each follow-up says | One dropdown per touch, from a fixed list of purposes. | The platform already owns count, channel, and timing. |

**Everything else becomes a statement.** Format: what we do, in one sentence, with a "Request a
change" link only where a change is actually possible.

- Question order — *"We ask about credit first, then funding goal, then timeline. This order books
  the most calls across every coach we run."* → Request a change.
- Reply timing — *"Your setter replies within about a minute, day or night."* → no request.
- Quiet hours — *"We don't text between 9pm and 8am in the lead's own timezone."* → no request
  (compliance).
- Spam and opt-outs — *"Every text carries STOP. We honour it instantly and never message that
  number again."* → no request.
- Objection handling — *"We answer the twelve objections your industry hears most, in your voice."*
  → Request a change.
- What the agent may claim — *"Your setter can't invent a price, a guarantee, or a result. It
  quotes only what you saved above."* → no request.
- Who gets hot leads — *"Hot leads land in your inbox and we text you."* → Request a change.
- When you take calls — *"We book into the calendar you connected, in its own availability."* →
  Change it in your calendar.
- Channels — *"Instagram and Facebook are answering. Text messages are on day 14 of about 21."* →
  no request; the counter is the answer.
- Notifications — one question, three answers: Email · Text · Both.
- Your program, your materials, your proof — *"Send us anything you want your setter to know."* →
  one **Send us your materials** action.

Every "Request a change" opens the support thread with the section pre-filled. That is one code
path, one audit trail, and zero new coach-side forms.

---

## 5. The accessibility floor

Non-negotiable minimums for every coach, affiliate, and consumer surface. Admin is exempt.

**Type.** Body text **16px minimum** (currently 13px at `tokens.css:767`). Secondary and helper
text **14px minimum** — nothing below it, ever. Figures on the bubbles **32px minimum**. Page
title **28px**. Section headings **20px**.

**The 9.5px mono overline is banned on the coach side.** `Overline`
(`src/components/kit/atomics/type.tsx:20`) may not render on `/coach/*`, `/affiliate`, or
`/consumer`. Where a label is genuinely needed it is 14px sentence-case regular weight. The
`.t-th` table-header treatment (11px uppercase, `tokens.css:805`) rises to 14px sentence case on
these surfaces.

**No uppercase.** No `text-transform: uppercase` anywhere on the coach side, including status
badges. No letter-spacing above 0.

**Targets.** Every interactive element is **44 × 44px minimum**, including the hit area of icon
buttons, table row actions, chips, tabs, and nav items. The current button scale — 26 / 30 / 34px
(`atomics/button-class.ts:12-14`) — is replaced on coach surfaces by a single **48px** height for
primary and secondary buttons and **44px** for anything smaller. Table rows use
`--row-h-comfortable` (48px, already defined at `tokens.css:185`) and never `--row-h-compact`.
Adjacent targets get **8px minimum** of separation.

**Contrast.** Body text ≥ **7:1** against its background (AAA, not AA — this audience is the
reason the AAA threshold exists). Every non-text control boundary and every status dot ≥ **3:1**.
Status is never carried by colour alone: every tone carries a word.

**One primary action per screen.** Exactly one filled accent button in view at a time. Everything
else is a plain button or a link. Where the current design spends the accent twice, the second
spend becomes neutral.

**Theme.** Coach, affiliate, and consumer surfaces **default to light** regardless of system
preference. The topbar Light / Dark / System switcher stays and their choice persists; the default
they have never touched is Light, not System. Implementation: the coach shell stamps
`data-theme="light"` unless a stored preference says otherwise. Admin keeps System.

**Motion.** `prefers-reduced-motion` is already respected; no change. No animation on a number
that a coach is trying to read.

**Focus.** The existing 2px `--focus-ring` at `tokens.css:781` stays and must be visible on every
one of the enlarged controls.

---

## 6. Demo data: what the reseed must produce

The current demo tenant makes every coach screen render "not yet". That is a seeding defect, not a
design one, and it accounts for roughly half of what Alec reacted to. **D-11's default — reseed
with plausible names and an even stage distribution — is the right call and this spec depends on
it.**

**Root cause.** `scripts/seed-phase7-demo.mjs:235-283` writes six contacts, six conversations, and
five messages, all stamped `2026-06-01`. Home's default window is `1m`. Nothing in the seed falls
inside it, so `metricAvailability` returns `needs-history` and every tile prints "not yet · day 31
of about 31 needed".

**What the reseed must satisfy:**

- **Dates are relative to now, not hard-coded.** Every `created_at`, `stage_set_at`, and
  `status_changed_at` is computed from the seed run's clock. A demo that goes stale in eight weeks
  will go stale again.
- **Volume.** At least **200 contacts** spread over **six full calendar months**, with **at least
  60 inside the trailing 30 days** so the default `1m` window has a real denominator on every one
  of the five summary metrics *and* the three outcome metrics.
- **Two complete calendar months minimum** of lead volume, or `TrendPanel` refuses to draw a line
  (`coach-measurement.tsx:1003`). Six months is the target so the chart matches the anchor build.
- **Every metric resolves to a number.** Specifically: booked contacts, active leads, new leads,
  conversion rate, qualified leads, show rate, average time to book, and pipeline win rate. Each
  needs a positive denominator — `requiresPositiveDenominator` is checked at
  `coach-measurement.tsx:233-243`.
- **Keyword attribution on most conversations.** The keyword table's `Rate` prints an en dash and
  "No conversations" on a zero denominator (`coach-measurement.tsx:285-297`). Seed **five or six
  keywords** with genuinely different rates, matching the shape Alec asked for in R10 (FUNDS →
  70% / 20% / 10%; 100K → 30% / 10% / 1%).
- **An even pipeline distribution** across every stage so the board and the composition chart both
  read as a working book, per D-11.
- **Plausible names and businesses**, not "Test lead" and "Demo scope blocked" — this is the whole
  point of D-11 and the reason R5-20's populated-state review was impossible.
- **Allowance mid-period**, e.g. 18 of 25 booked, so the Billing card shows a real reading. The
  old build's Booked bubble used exactly 18/25.
- **A live channel state**: Instagram and Facebook live, SMS mid-registration on a plausible day
  count, so Home's status sentence reads like the anchor's ("Your agent is live on Instagram and
  Messenger" + "SMS registration is still processing").

**Test-data discipline is unchanged and non-negotiable.** Every seeded row keeps `is_test = true`
and lives on the demo tenant with `is_demo = true`. Real-workspace analytics still exclude them
through `analytics_contacts` and the existing `PHASE7_EXPORT_EXCLUSION_VIEWS` arming rules.
Screens still label the workspace as demo. The reseed changes the *shape* of the demo data, never
the segregation.

---

## 7. Cross-check against DEMO-FEEDBACK rounds 1–4

Where a simplification contradicts something Alec asked for, it is flagged here as a decision for
him rather than silently taken.

**Confirmed by this pass — the simplification is what he already asked for:**

| Item | His ask | This spec |
|---|---|---|
| R3-1 | "remove this from dashboard" (the needs-you strip) | The attention card leaves home. |
| R3-2 | Company trend graph above keyword performance | One trend chart above one keyword table. |
| R3-3 | Move "Where leads stop replying" to the agent tab | Analysis lives on `/coach/agent`. |
| R3-4 | One agent on/off toggle | Kept, enlarged to 48px. |
| R3-13 / R3-14 | "clunky ugly buttons. and text."; "completely improve the My Agent section" | Six tabs → four cards. |
| R4-4 | Delete the mini-ledger footers from all six bubbles | Bubbles carry a label, a number, one sentence. |
| R4-5…R4-10 | Drop the eyebrows; retitle; plain-English descriptions | Ledger says these are PARTIAL — the generated "Denominator / Window / Clock" descriptor is still the card note. This spec replaces it with his copy and moves the descriptor behind "How we count these". |
| R4-13 | Remove the Company trend subhead | No subhead. |
| R4-15 | Usage belongs only in Billing | The allowance card leaves home (**Q2** confirms). |
| R4-22 | Top objections beside the questions | Stays on the agent screen. |
| R9 | A support bubble in the coach's space | Help becomes the bubble. |
| R7 | Account menu: tips & trainings, billing, settings | Exactly the account menu shape. |
| R10 | Keyword performance on coach home | Kept as one of four blocks. |
| R11 | Move objections/setup data off home to the agent tab | Both stay off home. |

**Conflicts — Alec asked for something this spec would remove or reduce:**

| # | His earlier ask | What this spec would do | Decision |
|---|---|---|---|
| C1 | **Item #2 [P1]** — qualification questions must be **toggleable and reorderable** by the coach; **R6** made the agent tab tabbed | Question order becomes a statement plus "request a change"; the six tabs collapse to four cards | **Q3** |
| C2 | **R3-10 [P1]** — add a **Setup tab** to My agent for integrations and setup; **item #4** — integrations in coach settings | Connections leaves the coach surface entirely | **Q5** |
| C3 | **Item #28 [P1]** — coach-facing **notification rules** | The rule matrix becomes one question (Email / Text / Both) in the account menu | **Q6** |
| C4 | **Item #7 [P2]** — coach agent-level analytics, marked **"super important"**; **item #12** — conversation-step funnel and response rate | Home holds six figures, one trend, one keyword table; the funnel and step analysis stay on the agent screen | **Q7** |
| C5 | **Item #10 [P2]** — get-started should be **richer**, with instructions and videos | Get started stops being a destination and becomes a temporary Home card | **Q8** |
| C6 | **Item #1 / R4-21 / R4-23** — the offer editor's section order and structure, repeatedly refined across four rounds | Four cards, no tabs, no section ordering | Folded into **Q3** |
| C7 | **R4-11 [P1]** — company trend becomes a **stacked composition bar chart**; **R4-12** restyled the line chart | One chart on home. Two chart types on one block is more than the anchor had | **Q9** |
| C8 | **R2b** — read/unread plus **channel, qualified/DQ, and stage filters** on conversations | Three views, search, one channel filter | **Q10** |

**Two notes on the ledger's own reliability.** First, the round-4 feedback ledger cites
`src/components/workspace/primitives.tsx`, `src/app/workspace-coach-redesign.css`, and
`workspace.css` — all of which Phase 11 replaced with `src/components/kit/` and `tokens.css`. The
*rulings* stand; the file citations in that document are stale and should not be used to locate
code. Second, R4-15's own restore note says the home allowance deck "is a product decision, not a
bug… so it needs Alec's word before removal, and R4-15 stays open until it gets one" — which is
exactly why **Q2** is on this list rather than being decided here.

---

## 8. BRIEF FOR CLAUDE DESIGN

*This section is self-contained. A designer can work from it without reading anything above.*

### Who this is for

Credit and business-funding coaches who bought an AI appointment setter. They skew **older** —
think 50s and 60s — and they are not technical. They open this product to see whether calls got
booked, to answer a lead when the robot needs a human, and to pay their bill. They are not
operators, they do not want a console, and every decision you put in front of them is a decision
they did not ask for.

The client's exact words: *"my user base skews older, everything must be large and easy to click"*
and *"give them as few options as possible, take decisions away from them."*

### The visual anchor

The round-3 preview build, which the
client calls "simple and dummy-proof" and prefers to what replaced it.

What to take from it: the **light theme**, the **warm greeting** ("Welcome back, Marcus"), the
**six KPI bubbles each carrying one plain sentence**, **one trend chart**, **one keyword table**,
and the **sentence-case conversational voice** throughout. Take the *feel and the scale*, not the
markup — the code behind it no longer exists.

What not to take from it: it was a click-through prototype with fixture data, so nothing about its
data handling is a model.

### The five screens

**1. Home.** "Welcome back, {first name}." Under it, one plain sentence about what the agent is
doing right now ("Your agent is live on Instagram and Facebook. Text messages are on day 14 of
about 21."). A date-range control top-right: 1 day · 1 week · 1 month · 3 months · All · Custom.
Then **six large bubbles** — Booked calls, Active leads, New leads, Disqualified, Conversion,
Average time to book — each a big number, a plain name, and one sentence explaining it in the
coach's language ("qualified booked calls", "leads your agent is actively trying to book", "poor
fit due to credit, finances, or timing"). Then **one line chart**, leads by month, six months.
Then **one table**, keyword performance: keyword, qualified leads, response rate, booked rate.

Two conditional pieces: while setup is incomplete, a **Get started card** sits above the bubbles
with its four steps and a real day counter for SMS registration. If a channel breaks, one sentence
above the bubbles — "Instagram stopped answering on Tuesday. We're fixing it." No dialog, no
diagnostics.

**2. Inbox.** Three panes: a thread list, the conversation, and a read-only "Lead details" rail
that can be hidden. Above the list, **three views only** — Needs you · Agent handling · Everything
— plus a search box and a channel filter. In the thread header, one big **agent on / agent off**
toggle. At the bottom, a composer with two modes, Reply and Internal note. The lead-details rail
shows credit range, funding goal, timeline, questions asked, decision, booking — facts, not
controls.

**3. Leads.** One screen with a **List / Board** switch. List is a table: name, channel, stage,
last activity, outcome. Board is a kanban of pipeline stages with drag to move a card. Above it, a
search box and a stage filter — nothing else. An Export button. Two request actions per lead:
"Report a duplicate" and "Request deletion". Neither performs the action; both open a message to
support.

**4. Your agent.** A short line at the top: "Four things are yours. We run everything else." Then
**four large cards**, each showing what is set right now on its face, opening to edit in place:

- **Your prices** — rows of name / amount / per month or one time, and one big Add a price button.
- **Who qualifies** — six rows: minimum credit score, minimum and maximum funding goal, minimum
  monthly revenue, credit repair yes/no, refund posture. Numbers and two-way choices only.
- **How you sound** — a three-stop slider (Friendly · Balanced · Professional) and three short
  written questions.
- **What each follow-up says** — one dropdown per scheduled touch, from a fixed list.

Beside them, a **Top objections** rail — read-only, what leads push back on most.

Below the four cards, a list of **statements** about everything SetterFi runs: reply timing, quiet
hours, opt-outs, what the agent may claim, who gets hot leads, when calls are booked. Each is one
plain sentence. Some carry a small "Request a change" link; most carry nothing.

One **Save** button at the bottom. No draft state, no publish step, no tabs.

**5. Billing.** One card: the plan, what it costs, the current period, and booked calls used of
the allowance. Below it, "How did these appointments go?" — a short list of recent bookings with
two big buttons each (Showed / No-show). One button, "This count looks wrong", opening a text box.

### Everywhere

A **support bubble**, bottom-right, on every screen. An **account menu** in the top-right:
Tips & trainings · Billing · Settings · Sign out. A **notification bell**. That is the whole of
the global chrome.

### The rules that make it work

- **Light theme by default**, always, regardless of what the coach's computer prefers. A
  Light/Dark/System switcher exists and their choice sticks, but nobody lands in dark.
- **Body text 16px minimum. Nothing below 14px, ever.** Figures on the bubbles 32px or larger.
- **No uppercase text anywhere.** No wide letter-spacing. No tiny mono labels.
- **Everything clickable is at least 44 × 44px**, and buttons are 48px tall. Table rows are 48px.
  Adjacent targets keep 8px apart.
- **Body text contrasts at 7:1 or better.** Status never depends on colour alone — every state
  carries a word.
- **One filled accent button in view at a time.** Everything else is plain.
- **Sentence case, conversational voice, everywhere.** Write to a **grade 6–8 reading level**:
  short sentences, everyday words, second person, contractions. "We'll text you when a lead needs
  you" — not "Escalation notifications are dispatched via the configured channel."
- **State what we chose, don't offer a choice.** If a coach doesn't need to decide it, tell them
  what happens in one sentence instead of giving them a control.
- **Honest states stay honest.** Nothing reads "done" or 100% while anything is provisioning. SMS
  registration shows a real day counter — never a percentage, never a predicted date, never "all
  set."

### Do not include

- Caps eyebrows or overlines of any kind — no "WHAT CAME OF IT", no "YOURS TO SET", no "NEEDS YOU"
- Mono type as a label; mono is for numbers in tables only
- A command palette or any keyboard shortcut UI
- Breadcrumbs
- A collapsible sidebar, or a sidebar with more than five items
- Density toggles, view switchers beyond List/Board, or any layout preference
- Collapsible "How this is measured" panels under figures
- Progress meters over settings ("3 of 6 sections set")
- Methodology text, denominators, windows, or clock notes on a figure's face
- Draft / published lifecycle badges
- Bulk-select checkboxes on any list
- Merge, unmerge, or permanent-delete flows — including type-to-confirm dialogs
- Diagnostic detail: webhook counts, connection history, reply windows, OAuth state, error codes,
  hashes, carrier decision codes, "recorded state"
- More than one chart per screen
- More than one filled accent button in view
- Dark-theme-first design of any kind
- Anything under 14px, anything uppercase, anything under a 44px target
- GoHighLevel branding, anywhere
- Cost or margin figures, anywhere on a coach screen

---

## 9. Open questions for Alec

Each carries the default this spec assumes if he doesn't rule.

**Q1 — The "needs you" signal on Home.** You asked twice to get the attention strip off the
dashboard (R3-1, and you accepted losing the signal in R4-4). The rebuild put a bigger amber
version back at the top. But a coach still needs to know a lead is waiting.
*Recommended default:* remove the card; carry the signal as a **count on the Inbox nav item** and
one line in the Active bubble. *If you'd rather:* keep one quiet line above the bubbles, not a
card, not amber.

**Q2 — The booked-call allowance on Home.** R4-15 said usage belongs "only in Billing", and the
allowance card is still on Home. It was added deliberately in Phase 7, so it needs your word.
*Recommended default:* delete it from Home. Billing carries it.

**Q3 — Qualification questions: control or statement?** You asked (item #2, P1) for questions the
coach can **toggle and reorder**. That is a drag-to-reorder list, which is the hardest possible
interaction for this audience.
*Recommended default:* the order becomes a sentence — "We ask about credit first, then funding
goal, then timeline" — with a "Request a change" link. The bounds (credit, funding, revenue) stay
directly editable. *If you'd rather:* keep on/off switches, drop reordering.

**Q4 — Draft and publish on the agent screen.** Right now a coach saves a draft, then publishes,
and the publish triggers a platform review.
*Recommended default:* one Save button. The review still runs behind it; the coach never sees the
word "publish". *If you'd rather:* keep publish as an explicit step so a coach can't change what
the agent quotes by accident.

**Q5 — Connections.** R3-10 (P1) added a Setup tab to My agent for integrations. This spec removes
the coach's connections screen entirely — channel state appears on Home during setup and as one
sentence when something breaks; everything else moves to your team.
*Recommended default:* remove it. Your success team reconnects a broken channel faster than a
coach will. *If you'd rather:* keep one large "Reconnect Instagram" button on Home when a channel
is down, and nothing else.

**Q6 — Notification rules.** Item #28 (P1) asked for coach-facing notification rules. This spec
reduces the matrix to one question in the account menu: Email · Text · Both.
*Recommended default:* the one question. *If you'd rather:* two questions — how to be told, and
whether to be told about every lead or only hot ones.

**Q7 — Agent-level analytics.** You called this "super important" (item #7) and asked for a
conversation-step funnel and response rate (item #12). Home now holds six figures, one trend, and
one keyword table.
*Recommended default:* the funnel and step analysis live on the **Your agent** screen, under Top
objections, where R3-3 and R11 already put that kind of data. Home stays at four blocks.

**Q8 — Get started.** Item #10 asked for a richer get-started with instructions and videos. This
spec makes it a card on Home that disappears when setup completes.
*Recommended default:* the Home card, with the videos reached through Tips & trainings in the
account menu. *If you'd rather:* keep it as a sixth rail item, visible only until setup finishes,
then removed.

**Q9 — One chart or two.** R4-11 (P1) made the trend a stacked composition bar chart, and R4-12
restyled the line chart. Both currently render.
*Recommended default:* one chart — the six-month line, matching the anchor build. *If you'd
rather:* keep the stacked bars and drop the line.

**Q10 — Inbox filters.** R2b gave conversations channel, qualified/DQ, and stage filters plus
read/unread. This spec cuts to three views, a search box, and a channel filter.
*Recommended default:* the cut. A solo coach's inbox is scrollable. *If you'd rather:* add back
the qualified/DQ filter only.

**Q11 — Theme default.** Confirmed on 2026-08-31: coach surfaces default to **light** regardless
of system preference, with the Light/Dark/System switcher still available. Recorded here so the
decision has a home.

**Q12 — Do the coach's numbers need to be real for the next review?** The reseed in §6 produces
plausible, fully-populated demo data on the demo tenant. It does not make the real analytics
pipeline produce different numbers for a real coach with no history — that coach will correctly
see "not yet".
*Recommended default:* reseed the demo tenant, and accept that a genuinely new coach sees honest
empty states. The hard rule says nothing may read "done" while it isn't.
