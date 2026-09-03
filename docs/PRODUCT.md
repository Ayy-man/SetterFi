# SetterFi — Product Spec (surfaces, data, actions)

Every surface, what data it shows, and what actions it supports. The HTML export is the visual
reference; this is the functional contract. Three role-scoped internal apps in one product:
Admin, Coach (client portal), and Affiliate — plus the white-label Consumer experience,
self-serve onboarding, and the shared "Meet Your Agent" surface.

## Global chrome

- Navigation is role-scoped, and since the redesign every role runs the left rail
  (`src/lib/workspace-navigation.ts` is the single source). Admin groups under tiny caps labels:
  **Run** (Overview, Inbox, Client requests, Channel health, Provisioning, System) · **Clients**
  (Client book, Agents, Agent performance) · **Money** (Revenue and subscriptions, Plans and
  pricing, Affiliates and payouts, Corrections) · **Brain** (The Brain, Evals, Compliance) ·
  **Platform** (Audit, Account terms, Help). Coach runs one flat **Workspace** group:
  **Home · Inbox · Leads · Your agent · Get started · Connections · Notifications · Billing ·
  Help** (a floating support bubble stays on every screen, and the topbar bell and account menu
  both also reach Notifications). Affiliate / Partner runs the same rail with a single
  **Partner earnings** entry. On mobile the rail moves into the accessible drawer.
