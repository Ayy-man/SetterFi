# SetterFi — Architecture

How the pieces connect: the brain, the channels, self-serve provisioning, billing, and the
security model. This is the backend contract behind the surfaces in PRODUCT.md.

## Multi-tenancy

One platform, many coach sub-accounts (tenants). Every row is tenant-scoped. Supabase with
FORCE row-level security and a `tenant_id` on everything; `service_role` bypasses RLS, so webhook
handlers must re-impose tenant scoping in code, never trust the key alone. Tenant isolation is a
first-class requirement (the client's technical lead will probe it) — no cross-tenant data path,
ever, and it doubles as the client's "no backdoor" guarantee.

## The Brain (the moat)

One central knowledge base the admin edits; every coach's agent inherits it instantly. Two layers:

- **Shared brain (admin-owned, universal):** qualification logic, objection responses, voice &
  tone, compliance rules, credit/funding fundamentals, funding products. Seeded from the client's
  Notion workspace **"Legacy Strong"** — specifically the `Prospect FAQ Sheet / FAQs` database,
  46 rows of `Category` / `Inbound Message` / `Response`, which is the only SetterFi-relevant
  knowledge in there (the rest of the workspace is the separate funding platform's). Rows land in
  Supabase as structured entries with embeddings over the inbound-message column, not as prose
  chunks — see `docs/NOTION-MAP.md` and `docs/BRAIN-COMPILER.md`. The workspace holds no
  qualification matrix; confirm those values with Alec directly.
  *(Retracted: this previously named an "Appointwise Setup - CCA Clients" workspace with
  A-docs/B-docs layers. No such workspace exists — verified by full extraction 2026-08-13/14.)*
- **Per-client offer layer (coach-owned, bounded):** their pricing, products offered,
  disqualifiers, brand voice, FAQ, proof/case studies. The coach can shape their offer but cannot
  break the engine.

Retrieval-grounded generation: the agent answers from retrieved brain passages, not free
generation. Pricing/guarantees/outcomes are hard-gated in the system layer — the agent physically
cannot quote a number the config doesn't allow. The brain has a draft/publish lifecycle with
versioning + diff; "publish" propagates to all agents; the Evals test bench queries it like the
agent would (the standalone test-retrieval drawer was removed in round 2); evals gate publish
(soft warning).

### Qualification (the decision matrix — build the engine to be data-driven, not hardcoded)

Outcome is a function of credit range × business stage × funding goal → BOOK / SOFT DQ / HARD DQ.
Representative rows (the admin edits these in the Brain table; do not hardcode the values):
700+ any/any → BOOK · 640–680 with revenue, $50K+ → BOOK · 600–640 startup → SOFT DQ · below 600 →
HARD DQ. Soft DQ = nurture, re-scored on new info. Hard DQ = polite exit, no follow-up. Enum
buckets (reused as pills/fields everywhere): credit range {below 600, 600–640, 640–680, 680–700,
700+, unknown} · funding goal {<$50K, $50K–100K, $100K–150K, $150K+} · timeline {ASAP–30d, 1–3mo,
3–6mo, exploring}. A commitment check gates borderline bands before booking.

## Channels

The agent is channel-agnostic: inbound message → engine → grounded reply → outbound, routed by
tenant. Two connection paths per coach, their choice; design the channel layer as swappable
adapters behind one internal interface.

- **Facebook + Instagram DMs — our own Meta app is primary.** The app is created under the
  client's Meta developer account / business portfolio; each coach connects their own page via
  OAuth on our platform. Inbound arrives via Meta webhooks; outbound via the Graph API. **GHL's
  native Meta integration is the interim fallback** if Meta app review runs long — so
  the FB/IG path must be implementable both ways behind the same adapter.

  **This path is gated by the same Meta processes as WhatsApp, not just WhatsApp.** Letting any
  third party — i.e. a coach who is not us — connect their own IG or Page requires Advanced Access,
  which requires App Review. The permissions are `instagram_basic` + `instagram_manage_messages`
  (or `instagram_business_basic` + `instagram_business_manage_messages` on the Instagram Login
  path), plus `pages_messaging`, `pages_manage_metadata`, `pages_show_list`,
  `pages_read_engagement`, and `business_management`.

  **There are two live Instagram API generations and they are not interchangeable.** The Facebook
  Login path runs on `graph.facebook.com` with a Page token, requires the coach's Instagram account
  to be linked to a Facebook Page, and additionally requires the coach to flip a "Connected Tools →
  Allow Access to Messages" toggle inside the Instagram app on their phone — a manual step on a
  device we cannot reach. The Instagram Login path runs on `graph.instagram.com` with an Instagram
  user token and needs no Facebook Page at all. **Instagram-first coaches can only be served the
  second way**, so the adapter has to support both generations rather than picking one.
- **WhatsApp — direct via the client's own Meta app** (Tech Provider path), decided on the
  2026-07-28 call. The WABA "SetterFi support" and number are live on the client's business
  portfolio (see `docs/SETUP.md`, Meta chapter). **GHL's
  WhatsApp channel remains the documented fallback** and sits behind the same adapter.

  **Coach self-serve WhatsApp (Embedded Signup) is gated on a chain, not a single review.**
  Business Verification (client-side, no published duration, and it gates everything downstream) →
  Access Verification (~5 days, the Tech Provider determination — this process appears in no other
  document we have) → App Review for Advanced Access on `whatsapp_business_management` and
  `whatsapp_business_messaging`. Even once all three clear, onboarding is **rate-capped at 10 new
  customers per rolling 7 days** until the cap is lifted.

- **Meta has four approval processes, and treating them as one is how the schedule slips.**
  Business Verification (gates everything, client-side, duration unpublished), Access Verification
  (client-side, duration not guaranteed), App Review (assessed **per permission**; Meta publishes
  typical turnarounds but none are guaranteed — never promise a review date), and the Data
  Protection Assessment (annual, 60-day response window, with loss of platform access as the
  penalty for missing it). **App Review is an exit gate, not an entry form:** Meta requires at least one
  successful live API call per requested permission and a screen recording per permission before a
  submission is accepted — screenshots are explicitly refused. So the integration must be built and
  working *before* it can be filed, which inverts any plan that files on day one.
- **SMS — GHL-provisioned numbers per sub-account**, with **per-client A2P 10DLC registration**.
  A2P is not one wait but a sequence: brand registration (fast, often same-day) → brand vetting →
  campaign submission → **campaign vetting by the carriers, which is the long pole at roughly two
  to three weeks** and is a gate nobody controls. Until the campaign is approved the number exists
  but outbound SMS is blocked. Registration carries per-brand and per-campaign fees and a
  **three-month minimum commitment** that is not refundable — see the billing section.

  **Status is not readable, and a failure is not self-explaining.** GoHighLevel's published API
  exposes no A2P brand or campaign state and emits no A2P webhook (verified across all published
  specs, operations and webhook events), and a failed send comes back as a bare status word —
  `failed` or `undelivered` — with no error code and no reason. So "campaign not approved" is
  indistinguishable from a landline, a disconnected number, or a carrier drop. Two consequences:

  - **Readiness is detected by a probe send to a phone number we own and have verified**, never
    against live lead traffic. Controlling the destination is what makes the failure attributable.
    On success, auto-flip the coach's SMS to live.
  - **Never infer readiness from `capabilities.sms` on the GHL number object** — that flag is true
    from the moment the number is provisioned, long before any campaign is approved.

  Surface this honestly as an amber "registering" state with the real expectation stated on
  screen. **Flag for human review at ~21 days**, not 10 — ten days sits inside the normal window
  and would page a human on healthy registrations. Terminal rejection is a *separate* event with a
  different resolution and needs its own immediate path, not the same timer.

- **SMS content eligibility — some coaches will never get SMS, and the product must say so.**
  Carrier policy permanently refuses A2P campaigns for credit repair, direct loan marketing, and
  debt reduction, and those rejections are documented as **not eligible for resubmission** — a
  rejected campaign is finished, not fixable. Toll-free verification is closed on the same grounds,
  so there is no fallback route. Coaching and education are not in the prohibited list, so a
  defensible registration exists for a coaching business booking consultations — but the reviewer
  reads the coach's own website and sample messages, and this industry routinely advertises the
  exact vocabulary that triggers the refusal, over copy we do not control. The provisioning tracker
  therefore needs a **permanently-blocked terminal state distinct from pending amber**, because one
  is a wait and the other is a different conversation with the coach. Meta DM channels are governed
  by entirely separate rules and are unaffected, which is the argument for keeping SMS strictly
  secondary in how the product is described.

  *Not a way around this:* letting a coach bring their own Twilio account does not help. The
  refusal is a carrier content decision, not a provider decision, so the same words get the same
  answer whichever account submits them. Bring-your-own-Twilio and be-our-own-delivery-provider
  were both evaluated and declined for that reason.

- **Consent obligations that fall on us, not only on the coach.** Twilio's messaging policy requires
  a platform to *"require"* its customers to obtain prior express written consent — an affirmative
  duty our product has to impose, not merely permit — and to **retain proof of consent** and be able
  to produce it. Today we inherit leads from GHL and Meta with no consent record of our own, so
  per-lead consent artifact plus timestamp and source is a build item, not a policy footnote.
  Related obligations from the same source: **every message must identify the sender** (the coach's
  business, which argues against any generic or SetterFi-branded sender string), consent may not be
  transferred between parties (so any future cross-coach lead routing would violate it), and we are
  responsible for surfacing the acceptable-use policy to coaches and for having a path to report a
  violating coach. Campaign registration additionally requires a **valid privacy policy and terms
  URL per coach** — omitting them is a documented rejection cause — which nothing in the plan
  currently produces.
- **CRM / pipelines / contacts — GoHighLevel** is the backend backbone. The client's GHL is an
  agency with **SaaS mode + Agency Pro** enabled; each coach becomes a **sub-account minted from a
  GHL snapshot** at signup, which is what makes provisioning zero-touch. Pipelines ship inside the
  snapshot and are effectively read-only via API — the pre-seeded stages come from the snapshot,
  not runtime writes. Contacts, conversations, and numbers all live in the sub-account. GHL is
  invisible to the coach and to leads — no GHL branding, ever.

  **Sub-account creation is plan-gated.** `POST /locations/` requires the agency to be on Agency
  Pro; on a lower tier the call fails and zero-touch provisioning does not work at all. The tier is
  machine-readable at install time from the marketplace installations endpoint (`companyPlan`, e.g.
  `agency_monthly_497`), so this should be asserted programmatically rather than assumed — but note
  the field is null for sub-account-level installs.

  **A second connection model exists and was evaluated: a coach connecting their own existing GHL
  account** via the standard authorization-code flow, selecting which of their locations to share.
  It is *less* build than minting sub-accounts — no snapshot push, no user creation, and the Agency
  Pro dependency disappears — but it inverts ownership: the coach brings their own pipelines,
  calendars, numbers, and possibly an existing voice bot on inbound, so the offer layer changes from
  "config we seed" to "config we discover and map." Not adopted; recorded because it is the cheaper
  path if zero-touch provisioning ever proves too brittle.

  **What nobody knew when that trade was written: the marketplace caps a Private app at five
  agencies, and the BYO model spends that budget one coach at a time.**
  [Private App Install Limits](https://marketplace.gohighlevel.com/docs/MarketplacePolicies/PrivateAppInstallLimits/index.html)
  (verified 2026-08-19, and stated again in the portal's own warning on app 1) blocks new installs
  once an app is active in **more than 5 external agencies**, until it is published or passes
  Security Review; an exception exists on written rationale, and lifts the cap while the app stays
  Private. The cap counts agencies, not sub-accounts, which is why the adopted model never meets it:
  the client's agency is the only agency that ever installs SetterFi and every coach is a
  sub-account inside it, so we sit at 1 of 5 no matter how many coaches sign up. Under BYO the same
  sentence inverts — each coach connects their own agency, so the sixth coach is refused at the
  door, and the ways out are publishing (which puts a white-label product on a provider-branded
  storefront, so it is not available to us) or a standing policy exemption that is HighLevel's to
  grant and not ours. The fallback is therefore "less build" only up to five coaches. That does not
  disqualify it, but the trade is no longer just inverted config ownership, and it should not be
  reached for in a hurry on the assumption that it is.
- **The 24-hour window, and the fact that there is no way out of it on IG or Messenger.** Every
  Meta channel allows free-form replies only within 24 hours of the lead's last message. What
  differs is the escape hatch: **WhatsApp has approved templates; Instagram and Messenger have
  none.** Instagram's only documented post-window mechanism is the `HUMAN_AGENT` tag, which is
  human-only by Meta policy and itself App-Review-gated — so an automated sender has no post-window
  path at all. Sponsored Messages and One-Time Notifications are not available on Instagram, and
  three message tags were removed on 2026-04-27, including `CONFIRMED_EVENT_UPDATE`.

  **Consequence for the whole product, not just the channel layer:** any follow-up, nurture,
  re-engagement, or appointment reminder that reaches a lead more than 24 hours after their last
  message **cannot run on Instagram or Messenger**. It is SMS-only, WhatsApp-template-only, or
  gated behind a human. Every cadence surface has to be audited against that, and the adapter
  interface must expose post-window capability per provider (`template` / `human_agent_only` /
  `none`) rather than assuming one rule.

  **Follow-up copy is written by the coach and approved by the platform before it can send
  (2026-09-05).** A coach writes the exact words per connected channel and purpose on the Agent
  page and submits them; an owner or admin approves or rejects each one from the admin Inbox with
  a reason, and every step is audited. A due touch with no approved copy is a blocked touch that
  stays scheduled until copy exists, never a failed run and never a cancelled lead. The only
  exception is a demo tenant, which may send a demo-flagged draft labelled as such.


- **Two Meta obligations with visible product consequences.** The agent must disclose that it is
  an automated experience — a fixed, non-editable element of its opening message and of any
  human→AI handback, which the brand-voice and offer-layer editors must not let a coach remove.
  And Meta expects a response within **30 seconds**, which is a hard constraint on the retrieval →
  LLM → send pipeline, not an aspiration. On WhatsApp, multi-bubble replies need ~6 seconds of
  spacing per pair. Log `X-Business-Use-Case-Usage` on every Graph call so rate-limit headroom is
  observable rather than inferred.

- **Calendar / booking — GHL calendar default, plus our own Google app or Google-via-GHL.**
  **Two modes, both supported** (T9-3 — this sentence used to say the agent "never drops a raw
  booking link", and "raw" was carrying the whole clause in a way nobody read). What the rule
  protects against is a bare URL on its own line that throws away the qualification and moves the
  lead to a surface we cannot see, not the existence of a URL at all.
  **`direct` (the default): propose two or three real slots, write the appointment in-thread, send
  no link.** **`link`: qualify fully, ask for the commitment, then send the derived `booking_url`
  inside a sentence naming the lead's situation** — never a bare URL, never a URL as the whole
  message, never before qualification completes. In both modes the link is
  `calendar_connections.booking_url`, provider-derived and never coach-typed.
  Default is "A mix" (some coaches on GHL calendar,
  some on Google). **The Google connection model is decided as of 2026-09-02: our own Google app,
  not Google-via-GHL.** The flow lives at `/api/calendars/google/connect`, `/callback`, `/select`
  and `/disconnect`, behind `SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE`, which is unset by default and
  keeps all four routes at 404. A coach presses one button and types nothing; the grant is stored
  as encrypted credential envelopes in `google_calendar_grants`, and a `calendar_connections` row
  is written only once a calendar is picked, reaching `ready` only after a free/busy read came back
  clean for that calendar. Google's app is still in Testing publishing status, so only listed test
  users can complete consent and every authorization expires seven days after it is given
  (`https://support.google.com/cloud/answer/15549945`, read 2026-09-02) — the verification chain
  that lifts this is in `docs/CONTEXT.md` and `docs/SETUP.md`.

## Self-serve onboarding / provisioning (zero-touch)

Signup link → create GHL sub-account from the snapshot → provision a phone number → file A2P →
coach connects Meta page(s) via OAuth → coach connects/sets a calendar → test the agent → explicit
go-live. No SetterFi involvement per signup — **except on a flagged SMS content-eligibility
screen** (T6-10). A deterministic keyword scan, not a model call, reads the coach's website and
their offer-layer free text against the carrier refusal vocabulary before the campaign is filed. A
clean screen files automatically and the zero-touch path is exactly as described above. A hit puts
the step at `awaiting_coach` with the matched phrases quoted and the page named; the coach may fix
the page and re-run, or acknowledge and proceed, and proceeding queues **one admin confirmation
before filing**, recorded as `onboarding.a2p_filing_confirmed` with the actor. That is a deliberate
carve-out from ONB-01's "no human clicks", and the trade is one admin click against burning a
coach's single non-refilable shot at SMS — credit-repair, loan-marketing and debt-reduction
rejections are permanent and not resubmittable. Build a **provisioning tracker** (admin) with a
per-signup stepper and retry actions, because a zero-touch flow needs an ops view of where a signup
breaks. Sequencing to respect: Meta can be live immediately; SMS follows when A2P clears — never
promise instant texting.

Three things the flow above does not yet account for, all load-bearing:

- **A2P registration branches on whether the coach has an EIN**, and it is an eligibility branch
  rather than a preference. Sole Proprietor registration is restricted to those *without* an EIN —
  any US LLC has one and is therefore ineligible for it. The two paths differ sharply downstream:
  Sole Proprietor allows one campaign and one number and caps sending at roughly 1,000 messages a
  day, and it verifies by a one-time code to the coach's personal mobile, **which can only be used
  three times across all A2P registrations anywhere, ever** — so a shared or support number leaking
  into that field burns a global allowance. Onboarding must ask about the EIN and route on the
  answer, then show sole proprietors their real sending cap.
- **Onboarding has no step that produces a compliant opt-in artifact**, and campaign registration
  will not proceed without one. The requirements are specific: consent checkboxes separate for
  marketing and non-marketing, never pre-ticked, optional to submit even when the phone field is
  required, a terms page carrying an explicit no-sharing-with-third-parties-or-affiliates clause,
  and campaign description language that matches the consent language.
- **The tracker needs a permanently-blocked terminal state**, distinct from amber, for coaches whose
  campaign is terminally rejected. See the SMS content-eligibility note in Channels.

**Built as of 2026-08-18 (Phase 5), and where the approved wording still has to go.** All three
gaps above are closed in code: the EIN branch routes at the checklist, the opt-in artifact is
rendered and version-hashed from template input and confirmed before filing, and the tracker carries
`blocked_permanent` as a terminal state with no retry affordance and no timer. The artifact renders
separate marketing and non-marketing checkbox descriptors, never pre-ticked and optional to submit,
plus terms and privacy pages served from the persisted confirmed version at
`/opt-in/[tenantSlug]/terms` and `/privacy`, and the campaign description is generated from the same
template data so consent language and campaign language cannot drift apart. What is NOT built, and
deliberately so, is the wording itself: every body is a `SETTERFI_DEMO_PLACEHOLDER_*` value carrying
a visible unapproved label, and the real filing path rejects any placeholder outright. Alec and
counsel owe the approved consent, terms, privacy and campaign-description copy plus the cash-campaign
sample messages; when it arrives it is entered as approved template data, not written here and not
invented by the build. Until then a coach can walk the whole lane and see exactly where their own
approved language will sit, and no campaign can be filed with placeholder text.

## Billing (Stripe)

- **Coach subscriptions with outcome-based tiers**, metered by booked-call volume: $297/mo up to
  25 booked calls, $597/mo up to 75, $997/mo beyond. Admin can edit tier prices, call allowances,
  and a fair-use cap on the top tier without a change order; per-client overrides supported. Meter
  events must round-trip and be adjustable with an audited reason (disputes are guaranteed by
  outcome billing).
- **Affiliate commissions:** 10% recurring for up to 12 months per referred coach. **The base is
  the amount actually collected on the subscription — net of any discount, excluding tax** — so a
  coupon or a tax line does not silently change what an affiliate is owed. Calculation is
  automatic; **payouts are manual from the ledger in v1** (Stripe Connect auto-payout is a later
  phase). **Clawback stops future accrual and reverses commission not yet paid out; it never
  reclaims money already sent** (T14-4), and it is recorded as offsetting ledger rows rather than
  as a status flip, because flipping a paid row's status destroys the record that it was paid.
  **Cancellation and refund are separate events**: cancelling a subscription that was already paid
  for is not the same as taking the money back, and conflating them is what made the original
  "clawback flag when a referred coach cancels" ambiguous.
- Per-client messaging usage is metered too (cost vs revenue), admin-only.

**Built as of 2026-08-18 (Phase 6), and the two words above that now mean something narrower.**
"Metered" no longer means Stripe usage reporting: the tiers are fixed recurring Prices and SetterFi
counts booked calls locally against the allowance, so crossing it raises a notice and an owner or
admin decision rather than an automatic charge, and a coach can dispute a count from their own
billing page with a reason that an owner or admin decides on the record. Commission accrues per
invoice at 10% of collected revenue excluding tax and net of discounts, for twelve months from the
referred coach's first positive invoice; every reversal — clawback, refund, dispute — is an
offsetting ledger row, never a status flip on a row that was already paid. Payout has exactly two
recorded states, **approved for payout** and **recorded sent** with an external reference and date,
and no surface claims SetterFi moved the money. A first failed payment marks the tenant overdue and
alerts; **suspension is only ever a human owner/admin action carrying a reason**. Margin is admin-only
and renders **absent, not zero**, while any cost rate is missing — messaging and embedding rates are
still owed, so production margin is genuinely incomplete and says so. All three Phase 6 flags stay
off until Stripe keys, an approved Price allowlist and approved billing copy arrive; real dispatch of
an unapproved notice fails closed as `BILLING_COPY_UNAPPROVED`.
- **A2P is a real per-coach cost line and nothing in the model currently carries it.** GHL passes
  TCR's fees through without markup: roughly **$24.50 one-time** (brand registration + campaign
  vetting + fast-track) on both the Sole Proprietor and Low Volume Standard paths, **$71.91** on
  High Volume Standard, then **$10/month per campaign** on standard use cases ($2 Sole Proprietor,
  $1.50 Low Volume Mixed), plus carrier per-segment surcharges of $0.001–$0.005 outbound. Additional
  campaigns under the same brand are $15 each. Rates are GHL's, current as of 2025-08-01, US only.
- **Every campaign carries an irreversible three-month minimum**, so a coach who churns in month one
  still costs us three months of campaign fees, and deactivation cannot be undone — a coach who
  leaves and comes back is a fresh registration, a fresh fee, and a fresh clock. Price the tiers and
  write the cancellation terms knowing that, and do not let the provisioning tracker offer a
  "deactivate campaign" action without a hard confirmation.
- **Default throughput is low, and lifting it costs money and does not apply retroactively.** A new
  brand starts in the Low tier: **2,000 T-Mobile segments/day** shared across every campaign under
  that EIN, and AT&T Class E/F at **240 SMS/minute** per campaign. Sole Proprietor is worse — 1,000
  a day and 15/minute. Secondary (Standard) vetting at **$41.50** is what moves a brand up, and a
  campaign registered before the vet completes has to be resubmitted to inherit the new score. This
  is the ceiling on how fast a coach's follow-up cadence can actually go out; the cadence engine has
  to be aware of it rather than assume unlimited send.
- **WhatsApp is billed per message on delivery, not per conversation** — Meta changed this on
  **2025-07-01**, so any margin model built on 24-hour conversation windows computes the wrong
  number. Marketing templates always cost. Utility and authentication templates are free inside an
  open customer service window and charged outside it. Service messages have been free for all
  businesses since **2024-11-01**, and click-to-WhatsApp arrivals get a 72-hour free entry-point
  window where everything sends free.

## Operations (things that exist and nothing currently owns)

- **Alert on GHL webhook success rate before the circuit breaker fires.** GHL disables an app's
  webhook delivery when success drops below 90% over three days, and re-enabling is a manual step in
  the marketplace console. That means the failure mode is silent — messages simply stop arriving —
  unless we watch our own delivery rate and page ourselves well before day three. Write down the
  re-enable procedure next to the alert; whoever gets paged will not be the person who read this.
- **GHL webhook signature keys rotate, and we find out by email.** The public key lives in an env
  var and GHL announces rotations by email and in their developer Slack, so there is no automatic
  pickup — the procedure is: receive notice, add the new key, verify against both during the overlap,
  drop the old one. Verification must accept either key while both are configured, or a rotation
  becomes an outage.
- **A single agency toggle can uninstall SetterFi everywhere.** The agency-level *"allow sub-accounts
  to view and install apps built by 3rd party developers"* setting, flipped off, removes the app
  across every sub-account at once. It is one click by someone on the client's team who may not know
  what it does. Detect the resulting mass-uninstall as an incident rather than as churn, and tell
  Alec the setting exists.

## Security model (design and answer to the technical stakeholder's bar)

- **Grounding / anti-hallucination:** retrieval-grounded answers; hard-gated pricing/guarantees;
  compliance language enforced in the system layer, not left to the model.
- **Two layers on every outbound draft, and the evidence stays on the trace (2026-09-05).** The
  first layer is deterministic: six code-owned check classes (numbers, claims, echo, links, scope,
  length) that tenant text can neither add to nor weaken, with a soft length breach truncated at
  a sentence boundary and a hard breach held. The second is a verdict-only moderator model that
  sees the draft, the lead message and the allowlists but never the Brain, answers a closed
  schema it cannot smuggle replacement copy through, does not judge links or length because the
  first layer already did, and fails closed: a refused, timed-out or malformed verdict holds the
  turn, and a provider-level refusal is a scope block. Every generation prompt opens with
  code-owned platform invariants, so a thin snapshot still runs behind the untrusted-input and
  disclosure rules. The moderator's class, rule id, model configuration and reason are persisted
  on `message_traces` beside its state, which is what lets the coach Inbox say why a reply was
  held without exposing prompts, allowlists or model configuration. The contracts are in
  `docs/BACKEND-SPEC.md` §3.
- **Jailbreak / injection resistance:** input screening, bounded per-stage prompt structure (the
  agent can't be argued off its current step), off-topic deflection with an exit cap, banned-topic
  tripwires that auto-pause the agent and file a human handoff. The coach's free-text offer inputs
  flow into the system prompt — treat them as an injection surface and sanitize/bound them.
- **Scope-lock:** the agent must refuse to be used as a general assistant (a lead trying to use it
  as free ChatGPT gets redirected, then silence). Distinct from the compliance block.
- **Tenant isolation:** enforced in every query; verifiable at runtime.
- **The affiliate is a capability, not a role value.** Affiliate portal access is gated on an
  `affiliates` row existing for the account, never on `role = 'affiliate'` (T15-13). `users.role`
  is single-valued and `users.email` is unique, so gating on the role forces a coach who refers
  other coaches into a second account under a second email while `affiliates.user_id` would
  happily attach to their existing row — the schema permits the relationship and the role model
  cannot express it. The role value survives for accounts that are *only* affiliates, since they
  need a role and have no tenant; a coach with an `affiliates` row sees both surfaces from one
  login. Scope is unchanged either way: an affiliate sees referred-coach name, status and
  commission earned, never their performance data.
- **Consumer response boundary:** the public conversation endpoint maps the internal agent turn to
  `reply`, consumer-safe state, and optional booking only. Decision rows, retrieved passages,
  model details, tenant identifiers, token counts, and other operator diagnostics never cross the
  lead-facing response boundary.
- **Suppression is enforced at the provider, not just locally (Phase 3):** every STOP/opt-out
  and every deletion writes the local row and then pushes to the provider's suppression list;
  the state is `provider_unconfirmed` until the provider read-back confirms it, and the UI says
  which. Deletions leave a hashed tombstone in `suppression_tombstones` that the send gateway
  checks before any dispatch, so a deleted person can never be re-contacted through a re-import.
- **Compliance guardrails** (support the client's program; the client owns legal compliance):
  opt-in gating for campaign-initiated outreach, automatic STOP/opt-out handling, quiet hours by
  lead timezone — shipped as enforced v1 behavior.
- **One environment:** work ships to `main` and deploys to the single `setter-fi` Vercel project.
  New backend behaviour lands behind env flags so nothing changes for the client until it is
  switched on; demos run on a seeded test tenant whose rows are excluded from analytics.
- **Observability:** a conversation debug trace (retrieval + fired rule + prompt/response + latency
  + cost) available from any conversation, and the evals harness as a standing instrument.

## LLM

Premium model via OpenRouter, model-configurable so models can be swapped and compared. The evals
playground compares models/prompts/configs against test scenarios with cost and latency visible.
Budget alerting on LLM spend (admin). Replies stream to the UI.

**Evals, as built (2026-09-05 and 2026-09-06).** Two reviewed corpora under `evals/corpus/`: 48
engine cases (real conversations, refusals, injections, extraction attempts, number and claim
traps, suppression) and 44 labelled moderator cases. An engine case is scored by outcome rather
than by whether the checker tripped, because a clean on-role refusal and an undetected failure
used to score identically: the checker catches it, or the model refused on role, or the checker
missed what the moderator then blocked, or nobody could judge it, or a clean reply passed, or a
clean reply was falsely blocked. The judge is the active moderator row through the same payload
production sends, so the bench measures the shipped pair on the published prompt with the platform
invariants in front of it. The nightly `engine-evals` job runs every comparison case with that
judge and reports the outcome counters on its receipt, saying whether it ran judged or unjudged.
Two live runners, `scripts/eval-engine.ts` and `scripts/eval-moderator.ts`, run the same cases by
hand without writing to the database; the commands are in `docs/operations/README.md`.