- Coach and Partner decks are **Even** — equal-height panels in one top-aligned row (round 2,
  Alec's mock). Round 3 removed the Even / Variable toggle and its stored preference, so this is
  the only composition; nothing bottom-aligns or floats. Mobile stacks at natural content
  height.
- Top bar: workspace switcher, role chip, breadcrumb, ⌘K search, notification bell (booking
  alerts), avatar. A black "Platform health" card pinned at the sidebar bottom (admin).
- Skeleton loaders on every surface — a blank loading state is a defect. Floating sticky bar for
  unsaved/unpublished changes (Discard / Publish).
- **Every table exports CSV and JSON** — no exceptions. **Every privileged action shows "Logged"
  microcopy** and writes an audit entry. ⌘K search spans the current role's scope. Test/sandbox
  data is visually labeled and segregated from real analytics everywhere it appears.
- The qualification enum buckets are shared vocabulary used as fields, filters, and pills across
  Contacts, Conversations, the brain decision table, and evals — keep them identical everywhere
  (see ARCHITECTURE "Qualification").

## ROLES & PERMISSIONS

- **Owner** — everything.
- **Admin (systems lead)** — everything except billing payout settings.
- **Success / CSM** — clients, conversations, provisioning; no billing, no brain publish, and
  **no cost or margin figures anywhere** (T15-14 — economics are owner/admin only, by contract).
  Owns an assigned book of coaches: reads stay open across every client so cover is possible, but
  **writes are scoped to the tenants they own** (T15-10). Acting on someone else's client means
  taking ownership first — one click, audited, and it leaves the attribution correct.
- **Build seats** — the dev team, flagged "revokes at handover."
- Every privileged action (brain publish, takeover, meter adjustment, refund, tier change) writes
  an audit entry and shows "Logged" microcopy.

## COACH PORTAL (the client's four surfaces + settings)

1. **Home / Analytics.** Six KPI stat bubbles in one equal-height top-aligned row: booked calls
   (with the tier meter framed as achievement — "18/25", never a fee warning), active
   conversations, total leads, disqualified (with reasons), **conversion rate — leads to booked,
   cohort-attributed to the lead** (denominator is contacts created in the window, numerator is how
   many of those same contacts ever booked, whenever they booked; a still-filling current period is
   marked as such rather than presented as final — T12-1), avg time-to-book. The allowance bubble
   is **the one element on this page the date-range picker does not govern**: it runs on the
   coach's billing anniversary and states its own period on its face — "18 of 25 this billing
   period · resets 21 Sep" (T12-3).
   Below: the **company trend graph** (six-month line chart of the whole book, metric switcher
   across booked calls / qualified leads / total leads / booked rate, latest reading with
   month-over-month delta, exportable), and under it the **keyword performance table** (per
   campaign trigger word: qualified %, response rate, booked rate). Attribution is real —
   `conversations.first_touch_keyword`, indexed — so this is not demo data; what it needs instead
   is honest accounting. The table **always carries a "No keyword" row** so its rows cover the
   whole population, and **its denominator is conversations, labelled as such**, while every other
   number on this screen counts leads. The resulting discrepancy against total leads is labelled
   rather than reconciled, because a contact who arrives under one campaign and re-engages under
   another genuinely belongs to both (T12-7). Trend reading lives at the company
   level, not per keyword row (round 3). Ranked top objections moved to the Agent tab (round 2)
   and the conversation drop-off panel followed it there (round 3), so home is the deck, the
   trend, and the keyword table — nothing else. Date ranges 1D/1W/1M/3M/All/Custom.
2. **Conversations.** Unified inbox, master-detail, three panels flush to one top line. Thread
   list with channel chip (IG/FB/SMS), per-thread agent status, pipeline-stage label, and an
   **unread dot** that clears when the thread opens (session state; real read receipts are a
   backend item). Filters: channel, Qualified/DQ (from the captured outcome), and pipeline stage,
   plus search. Thread header carries the channel chip, lead name, a **Details toggle** that
   shows/hides the Lead Details rail, and one **agent toggle** (round 3) that reads "Turn off
   agent" while the agent runs the thread and "Turn on agent" once a human has it — green when
   active, grey when off. That button is the only place thread agent-state is stated; the old
   "Agent live" readout and the "Agent is handling this thread" composer line are gone.
   Turning the agent off inserts an in-thread system line ("Automation paused · [name] took
   over"), flips status to paused/human, and swaps the composer to human mode (Reply vs internal
   Note); turning it back on restores AI with context. It stays audit-logged. The Lead Details rail: the
   qualification the agent captured (credit range, funding goal, timeline, business), a live 3–5
   sentence AI summary, and booking status (proposed slots / confirmed).
3. **Contacts.** Six click-to-filter KPI bubbles pinned top, all counts (round 3): Total, Convo
    active, Booked, Qualified, Disqualified, Agent off. "Failed" is deliberately not a word here —
   a lead that does not qualify is disqualified, not an agent error. Booked (a call on the
   calendar) and Qualified (the agent's BOOK outcome) are distinct. Full-width lead table below:
   name, channel, credit range, funding goal, timeline, decision, status, last activity — with
   per-column show/hide toggles. Row opens the same qualification drawer as Conversations.
4. **Pipelines.** Kanban, columns top-aligned, every stage always visible (Booked shows even
   when empty). Column headers carry only the stage name + count — no "Pipeline stage" /
   "Agent-managed stage" label text. Pre-seeded stages (verbatim): New Lead · Qualification
   Active · Booked (won) · Qualified No Buy · Long-Term Follow-Up · No Show · Disqualified/Bad
   Fit (lost). The stage is a **stored column on the contact**, not a value derived from the
   agent's outcome — Long-Term Follow-Up is a human judgement, and deriving it would make the
   Kanban un-editable (T12-5). Schema values are canonical with the labels above as the UI
   mapping: `new_lead`, `qualifying`, `booked`, `qualified_no_buy`, `long_term_followup`,
   `no_show`, `disqualified` (T3-14, ANL-09). Automation writes `new_lead` at contact create,
   `qualifying` on the first captured answer, `booked` on appointment insert, and `disqualified`
   on `outcome = 'HARD_DQ'`; **a human's move wins** — automation only overwrites a system-set
   value, booking excepted. Won/Lost semantics feed analytics win rate, and the membership is
   fixed: **won is `booked`, lost is `qualified_no_buy` plus `disqualified`**, with `new_lead`,
   `qualifying`, `long_term_followup` and `no_show` open and on neither side, so win rate is
   `booked ÷ (booked + qualified_no_buy + disqualified)` (T3-16). Agent win rate filters
   `attributed_to_agent` and the coach's pipeline does not, and a canceled-never-rebooked lead
   leaves the win numerator while the allowance bubble does not move — the screen carries a
   sentence on that divergence (T12-5).
5. **My agent (settings).** Four internal tabs (round 2, plus Setup in round 3): **Your
   business** — the offer editor, rebuilt in round 3 into three numbered sections (01 Your
   program: name and credit products · 02 Who qualifies: the rules · 03 How you sound: a
   three-stop brand-voice slider and three short voice questions), where every on/off rule is a switch stating the
   rule in a sentence with state-dependent hint text, and a rule's input (minimum credit score)
   is revealed inside that rule's card only while it is on; usage lives only in Billing;
   **Qualifying leads** (enable/reorder qualification questions, **where leads stop replying** —
   the conversation drop-off panel moved here in round 3, and its Detailed mode reads the
   question list being edited directly above it — booking horizon/mode, top objections, follow-up cadence where every touch carries a purpose
   select: send free lead magnet / send free training / value nudge / proof point / new angle /
   last touch), **Marketing assets** (lead magnets and videos the cadence links to, plus proof and case studies), and
   **Setup** (round 3 — agent status / connected services, the finish-setup readiness checklist,
   and per-channel readiness; the provisioning surface, kept out of the offer editor).
   Editing shows a "republish" state. White-labeled integration cards keep infrastructure
   providers behind `Calendar` and `Text messages (SMS)`. "Talk to your agent" is a prominent
   test-data action. Billing (plan, invoices, seats) and Settings (notifications, integrations)
   live under the **account menu**, alongside a Tips & trainings external link (admin-configurable,
   points at the client's Notion videos/SOPs).
6. **Get-started checklist** (persistent, sidebar): the home of async state — "SMS registering
   with carriers, flips on automatically", add brand assets, invite team, run first test. Setup
   guidance adds numbered instructions, a preview video lesson for every stage, and a support path
   without replacing the assembly-line readiness state.
7. **Help and support.** Coach-safe operating guides and a coach-to-platform support thread share
   one utility surface. Support threads remain separate from lead conversations. A **floating
   support bubble** on every coach screen deep-links straight into the chat.

## ADMIN CONSOLE

1. **Overview.** Rollup KPIs (MRR, clients by tier, total booked, blended margin — admin only).
   Every SaaS figure on this page reads **our own subscription mirror**, kept current by BILL-03's
   payment webhooks and reconciled against Stripe on a schedule; Stripe is the source of truth for
   the mirror, never the source of the query, so a Stripe incident does not take the dashboard down
   (T12-13). **MRR is gross subscription revenue with affiliate commission on its own line, never
   netted.** **Blended margin is absent from the surface until the Phase 6 `usage_costs` rollup
   exists** — pending a cost rollup, which is a different kind of absent from demo data, and a
   fabricated margin is the clearest possible violation of the honest-states rule because it is a
   number an owner would act on (T12-6). The **SaaS KPI row** (round 2) splits by what launch can
   support: **new signups and active-subscription counts ship at launch; churn rate appears after
   one full billing cycle of history; LTV, average retention and growth trend are held back until
   there is enough history to mean anything** — churn over zero churned accounts renders 0% and
   reads as a claim, and LTV over a population that does not exist can only be produced by
   inventing an assumption (T12-12). An **At-risk /
   Needs-attention queue as the default focus**: payment overdue + dunning state, Meta
   token expiring, agent paused >48h, onboarding stalled at a named step. A client leaderboard:
   leads, booked, conv %, time-to-book, trend sparkline, tier, margin (admin-only economics). Row →
   client detail.
2. **Agent performance.** The former Clients roster defaults to an attention view (troubled clients float up), not alphabetical.
   Client detail: status (onboarding/active/paused/overdue/suspended/churned), tier + usage,
   assigned success owner, channel health, onboarding progress (which step a signup stalled at),
   offer snapshot, cost-vs-revenue margin, activity timeline. Actions: pause/resume the agent,
   view-as (impersonate, logged, and **read-only — enforced in the RLS policies, not by UI
   convention**, so an impersonated session cannot write anything, T15-7; owner, admin and success
   only, never `build`, T15-9; a session row per entry carrying actor, tenant, typed reason and
   expiry, thirty minutes, one tenant, re-entry needs a fresh reason, T15-8), edit offer on their
   behalf (a **distinct admin route acting as the admin** against the coach's tenant, which logs
   both parties — identical to the coach, completely different in the log), resend signup link,
   nudge stalled
   onboarding, suspend for non-payment, archive with reason, internal note.
3. **The Brain** (the moat). One knowledge system, one name. Section tabs (round 2):
   Qualification · Objections · Mission · Compliance · Knowledge. Structured editors, not
   walls of text: qualification is an **editable decision table** (credit range × business stage
   × funding goal → BOOK / SOFT DQ / HARD DQ; click an outcome to cycle) — no explainer cards
   above it. Objections are pattern→response pairs with tags, plus a **"new objections needed"
   queue** of unmatched lead phrases from production conversations that the admin drafts answers
   for. Mission is the scaffold editor (Identity / Goal / Tone / Criteria / Guardrails / DQ),
   merged in from the removed Agent-defaults page. Compliance renders as locked-style cards
   (platform law, not settings) and owns the hard-blocked language list plus TCPA-supporting
   behavior (opt-in gating, STOP handling, quiet hours by lead timezone). Per-coach voice
   settings live on the coach's Your-business tab; there is no admin voice tab or separate Evals route;
   hands-on testing, suites, and run history live in The Brain's Testing tab. Top: DRAFT/PUBLISHED
   lifecycle with version history + diff, and one action "Publish to all agents" ("publishing
   updates every agent instantly"). The publish button surfaces the latest eval status and
   soft-warns (not hard-blocks) if a safety suite is failing.
4. **Tiers & billing.** Editable tier cards (see ARCHITECTURE for the tier model), call allowances,
   fair-use cap on the top tier, per-client overrides. Stripe status, per-client usage table
   (booked calls + messages, cost vs revenue). As built in Phase 6 the dispute path is a **correction
   queue**: a coach requests a correction with a reason from their own billing page, an owner or admin
   decides it, and the decision writes an offsetting event plus an audit row — a coach never edits a
   count, and a success user sees the request evidence read-only. **Margin renders absent, not zero,
   until every cost rate exists** (messaging and embedding rates are still owed), and margin lives
   only here — never on a coach surface.
5. **Affiliates admin.** Open signup issues a referral link immediately. Admin can revoke a live
   link with a logged action while retaining historical commission rows. The ledger shows affiliate,
   referred coach, the twelve-month commission window, and accrued commission as append-only rows.
   Payout has exactly two states — **approved for payout**, then **recorded sent** with an external
   reference and date — and both are logged; there is no PAID/UNPAID flip and no mark-as-paid that
   rewrites history, because a reversal is an offsetting row rather than a status change on money
   already sent. Nothing on the screen says SetterFi transferred funds.
6. **Platform Clients.** SaaS client management by plan, status, and setup state. Each client detail
   owns that client's channel heartbeats, 7-day intensity, logged replay, and export.
7. **System.** A linked roll-up of client channel health, LLM error rate, delivery failures; one platform health
   number. Activity log (severity-bucketed, searchable by client/lead/code). **Conversation debug
   trace**: from any conversation, "view trace" → what the brain retrieved, which decision-table
   row fired, prompt/response, latency, token cost. Webhook retry queue with manual replay.
8. **Inbox.** One tabbed surface for coach support, the preserved global cross-tenant lead
   conversation view, and operational Needs attention. Admin takeover still works in lead threads;
   support threads use their own coach/platform model; the attention tab keeps compliance
   triggers, repeated agent failures, and STOP events.
9. **Settings and billing.** Four tabs (round 2): **Notifications** (platform notification
   preferences), **Alerts** (rules → destinations: in-app bell / email; prebuilt:
   booking made, payment failed, completed payment, channel disconnected, A2P cleared, agent
   inactive 72h, onboarding stalled, client upgraded), **Billing** (billing contact, payment
   details, exportable invoice history — separate from Tiers and billing, which owns product
   pricing and per-client metering), and **Privacy and DNC** (global contact search across
   tenants; platform + per-client DNC/STOP list, auto-maintained and exportable; delete-lead
   action for privacy requests with cascade preview — the former Leads & compliance page).
   **Deletion is immediate and permanent — there is no reversal window** (T4-17, resolving COMP-02
   against the shipped "reversible for 7 days" copy and the "Deletion scheduled · 7d" chip, both of
   which go). Shipped in Phase 3 (2026-08-17) as the dedicated live `/admin/compliance` page
   (owner/admin/success) plus the coach contact drawer's receipt-backed delete flow: preview →
   typed reason → execute, with "Deleted" rendered only from the read-back receipt. The cascade
   deletes the person and **keeps the tombstone**, and there are two stores, labelled on-screen:
   `suppression_tombstones` is the **authoritative deletion store** (one row per deleted
   identity, `source = 'deletion'`, holding a peppered SHA-256 of the identifier, the channel,
   the timestamp, and the last four digits for the admin list — no name, no transcript, no
   attributes) and `suppression_entries` remains the **live-suppression store** for
   contact-linked current blocks (STOP/opt-out) that the send gateway consults. The DNC list and
   the platform `suppression-tombstones` export read the tombstone store. Then hard-delete `contacts` → `contact_identities`, `conversations` → `messages`
   → `message_traces`, `followups`, and null `billable_events.appointment_id` so billing history
   survives a privacy request. The preview states plainly that **Meta orphans are real**: there is
   no API and no object under our control that removes a thread from a coach's Instagram inbox.
   Dropping the suppression to honour a deletion would guarantee a future violation against the
   same person, and 47 CFR 64.1200(d)(3)/(d)(6) requires honouring a do-not-call request for five
   years.

## AFFILIATE VIEW (smallest surface)

Referral link + copy, program status ("become a partner" card), a stats rail (referred / active /
earned), an attributed list showing ONLY name, status, commission earned — no performance data.
As built in Phase 6 that list is an exact three-column projection — business name, account status,
commission earned — enforced in the database, so there is no column an affiliate could reach even by
calling the API directly. Payout history shows their own approved-for-payout and recorded-sent rows
with reference and date, resolved from their session rather than from anything the client sends.
Payout history. Terms stated plainly: 10% recurring, up to 12 months per referred coach.

## CONSUMER EXPERIENCE (the lead-facing surface)

The public, white-label conversation a prospective customer actually sees. It uses the coach's
brand and offer rather than SetterFi workspace chrome, then carries one focused task from first
message through qualification and conversational booking. The lead can ask for a person at any
time, retry a failed turn, restart a closed conversation, and see an explicit appointment
confirmation when the booking rule resolves. Internal mechanics stay hidden: no Brain name,
tenant identifier, decision code, trace, seams inspector, model metadata, or admin terminology.

The demo keeps an external preview ribbon visible so simulated handoffs and calendar holds cannot
be mistaken for production writes, and it explicitly says real conversations run inside Instagram,
Messenger, or text messages rather than on the hosted preview. The conversation itself remains
faithful to the real consumer experience, including AI disclosure, privacy/support language,
keyboard focus, mobile-safe input, and reduced-motion behavior.

Three platform obligations that constrain this surface rather than decorate it:

- **The automated-experience disclosure is Meta policy, not a nicety.** It has to be a fixed,
  non-editable element of the agent's opening message and of any human→AI handback, which in turn
  means the brand-voice and offer-layer editors must not let a coach delete or reword it away. A
  coach chasing a more human-sounding opener is exactly the person who will try.
- **Meta expects a response within 30 seconds.** That is a hard constraint on the retrieval → LLM →
  send pipeline, not an aspiration — a slow model or a cold vector index is a policy problem, not
  just a UX one.
- **Nothing can reach a lead more than 24 hours after their last message on Instagram or
  Messenger.** Every follow-up, nurture, re-engagement, and appointment-reminder surface in this
  document has to be audited against that: past the window, the only live routes are SMS, an
  approved WhatsApp template, or a human. Instagram in particular has no automated escape at all —
  its only post-window mechanism is the `HUMAN_AGENT` tag, which is for humans and is additionally
  gated behind an App Review feature we have not requested. Any cadence UI that implies "we'll
  follow up in 3 days on Instagram" is describing something the platform will not deliver.

## SELF-SERVE ONBOARDING (the coach's first-run — a signature surface)

The differentiator. No human touch, no "book a call," no niche picker (the agent already knows the
industry). An "assembly line" metaphor: a fixed agent **core** arrives pre-installed with the
shared brain (qualification, objections, tone shown as docked modules), and each step docks a new
module. Steps: **Connect → Meet → Go live** (test before live). Progress shows "% assembled" with a
discrete module count AND a capability readout ("Qualifies leads ✓ · Books calls — needs your
calendar"). Connect provisions channels as **ready-but-not-live**; the agent goes live only after
the Meet step, via an explicit "Go live" confirmation. Calendar is a required booking destination.
Honest async: Facebook/Instagram live on connect, SMS shows amber "registering, ~3 weeks, flips on
automatically" (the real A2P sequence is brand → vetting → campaign → carrier vetting, and carrier
review alone runs 2–3 weeks — the "~1–2 weeks" this document used to say was optimistic). The flow
deposits into the persistent get-started checklist, not a dead-end.

The flow is also missing a step that A2P registration will not proceed without: **a per-coach
compliant opt-in artifact.** The requirements are specific enough to be a build spec rather than a
guideline — consent checkboxes that are separate for marketing and non-marketing, never pre-ticked,
and optional to submit even when the phone field itself is required; a terms page carrying an
explicit clause that data is not shared with third parties or affiliates; a privacy policy; and
sample messages that match both the consent language and what the agent actually sends. Onboarding
has to produce all of it before the campaign can be filed. GHL's chat-widget A2P compliance API is
the one piece of this we can automate.

Two more branches onboarding does not currently handle: **whether the coach has an EIN** (an
eligibility branch, not a preference — Sole Proprietor registration is only for those *without* one,
so any US LLC is ineligible, and the sole-proprietor path caps sending at ~1,000/day and burns a
personal-mobile verification that can only be used **three times globally, ever**), and a
**permanently-blocked terminal state** in the provisioning tracker for coaches whose campaign is
terminally rejected — credit repair, direct loan marketing, and debt reduction are non-resubmittable
rejection codes, and a coach whose own website promises credit fixes will be rejected on their copy.

## MEET YOUR AGENT (shared test surface — onboarding finale + portal + eval)

Split view: real chat left, live flow-trace canvas right (React Flow) — as the conversation runs,
the agent's actual stages light up (greeting → qualify → objection → book), the active edge
pulses, completed nodes check. Must read as **real, not scripted**: the user types anything; the
agent answers from the actual configured brain + offer layer. A **grounding receipt** per turn
(which decision-table rule fired, which brain passage was retrieved). Adversarial test chips
("try to break it", jailbreak + compliance attacks); when attacked, the agent visibly holds and a
**guardrail node** fires (amber deflect / red hard-block). A **seams inspector** toggle (model,
tenant isolation, grounded-vs-generated, latency, cost). Culminates in a test booking that is a
**real slot fetch against the connected calendar and a simulated write, labelled as simulated**
(T6-18, resolving this line against T11-7's no-real-calendar-write rule). The read is where the
value is — it proves the connection, the timezone and the slot duration are right — and the write
is the part with a consequence outside the database, which is exactly what T11-7 draws its line
around. A configuration banner computed from the compiler's placeholder resolution, not from form
completeness, states what is still missing ("Testing with 3 unresolved placeholders — [niche],
[target funding amount], [requirements]"), unresolved placeholders render **visibly marked in the
transcript** rather than silently substituted, and a turn falling back to a platform default is
labelled as using one. Then a "share your agent" replay. Framed honestly: "your real agent
on test data — try to break it before your leads can." Test data segregated. In the admin/eval
context it adds a draft-vs-published selector and "add this exchange as an eval case."

## BRAIN TESTING (permanent admin tab — not dev tooling)

Framed testing-first (round 2): try the agent by hand first, then let the suites prove it.
Three jobs: hands-on test bench, pre-publish safety gate on the brain, and regression proof
forever. Explicitly NOT live-traffic A/B testing (that's a separate paid module — never split
real leads). Footer: "Runs use test data only." Tabs:
- **Test bench** — "Try the agent": type what a lead would type, single run + compare (A|B
  columns, each with its own model/config), config source (draft/published/version),
  client-overlay picker, channel simulation. Grounding receipt + fired rule + retrieved passages
  per run.
- **Test suites** — named test-case libraries with pass-rate rings and trend history: Qualification
  accuracy (case → expected BOOK/SOFT-DQ/HARD-DQ), Compliance guardrails (CPNs / attorney / score
  guarantees → refuse/auto-pause), Jailbreak + injection (stay in role, exit after cap), Voice &
  tone, Pricing discipline. "Add case from playground" and "add from a production conversation."
- **Past runs** — history over time (config/version/model, pass rate, cost, who ran it); compare two
  runs.
Cross-links: brain publish shows last eval status; any production conversation can be added as an
eval case; model config shows "last benchmarked."

## OPEN PRODUCT DECISIONS (confirm before the relevant build week)

- Google Calendar connection model (via GHL vs our own Google app).
- Cash-campaign sample messages (needed verbatim for A2P campaign registration).
